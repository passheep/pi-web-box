import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

// 需要随 Box 一起提供或检测的 pi 扩展。
export type ExtensionStatus = {
  name: string;
  displayName: string;
  description: string;
  installed: boolean;
  installPath: string;
  // 该扩展对应的内置资源目录（安装时从这里复制），资源缺失时为空。
  sourcePath: string;
  sourceAvailable: boolean;
  // 已安装的扩展是否与内置版本一致，便于提示更新。
  upToDate: boolean;
};

export type InstallResult = { ok: boolean; message: string; status?: ExtensionStatus };

/** Box 内置并支持一键安装的扩展名。 */
export type BuiltinExtensionName = "pi-usage-log" | "pi-session-name";

type BuiltinExtensionSpec = {
  name: BuiltinExtensionName;
  displayName: string;
  description: string;
  // 安装（或更新）时从内置资源复制的文件；目录下的其它文件保持原样。
  files: string[];
};

// 内置扩展清单：新增扩展只需要在这里补一项。
const BUILTIN_EXTENSIONS: readonly BuiltinExtensionSpec[] = [
  {
    name: "pi-usage-log",
    displayName: "Token 用量记录",
    description: "在每条助手消息结束时记录 token 用量，供 Pi Web Box 的用量统计使用。",
    files: ["index.ts", "package.json", "README.md"],
  },
  {
    name: "pi-session-name",
    displayName: "会话自动命名",
    description: "新建会话时用指定模型生成带日期的会话名；启用开关与命名模型可在 Box 设置中修改，保存后即刻生效。",
    // 连测试文件一起安装：本地插件目录里的 index.test.ts 需要跟着 index.ts 一起更新。
    files: ["index.ts", "package.json", "README.md", "index.test.ts"],
  },
];

/** 供 IPC 层做名称白名单校验。 */
export const BUILTIN_EXTENSION_NAMES: readonly BuiltinExtensionName[] =
  BUILTIN_EXTENSIONS.map((item) => item.name);

const PI_USAGE_LOG = BUILTIN_EXTENSIONS[0];

/** pi 的 agent 目录，跟随 PI_CODING_AGENT_DIR。 */
export function piAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

export function extensionsDirectory(): string {
  return path.join(piAgentDirectory(), "extensions");
}

function findSpec(name: string): BuiltinExtensionSpec | undefined {
  return BUILTIN_EXTENSIONS.find((item) => item.name === name);
}

/**
 * 内置扩展的来源目录。
 * 打包后位于 resources/extensions；开发时目录在仓库根下的 extensions/，
 * 由调用方传入应用根目录，避免依赖 resourcesPath 的相对层级。
 */
function builtinExtensionSource(
  name: string,
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): string {
  if (isPackaged) return path.join(resourcesPath, "extensions", name);
  return path.join(projectRoot ?? resourcesPath, "extensions", name);
}

function readExtensionVersion(directory: string): string {
  try {
    const raw = fs.readFileSync(path.join(directory, "package.json"), "utf8");
    const data = JSON.parse(raw) as { version?: unknown };
    return typeof data.version === "string" ? data.version : "";
  } catch {
    return "";
  }
}

/** 检测某个内置扩展的安装状态；未知扩展名返回 undefined。 */
export function checkBuiltinExtension(
  name: string,
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): ExtensionStatus | undefined {
  const spec = findSpec(name);
  if (!spec) return undefined;
  const target = path.join(extensionsDirectory(), spec.name);
  const source = builtinExtensionSource(spec.name, resourcesPath, isPackaged, projectRoot);
  const installed = fs.existsSync(path.join(target, "index.ts"));
  // 安装包只带运行所需文件，测试文件仅在开发布局下存在，因此以 index.ts 判断来源可用。
  const sourceAvailable = fs.existsSync(path.join(source, "index.ts"));
  // 两边都有版本号时才比较，任一缺失都视为需要刷新，避免误判为已最新。
  const targetVersion = readExtensionVersion(target);
  const sourceVersion = readExtensionVersion(source);
  const upToDate = installed && sourceAvailable && !!targetVersion && targetVersion === sourceVersion;
  return {
    name: spec.name,
    displayName: spec.displayName,
    description: spec.description,
    installed,
    installPath: target,
    sourcePath: source,
    sourceAvailable,
    upToDate,
  };
}

/**
 * 把内置扩展复制到 pi 扩展目录。已存在时覆盖清单内的文件，
 * 保留用户可能自行添加的其它文件，避免误删。
 */
export async function installBuiltinExtension(
  name: string,
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): Promise<InstallResult> {
  const spec = findSpec(name);
  const before = checkBuiltinExtension(name, resourcesPath, isPackaged, projectRoot);
  if (!spec || !before) return { ok: false, message: "未知的内置扩展，无法安装。" };
  if (!before.sourceAvailable) {
    return { ok: false, message: "安装包内未找到内置插件，无法自动安装。" };
  }
  try {
    const target = before.installPath;
    fs.mkdirSync(target, { recursive: true });
    // 只复制清单里的源码与元数据文件。
    for (const file of spec.files) {
      const from = path.join(before.sourcePath, file);
      if (!fs.existsSync(from)) continue;
      await readFile(from);
      fs.copyFileSync(from, path.join(target, file));
    }
    const after = checkBuiltinExtension(name, resourcesPath, isPackaged, projectRoot)!;
    if (!after.installed) return { ok: false, message: "插件文件复制后仍未检测到 index.ts，请检查目录权限。" };
    // 插件是 pi 进程里已经加载的代码，更新文件后必须重载才会生效。
    return { ok: true, message: `${spec.displayName}插件已安装或更新，在 pi 中执行 /reload 后生效。`, status: after };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ── 兼容既有调用点 ──

/** 检测 pi-usage-log 的安装状态。 */
export function checkUsageLogExtension(
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): ExtensionStatus {
  return checkBuiltinExtension(PI_USAGE_LOG.name, resourcesPath, isPackaged, projectRoot)!;
}

/** 安装（或更新）pi-usage-log。 */
export function installUsageLogExtension(
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): Promise<InstallResult> {
  return installBuiltinExtension(PI_USAGE_LOG.name, resourcesPath, isPackaged, projectRoot);
}
