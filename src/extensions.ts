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

/** pi 的 agent 目录，跟随 PI_CODING_AGENT_DIR。 */
export function piAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

export function extensionsDirectory(): string {
  return path.join(piAgentDirectory(), "extensions");
}

const PI_USAGE_LOG = {
  name: "pi-usage-log",
  displayName: "Token 用量记录",
  description: "在每条助手消息结束时记录 token 用量，供 Pi Web Box 的用量统计使用。",
};

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

/** 检测 pi-usage-log 的安装状态。 */
export function checkUsageLogExtension(
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): ExtensionStatus {
  const target = path.join(extensionsDirectory(), PI_USAGE_LOG.name);
  const source = builtinExtensionSource(PI_USAGE_LOG.name, resourcesPath, isPackaged, projectRoot);
  const installed = fs.existsSync(path.join(target, "index.ts"));
  const sourceAvailable = fs.existsSync(path.join(source, "index.ts"));
  // 两边都有版本号时才比较，任一缺失都视为需要刷新，避免误判为已最新。
  const targetVersion = readExtensionVersion(target);
  const sourceVersion = readExtensionVersion(source);
  const upToDate = installed && sourceAvailable && !!targetVersion && targetVersion === sourceVersion;
  return {
    ...PI_USAGE_LOG,
    installed,
    installPath: target,
    sourcePath: source,
    sourceAvailable,
    upToDate,
  };
}

/**
 * 把内置的 pi-usage-log 复制到 pi 扩展目录。已存在时覆盖 index.ts 与说明文件，
 * 保留用户可能自行添加的文件，避免误删。
 */
export async function installUsageLogExtension(
  resourcesPath: string,
  isPackaged: boolean,
  projectRoot?: string,
): Promise<InstallResult> {
  const status = checkUsageLogExtension(resourcesPath, isPackaged, projectRoot);
  if (!status.sourceAvailable) {
    return { ok: false, message: "安装包内未找到内置的用量记录插件，无法自动安装。" };
  }
  try {
    const target = status.installPath;
    fs.mkdirSync(target, { recursive: true });
    // 只复制运行所需的源码与元数据文件。
    for (const file of ["index.ts", "package.json", "README.md"]) {
      const from = path.join(status.sourcePath, file);
      if (!fs.existsSync(from)) continue;
      await readFile(from);
      fs.copyFileSync(from, path.join(target, file));
    }
    const after = checkUsageLogExtension(resourcesPath, isPackaged, projectRoot);
    if (!after.installed) return { ok: false, message: "插件文件复制后仍未检测到 index.ts，请检查目录权限。" };
    return { ok: true, message: "用量记录插件已安装，重新加载 pi 后开始记录。", status: after };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
