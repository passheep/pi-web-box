import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { findCommandOnPath, findExecutableOnPath } from "./executables.js";

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 5_000;

export type PackageManagerName = "npm" | "pnpm";

export type InstalledVersionInfo = {
  displayName: string;
  packageName: string;
  commandName: string;
  currentVersion: string;
  packageManager: PackageManagerName;
};

export type PackageVersionInfo = InstalledVersionInfo & {
  latestVersion: string;
};

export type VersionProgress = {
  stage: "checking" | "installing" | "output" | "completed";
  displayName: string;
  message: string;
  completed: number;
  total: number;
};

/** 缺失的内置命令组件（pi / pi-web），供一键安装使用。 */
export type MissingPackage = {
  displayName: string;
  packageName: string;
  commandName: string;
};

/** 启动前环境自检的结果。 */
export type EnvironmentCheck = {
  npmAvailable: boolean;
  nodePath: string;
  npmPath: string;
  installed: InstalledVersionInfo[];
  missing: MissingPackage[];
};

/** PATH 上能否找到可用的 npm（npm.cmd + npm-cli.js，两者缺一不可）。 */
export type RuntimeAvailability = {
  nodePath: string;
  npmPath: string;
  npmCliPath: string;
  npmAvailable: boolean;
};

/**
 * 检测 Node.js 与 npm 是否可用。
 * 只扫描 PATH 与文件是否存在，不创建子进程，因此可以安全地在启动阶段同步调用。
 */
export function checkRuntimeEnvironment(
  env: Record<string, string | undefined> = process.env,
): RuntimeAvailability {
  const nodePath = findExecutableOnPath(["node.exe", "node"], env) ?? "";
  const npmPath = findExecutableOnPath(["npm.cmd", "npm"], env) ?? "";
  // npm.cmd 是批处理包装，真正的入口在它旁边的 node_modules/npm/bin/npm-cli.js。
  const npmCliPath = npmPath
    ? path.join(path.dirname(npmPath), "node_modules", "npm", "bin", "npm-cli.js")
    : "";
  const npmAvailable = Boolean(nodePath && npmCliPath && fs.existsSync(npmCliPath));
  return { nodePath, npmPath, npmCliPath, npmAvailable };
}

const PACKAGES = [
  { displayName: "Pi", packageName: "@earendil-works/pi-coding-agent", commandName: "pi" },
  { displayName: "Pi Web", packageName: "@agegr/pi-web", commandName: "pi-web" },
] as const;

