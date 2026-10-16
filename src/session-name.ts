/**
 * pi-session-name 扩展的配置读写。
 *
 * 配置文件放在 pi 的 agent 目录（默认 ~/.pi/agent/pi-session-name.json），
 * 与 pi 的其它配置一起迁移；插件每次命名前都会重新读取，
 * 因此在 Box 设置里改完开关或模型即刻生效，不需要重启 pi。
 */
import fs from "node:fs";
import path from "node:path";
import type { SessionNameConfig } from "./contracts.js";
import { piAgentDirectory } from "./extensions.js";

export const SESSION_NAME_CONFIG_FILENAME = "pi-session-name.json";

/** 字段长度上限，避免异常数据写进配置文件。 */
const MAX_FIELD_LENGTH = 200;

/**
 * 默认配置：与插件此前的硬编码保持一致。
 * 用户没在 Box 里改过配置时行为不变。
 */
export const DEFAULT_SESSION_NAME_CONFIG: SessionNameConfig = {
  enabled: true,
  provider: "cc-switch-deep-seek",
  model: "deepseek-flash",
};

/** 配置文件路径（可用环境变量覆盖，便于测试）。 */
export function sessionNameConfigPath(): string {
  const override = process.env.PI_SESSION_NAME_CONFIG_FILE?.trim();
  return override || path.join(piAgentDirectory(), SESSION_NAME_CONFIG_FILENAME);
}

/** 把外部读入的数据归一化成完整配置：缺失或类型不符的字段回退默认值。 */
export function normalizeSessionNameConfig(raw: unknown): SessionNameConfig {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<SessionNameConfig>;
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" ? value.slice(0, MAX_FIELD_LENGTH) : fallback;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SESSION_NAME_CONFIG.enabled,
    provider: text(source.provider, DEFAULT_SESSION_NAME_CONFIG.provider),
    model: text(source.model, DEFAULT_SESSION_NAME_CONFIG.model),
  };
}

export type SessionNameConfigValidation =
  | { ok: true; value: SessionNameConfig }
  | { ok: false; message: string };

/** 校验待保存的配置：字段类型、长度以及「启用时必须选择模型」。 */
export function validateSessionNameConfig(raw: unknown): SessionNameConfigValidation {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<SessionNameConfig>;
  if (typeof source.enabled !== "boolean") {
    return { ok: false, message: "「启用自动命名」必须是开关状态。" };
  }
  for (const [label, value] of [["供应商", source.provider], ["模型", source.model]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, message: `${label}必须是文本。` };
    if (value.length > MAX_FIELD_LENGTH) return { ok: false, message: `${label}过长。` };
    if (/\s/.test(value.trim())) return { ok: false, message: `${label}不能包含空格。` };
  }
  const value: SessionNameConfig = {
    enabled: source.enabled,
    provider: (source.provider ?? "").trim(),
    model: (source.model ?? "").trim(),
  };
  if (value.enabled && !value.model) {
    return { ok: false, message: "启用自动命名时必须选择命名模型。" };
  }
  return { ok: true, value };
}

/** 读取配置。文件缺失或内容损坏时退回默认值，保证插件与界面始终可用。 */
export function readSessionNameConfig(file: string = sessionNameConfigPath()): SessionNameConfig {
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_SESSION_NAME_CONFIG };
    return normalizeSessionNameConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULT_SESSION_NAME_CONFIG };
  }
}

/**
 * 写入配置（校验失败抛错）。
 * 先写临时文件再改名，避免插件正好在同一时刻读到半截内容。
 */
export function writeSessionNameConfig(raw: unknown, file: string = sessionNameConfigPath()): SessionNameConfig {
  const validation = validateSessionNameConfig(raw);
  if (!validation.ok) throw new Error(validation.message);
  const config = validation.value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return config;
}
