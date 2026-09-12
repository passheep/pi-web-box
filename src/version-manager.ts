import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

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
  try {
    const result = await execFileAsync("where.exe", [`${commandName}.cmd`], { windowsHide: true });
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  } catch {
    return undefined;
  }
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
  try {
    const result = await execFileAsync("where.exe", [fileName], { windowsHide: true });
    const executable = result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (executable) return executable;
  } catch { /* handled below */ }
  throw new Error(`找不到 ${fileName}，无法自动更新。`);
}

async function findNpmCli(): Promise<{ node: string; cli: string }> {
  const node = await findExecutable("node.exe");
  const npmCommand = await findExecutable("npm.cmd");
  const cli = path.join(path.dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(cli)) throw new Error(`找不到 npm-cli.js：${cli}`);
  return { node, cli };
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
