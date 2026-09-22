import fs from "node:fs";
import path from "node:path";

// pi-web 启动时接受的配置项，与环境变量一一对应。
export type PiWebConfig = {
  port: string;
  hostname: string;
  allowedHosts: string;
  password: string;
  // 下面两项留空时按 PATH 自动探测，填写后优先使用，便于重置时一并清空。
  commandPath: string;
  nodePath: string;
};

// 提示词增强使用的模型。供应商与模型来自 pi 的 models.json。
export type EnhanceConfig = {
  // 留空表示未选择，此时增强功能不可用。
  provider: string;
  model: string;
};

// 窗口位置与尺寸记忆，退出时保存，下次启动还原。
export type WindowBounds = {
  x: number | undefined;
  y: number | undefined;
  width: number;
  height: number;
  maximized: boolean;
};

export type BoxSettings = {
  // 关闭主窗口后是否留在托盘。
  minimizeToTrayOnClose: boolean;
  // 是否在通知区域显示托盘图标。
  showTrayIcon: boolean;
  // 等待用户回答的弹窗是否提醒：闪任务栏/托盘并发系统通知。
  notifyOnPrompt: boolean;
  piWeb: PiWebConfig;
  enhance: EnhanceConfig;
  window: WindowBounds;
};

export const DEFAULT_SETTINGS: BoxSettings = {
  minimizeToTrayOnClose: true,
  showTrayIcon: true,
  notifyOnPrompt: true,
  piWeb: {
    port: "30141",
    hostname: "127.0.0.1",
    allowedHosts: "",
    password: "",
    commandPath: "",
    nodePath: "",
  },
  enhance: {
    provider: "",
    model: "",
  },
  window: {
    x: undefined,
    y: undefined,
    width: 1440,
    height: 920,
    maximized: false,
  },
};

export type SettingsValidation = { ok: true } | { ok: false; message: string };

/** 端口必须是 1 到 65535 之间的整数，留空表示使用默认值。 */
export function validatePort(value: string): SettingsValidation {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: "端口必须是 0 到 65535 之间的整数。" };
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: "端口必须是 1 到 65535 之间的整数。" };
  }
  return { ok: true };
}

/**
 * 校验主机名。允许留空、回环地址、通配地址和常规域名或 IPv4，
 * 其余情况交给 pi-web 自行判断，这里只拦截明显写错的空格和协议前缀。
 */
export function validateHostname(value: string): SettingsValidation {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (/\s/.test(trimmed)) return { ok: false, message: "监听主机名不能包含空格。" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { ok: false, message: "监听主机名只填写主机，不要带 http:// 或 https:// 前缀。" };
  }
  return { ok: true };
}

/** 允许的主机名列表用英文逗号分隔，逐项做基本校验。 */
export function validateAllowedHosts(value: string): SettingsValidation {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  const items = trimmed.split(",").map((item) => item.trim());
  if (items.some((item) => !item)) {
    return { ok: false, message: "允许的主机名列表中存在空项，请检查逗号是否多余。" };
  }
  if (items.some((item) => /\s/.test(item))) {
    return { ok: false, message: "允许的主机名不能包含空格。" };
  }
  return { ok: true };
}

// 手动指定的可执行文件必须是绝对路径，否则子进程会因找不到文件而启动失败。
function validateExecutablePath(value: string, label: string): SettingsValidation {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (!/^[a-z]:[\\/]|^\\\\/i.test(trimmed)) {
    return { ok: false, message: `${label}必须填写完整路径，例如 C:\\Users\\名字\\AppData\\Local\\npm-global\\pi-web.cmd。` };
  }
  return { ok: true };
}

/** 监听非回环地址意味着 Pi Web 会暴露到局域网，这里给出明确提示而不是拦截。 */
export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return !value || value === "127.0.0.1" || value === "localhost" || value === "::1";
}

export function validateSettings(settings: BoxSettings): SettingsValidation {
  const checks = [
    validatePort(settings.piWeb.port),
    validateHostname(settings.piWeb.hostname),
    validateAllowedHosts(settings.piWeb.allowedHosts),
    validateExecutablePath(settings.piWeb.commandPath, "pi-web 命令路径"),
    validateExecutablePath(settings.piWeb.nodePath, "Node.js 路径"),
  ];
  for (const check of checks) {
    if (!check.ok) return check;
  }
  // 开放到局域网却没有密码时提示，避免误暴露。
  if (!isLoopbackHostname(settings.piWeb.hostname) && !settings.piWeb.password) {
    return { ok: false, message: "监听地址已开放到局域网，请同时设置访问密码。" };
  }
  return { ok: true };
}

/**
 * 把外部读入的数据归一化成完整设置：缺失字段回落到默认值，
 * 类型不符的字段同样回落到默认值，避免手改配置文件后启动崩溃。
 */