export function compareVersions(left: string, right: string): number {
  const normalize = (version: string) => version.trim().replace(/^v/i, "").split("+", 1)[0];
  const [leftMain, leftPre = ""] = normalize(left).split("-", 2);
  const [rightMain, rightPre = ""] = normalize(right).split("-", 2);
  const leftParts = leftMain.split(".").map((part) => Number(part) || 0);
  const rightParts = rightMain.split(".").map((part) => Number(part) || 0);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (leftPre === rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return leftPre.localeCompare(rightPre, undefined, { numeric: true });
}

export function isNewerVersion(currentVersion: string, latestVersion: string): boolean {
  return compareVersions(latestVersion, currentVersion) > 0;
}

function packagePathParts(packageName: string): string[] {
  return packageName.split("/");
}

async function findCommand(commandName: string): Promise<string | undefined> {
  return findCommandOnPath(`${commandName}.cmd`) || findCommandOnPath(commandName);
}

async function findPackageJson(commandPath: string, packageName: string): Promise<string | undefined> {
  const commandDirectory = path.dirname(commandPath);
  const direct = path.join(commandDirectory, "node_modules", ...packagePathParts(packageName), "package.json");
  if (fs.existsSync(direct)) return direct;

  const pnpmGlobal = path.join(commandDirectory, "global");
  try {
    const versions = await fsp.readdir(pnpmGlobal, { withFileTypes: true });
    const directories = versions
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    for (const version of directories) {
      const candidate = path.join(pnpmGlobal, version.name, "node_modules", ...packagePathParts(packageName), "package.json");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* 不是 pnpm 全局目录时继续返回未找到 */ }
  return undefined;
}

function getRegistry(): string {
  return (process.env.PI_WEB_BOX_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
}

async function fetchLatestVersion(packageName: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${getRegistry()}/${packageName}/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { version?: unknown };
    if (typeof data.version !== "string") throw new Error("npm registry 未返回有效版本号");
    return data.version;
  } finally {
    clearTimeout(timer);
  }
}

async function findExecutable(fileName: string): Promise<string> {
  // 直接扫描 PATH，避免在主进程里创建控制台子进程。
  const executable = findExecutableOnPath([fileName]);
  if (executable) return executable;
  throw new Error(`找不到 ${fileName}，无法自动更新。`);
}

async function findNpmCli(): Promise<{ node: string; cli: string }> {
  const runtime = checkRuntimeEnvironment();
  if (!runtime.nodePath) throw new Error("找不到 node.exe，无法自动安装。");
  if (!runtime.npmPath) throw new Error("找不到 npm.cmd，无法自动安装。");
  if (!runtime.npmAvailable) throw new Error(`找不到 npm-cli.js：${runtime.npmCliPath}`);
  return { node: runtime.nodePath, cli: runtime.npmCliPath };
}

function emitOutput(text: string, onOutput: (message: string) => void): void {
  for (const line of text.split(/\r?\n|\r/).map((value) => value.trim()).filter(Boolean)) {
    onOutput(line);
  }
}

function waitForProcess(child: ChildProcess, onOutput: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (data: Buffer) => emitOutput(data.toString(), onOutput));
    child.stderr?.on("data", (data: Buffer) => emitOutput(data.toString(), onOutput));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`更新命令执行失败，退出代码：${code ?? "未知"}`));
    });
  });
}

export class VersionManager {
  constructor(private readonly log: (message: string) => void) {}

  /**
   * 启动前环境自检：Node.js/npm 是否可用 + pi / pi-web 是否已安装。
   * 已安装清单同时返回，调用方可以直接用它填充界面上的版本信息。
   */
  async checkEnvironment(onProgress?: (progress: VersionProgress) => void): Promise<EnvironmentCheck> {
    const runtime = checkRuntimeEnvironment();
    const installed = await this.getInstalledVersions(onProgress);
    const missing = PACKAGES
      .filter((item) => !installed.some((entry) => entry.commandName === item.commandName))
      .map((item) => ({
        displayName: item.displayName,
        packageName: item.packageName,
        commandName: item.commandName,
      }));
    return {
      npmAvailable: runtime.npmAvailable,
      nodePath: runtime.nodePath,
      npmPath: runtime.npmPath,
      installed,
      missing,
    };
  }

  /**
   * 安装缺失的组件：统一用 npm 全局安装最新版（行家的 pi 用 pnpm 安装时也不影响，
   * 只是多一个全局副本），输出与进度走与自动更新相同的一条通道。
   */
  async install(
    packages: MissingPackage[],
    onProgress?: (progress: VersionProgress) => void,
  ): Promise<void> {
    const registry = getRegistry();
    for (let index = 0; index < packages.length; index += 1) {
      const item = packages[index];
      const baseProgress = {
        displayName: item.displayName,
        completed: index,
        total: packages.length,
      };
      onProgress?.({ ...baseProgress, stage: "installing", message: `正在安装 ${item.displayName}…` });
      this.log(`Installing ${item.packageName}@latest with npm via ${registry}.`);

      const onOutput = (message: string) => {
        this.log(`${item.displayName} install: ${message}`);
        onProgress?.({ ...baseProgress, stage: "output", message });
      };
      const npm = await findNpmCli();
      const child = spawn(npm.node, [
        npm.cli, "install", "--global", `${item.packageName}@latest`, "--registry", registry,
        "--progress=true", "--loglevel=notice",
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", npm_config_progress: "true" },
      });
      await waitForProcess(child, onOutput);

      this.log(`${item.displayName} install completed.`);
      onProgress?.({
        stage: "completed",
        displayName: item.displayName,
        message: `${item.displayName} 安装完成`,
        completed: index + 1,
        total: packages.length,
      });
    }
  }

