import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 30141;
const START_TIMEOUT_MS = 35_000;
const HEALTH_TIMEOUT_MS = 1_200;

export type PiWebStartResult = { url: string; owned: boolean; port: number };

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("端口必须是 0 到 65535 之间的整数。");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 到 65535 之间的整数。");
  return port;
}

export function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function isHealthyPiWebStatus(status: number, body: string): boolean {
  return status >= 200 && status < 400 && /Pi Web/i.test(body);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 350);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function readPiWebPage(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const password = process.env.PI_WEB_PASSWORD;
  const headers = password ? { Authorization: `Basic ${Buffer.from(`pi:${password}`).toString("base64")}` } : undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: "manual", headers });
    const body = await response.text();
    return isHealthyPiWebStatus(response.status, body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function findCommand(): Promise<string> {
  const override = process.env.PI_WEB_BOX_COMMAND?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("PI_WEB_BOX_COMMAND 必须是 pi-web.cmd 的绝对路径。");
    if (!fs.existsSync(override)) throw new Error(`PI_WEB_BOX_COMMAND 指向的文件不存在：${override}`);
    return override;
  }

  const candidates: string[] = [];
  const npmGlobal = process.env.NPM_CONFIG_PREFIX;
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (npmGlobal) candidates.push(path.join(npmGlobal, "pi-web.cmd"));
  if (localAppData) candidates.push(path.join(localAppData, "npm-global", "pi-web.cmd"));
  if (appData) candidates.push(path.join(appData, "npm", "pi-web.cmd"));

  try {
    const result = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["pi-web.cmd"], { windowsHide: true });
    candidates.unshift(...result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  } catch { /* fallback candidates below */ }

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || fs.existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 pi-web 命令。请先执行 npm install -g @agegr/pi-web@latest，或设置 PI_WEB_BOX_COMMAND 指向 pi-web.cmd。");
}

async function findNodeExecutable(): Promise<string> {
  const override = process.env.PI_WEB_BOX_NODE?.trim();
  if (override) {
    if (!path.isAbsolute(override) || !fs.existsSync(override)) {
      throw new Error(`PI_WEB_BOX_NODE 指向的 Node.js 不存在：${override}`);
    }
    return override;
  }

  try {
    const result = await execFileAsync("where.exe", ["node.exe"], { windowsHide: true });
    const node = result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (node) return node;
  } catch { /* handled below */ }
  throw new Error("找不到 Node.js。请安装 Node.js 22.19.0 或更高版本，并确保 node.exe 位于 PATH 中。");
}

export function resolvePiWebEntry(command: string): string {
  return path.join(path.dirname(command), "node_modules", "@agegr", "pi-web", "bin", "pi-web.js");
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

export class PiWebProcessManager {
  private child: ChildProcess | undefined;
  private owned = false;
  private stopping = false;
  private ready = false;
  private logStream: fs.WriteStream;

  constructor(
    private readonly logPath: string,
    private readonly log: (message: string) => void = () => {},
    private readonly onUnexpectedExit?: (error: Error) => void,
  ) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
  }

  getLogPath(): string { return this.logPath; }

  private writeLog(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    this.logStream.write(line);
    this.log(message);
  }

  async start(): Promise<PiWebStartResult> {
    const preferred = parsePort(process.env.PI_WEB_BOX_PORT?.trim() || String(DEFAULT_PORT));
    if (await readPiWebPage(preferred)) {
      this.writeLog(`Reusing healthy Pi Web at port ${preferred}.`);
      return { url: `http://127.0.0.1:${preferred}`, owned: false, port: preferred };
    }

    const port = await canConnect(preferred) ? await getFreePort() : preferred;
    const command = await findCommand();
    const entry = resolvePiWebEntry(command);
    if (!fs.existsSync(entry)) {
      throw new Error(`找到了 pi-web 命令，但缺少 npm 包入口：${entry}。请重新执行 npm install -g @agegr/pi-web@latest。`);
    }
    const node = await findNodeExecutable();
    const args = [entry, "--hostname", "127.0.0.1", "--port", String(port), "--no-open"];
    this.writeLog(`Starting ${node} ${args.join(" ")} on port ${port}.`);

    this.child = spawn(node, args, {
      cwd: os.homedir(),
      env: { ...process.env, PI_WEB_NO_OPEN: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.owned = true;
    const child = this.child;
    child.stdout?.on("data", (data: Buffer) => this.writeLog(`stdout: ${data.toString().trimEnd()}`));
    child.stderr?.on("data", (data: Buffer) => this.writeLog(`stderr: ${data.toString().trimEnd()}`));
    child.once("error", (error) => this.writeLog(`Process error: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.writeLog(`Process exited: code=${code} signal=${signal}`);
      if (this.ready && !this.stopping) {
        this.ready = false;
        this.onUnexpectedExit?.(new Error(`Pi Web 后台服务意外退出（代码 ${code ?? "未知"}）。`));
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await readPiWebPage(port)) {
        this.ready = true;
        this.writeLog(`Pi Web is ready at port ${port}.`);
        return { url: `http://127.0.0.1:${port}`, owned: true, port };
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const exit = child.exitCode !== null ? `进程已退出（代码 ${child.exitCode}）。` : "服务在规定时间内没有响应。";
    await this.stop();
    throw new Error(`Pi Web 启动失败：${exit}`);
  }

  async stop(): Promise<void> {
    if (!this.owned || !this.child || this.stopping) return;
    this.stopping = true;
    const child = this.child;
    this.writeLog("Stopping owned Pi Web process tree.");
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    } else {
      child.kill("SIGTERM");
    }
    await Promise.race([waitForExit(child), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    this.child = undefined;
    this.owned = false;
    this.ready = false;
    this.stopping = false;
  }

  async close(): Promise<void> {
    await this.stop();
    await fsp.appendFile(this.logPath, "");
    this.logStream.end();
  }
}