export function normalizeSettings(raw: unknown): BoxSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<BoxSettings>;
  const piWeb = (source.piWeb && typeof source.piWeb === "object" ? source.piWeb : {}) as Partial<PiWebConfig>;
  const enhance = (source.enhance && typeof source.enhance === "object" ? source.enhance : {}) as Partial<EnhanceConfig>;
  const windowBounds = (source.window && typeof source.window === "object" ? source.window : {}) as Partial<WindowBounds>;
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  // 坐标允许为空（表示交给系统摆放），但必须是有限数字。
  const coordinate = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
  const size = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number.NaN;
    // 过小的尺寸会让窗口无法操作，这里做个下限保护。
    return Number.isFinite(parsed) && parsed >= 640 ? Math.round(parsed) : fallback;
  };
  return {
    minimizeToTrayOnClose:
      typeof source.minimizeToTrayOnClose === "boolean"
        ? source.minimizeToTrayOnClose
        : DEFAULT_SETTINGS.minimizeToTrayOnClose,
    showTrayIcon:
      typeof source.showTrayIcon === "boolean" ? source.showTrayIcon : DEFAULT_SETTINGS.showTrayIcon,
    notifyOnPrompt:
      typeof source.notifyOnPrompt === "boolean" ? source.notifyOnPrompt : DEFAULT_SETTINGS.notifyOnPrompt,
    piWeb: {
      port: text(piWeb.port, DEFAULT_SETTINGS.piWeb.port),
      hostname: text(piWeb.hostname, DEFAULT_SETTINGS.piWeb.hostname),
      allowedHosts: text(piWeb.allowedHosts, DEFAULT_SETTINGS.piWeb.allowedHosts),
      password: text(piWeb.password, DEFAULT_SETTINGS.piWeb.password),
      commandPath: text(piWeb.commandPath, DEFAULT_SETTINGS.piWeb.commandPath),
      nodePath: text(piWeb.nodePath, DEFAULT_SETTINGS.piWeb.nodePath),
    },
    enhance: {
      provider: text(enhance.provider, DEFAULT_SETTINGS.enhance.provider),
      model: text(enhance.model, DEFAULT_SETTINGS.enhance.model),
    },
    window: {
      x: coordinate(windowBounds.x),
      y: coordinate(windowBounds.y),
      width: size(windowBounds.width, DEFAULT_SETTINGS.window.width),
      height: size(windowBounds.height, DEFAULT_SETTINGS.window.height),
      maximized: windowBounds.maximized === true,
    },
  };
}

/** 设置读写：保存在 Electron userData 目录下的 settings.json。 */
export class SettingsStore {
  private readonly file: string;
  private cache: BoxSettings;

  constructor(private readonly directory: string) {
    this.file = path.join(directory, "settings.json");
    this.cache = this.read();
  }

  getFilePath(): string {
    return this.file;
  }

  get(): BoxSettings {
    return this.cache;
  }

  // 读取失败时静默回退到默认值，保证应用始终能启动。
  private read(): BoxSettings {
    try {
      if (!fs.existsSync(this.file)) return normalizeSettings(DEFAULT_SETTINGS);
      return normalizeSettings(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return normalizeSettings(DEFAULT_SETTINGS);
    }
  }

  save(raw: unknown): BoxSettings {
    const settings = normalizeSettings(raw);
    const validation = validateSettings(settings);
    if (!validation.ok) throw new Error(validation.message);
    this.write(settings);
    return settings;
  }

  // 内部写入：跳过校验，用于保存窗口位置这类由程序产生的值。
  private write(settings: BoxSettings): void {
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    this.cache = settings;
  }

  /** 只更新窗口位置与尺寸，校验只针对可编辑字段，避免窗口尺寸触发业务校验。 */
  saveWindowBounds(bounds: WindowBounds): void {
    this.write(normalizeSettings({ ...this.cache, window: bounds }));
  }

  /** 重置为默认设置，同时把设置文件写回默认值，并清掉记住的窗口位置。 */
  reset(): BoxSettings {
    const defaults = normalizeSettings({
      ...DEFAULT_SETTINGS,
      // 重置时一并清掉提示词增强的模型选择，回到未选择状态。
      enhance: { provider: "", model: "" },
    });
    this.write(defaults);
    return defaults;
  }

  // 组装传给 pi-web 进程的环境变量，空值一律不设置，避免覆盖 pi-web 自身默认行为。
  getPiWebEnvironment(): Record<string, string> {
    const env: Record<string, string> = { PI_WEB_NO_OPEN: "1" };
    const { port, hostname, allowedHosts, password, commandPath, nodePath } = this.cache.piWeb;
    if (port.trim()) env.PORT = port.trim();
    if (hostname.trim()) env.PI_WEB_HOSTNAME = hostname.trim();
    if (allowedHosts.trim()) env.PI_WEB_ALLOWED_HOSTS = allowedHosts.trim();
    if (password) env.PI_WEB_PASSWORD = password;
    // 这两项交给既有的环境变量入口，避免修改进程管理模块的探测逻辑。
    if (commandPath.trim()) env.PI_WEB_BOX_COMMAND = commandPath.trim();
    if (nodePath.trim()) env.PI_WEB_BOX_NODE = nodePath.trim();
    return env;
  }

  /** 返回生效中的 pi-web 启动命令，用于在设置界面和故障页展示。 */
  getPiWebCommandLine(): string {
    const { port, hostname, allowedHosts, password } = this.cache.piWeb;
    const parts = ["pi-web", "--no-open"];
    if (hostname.trim()) parts.push("--hostname", hostname.trim());
    if (port.trim()) parts.push("--port", port.trim());
    if (allowedHosts.trim()) parts.push(`PI_WEB_ALLOWED_HOSTS=${allowedHosts.trim()}`);
    // 密码不回显明文，只提示是否启用，避免日志和界面泄露。
    if (password) parts.push("PI_WEB_PASSWORD=已设置");
    return parts.join(" ");
  }
}