  async getInstalledVersions(onProgress?: (progress: VersionProgress) => void): Promise<InstalledVersionInfo[]> {
    const installed: InstalledVersionInfo[] = [];
    for (let index = 0; index < PACKAGES.length; index += 1) {
      const item = PACKAGES[index];
      onProgress?.({
        stage: "checking",
        displayName: item.displayName,
        message: `正在读取 ${item.displayName} 本机版本…`,
        completed: index,
        total: PACKAGES.length,
      });
      try {
        const command = await findCommand(item.commandName);
        if (!command) {
          this.log(`Local version check skipped for ${item.displayName}: command not found.`);
          continue;
        }
        const packageJson = await findPackageJson(command, item.packageName);
        if (!packageJson) {
          this.log(`Local version check skipped for ${item.displayName}: package.json not found.`);
          continue;
        }
        const packageData = JSON.parse(await fsp.readFile(packageJson, "utf8")) as { version?: unknown };
        if (typeof packageData.version !== "string") throw new Error("本地 package.json 缺少版本号");
        installed.push({
          ...item,
          currentVersion: packageData.version,
          packageManager: /[\\/]pnpm[\\/]/i.test(command) ? "pnpm" : "npm",
        });
      } catch (error) {
        this.log(`Could not read ${item.displayName} version: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return installed;
  }

  async checkForUpdates(
    installed: InstalledVersionInfo[],
    onProgress?: (progress: VersionProgress) => void,
  ): Promise<PackageVersionInfo[]> {
    if (process.env.PI_WEB_BOX_SKIP_UPDATE_CHECK === "1") {
      this.log("Version update check skipped by PI_WEB_BOX_SKIP_UPDATE_CHECK.");
      return [];
    }

    const updates: PackageVersionInfo[] = [];
    for (let index = 0; index < installed.length; index += 1) {
      const item = installed[index];
      onProgress?.({
        stage: "checking",
        displayName: item.displayName,
        message: `正在查询 ${item.displayName} 最新版本…`,
        completed: index,
        total: installed.length,
      });
      try {
        const latestVersion = await fetchLatestVersion(item.packageName);
        this.log(`${item.displayName} version: local=${item.currentVersion}, latest=${latestVersion}, manager=${item.packageManager}.`);
        if (isNewerVersion(item.currentVersion, latestVersion)) updates.push({ ...item, latestVersion });
      } catch (error) {
        this.log(`Could not check ${item.displayName} latest version: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return updates;
  }

  async update(packages: PackageVersionInfo[], onProgress?: (progress: VersionProgress) => void): Promise<void> {
    const registry = getRegistry();
    for (let index = 0; index < packages.length; index += 1) {
      const item = packages[index];
      const baseProgress = {
        displayName: item.displayName,
        completed: index,
        total: packages.length,
      };
      onProgress?.({ ...baseProgress, stage: "installing", message: `正在更新 ${item.displayName} 到 ${item.latestVersion}…` });
      this.log(`Updating ${item.displayName} to ${item.latestVersion} with ${item.packageManager} via ${registry}.`);

      const onOutput = (message: string) => {
        this.log(`${item.displayName} update: ${message}`);
        onProgress?.({ ...baseProgress, stage: "output", message });
      };
      if (item.packageManager === "pnpm") {
        const pnpm = await findExecutable("pnpm.exe");
        const child = spawn(pnpm, [
          "add", "--global", `${item.packageName}@latest`, "--registry", registry, "--reporter", "append-only",
        ], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        await waitForProcess(child, onOutput);
      } else {
        const npm = await findNpmCli();
        const child = spawn(npm.node, [
          npm.cli, "install", "--global", `${item.packageName}@latest`, "--registry", registry,
          "--progress=true", "--loglevel=notice",
        ], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0", npm_config_progress: "true" },
        });
        await waitForProcess(child, onOutput);
      }

      this.log(`${item.displayName} update completed.`);
      onProgress?.({
        stage: "completed",
        displayName: item.displayName,
        message: `${item.displayName} 已更新到 ${item.latestVersion}`,
        completed: index + 1,
        total: packages.length,
      });
    }
  }
}
