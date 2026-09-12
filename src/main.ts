import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { ComponentVersions, StartupProgress } from "./contracts.js";
import { PiWebProcessManager } from "./pi-web-process.js";
import { ShortcutManager, type IconTheme } from "./shortcut.js";
import {
  VersionManager,
  type InstalledVersionInfo,
  type PackageVersionInfo,
  type VersionProgress,
} from "./version-manager.js";
import { buildVersionPanelScript } from "./version-panel.js";

const APP_ID = "com.piweb.box";
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | undefined;
let manager: PiWebProcessManager | undefined;
let shortcutManager: ShortcutManager | undefined;
let startupInFlight: Promise<void> | undefined;
let updateCheckCompleted = false;
let isQuitting = false;
let versionPanelIconDataUrl = "";
let status = { message: "", details: "", logPath: "" };
let startupProgress: StartupProgress = {
  title: "正在启动 Pi Web",
  message: "正在准备本地服务，请稍候…",
  indeterminate: true,
};
let componentVersions: ComponentVersions = {
  pi: "未检测",
  piWeb: "未检测",
  piWebBox: app.getVersion(),
};

function appFilePath(file: string): string {
  return path.join(app.getAppPath(), file);
}

function assetPath(file: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, "assets", file) : appFilePath(path.join("assets", file));
}

function getLogPath(): string {
  return manager?.getLogPath() || path.join(app.getPath("userData"), "logs", "pi-web.log");
}

function log(message: string): void {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  console.log(`[Pi Web Box] ${message}`);
}

function publishStartupProgress(progress: StartupProgress): void {
  startupProgress = progress;
  status = {
    message: progress.title,
    details: progress.detail || progress.message,
    logPath: getLogPath(),
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pi-web-box:startup-progress", progress);
  }
}

function getIconTheme(): IconTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

async function applySystemTheme(): Promise<void> {
  const theme = getIconTheme();
  // 任务栏不使用纯黑/纯白图标，统一使用深色底白色 Pi 的高对比图标。
  mainWindow?.setIcon(assetPath("pi-logo-adaptive.ico"));
  await shortcutManager?.createOrUpdate(theme);
  log(`Applied ${theme} Windows theme icon.`);
}

function formatUpdateDetail(packages: PackageVersionInfo[]): string {
  return packages
    .map((item) => `${item.displayName}：${item.currentVersion} → ${item.latestVersion}（${item.packageManager}）`)
    .join("\n");
}

function cacheInstalledVersions(installed: InstalledVersionInfo[]): void {
  componentVersions = {
    pi: installed.find((item) => item.commandName === "pi")?.currentVersion || "未检测",
    piWeb: installed.find((item) => item.commandName === "pi-web")?.currentVersion || "未检测",
    piWebBox: app.getVersion(),
  };
}

function publishVersionCheckProgress(progress: VersionProgress): void {
  publishStartupProgress({
    title: "正在检查组件版本",
    message: progress.message,
    percent: progress.total > 0 ? (progress.completed / progress.total) * 100 : 0,
    indeterminate: true,
  });
}

async function restartApplication(): Promise<void> {
  publishStartupProgress({
    title: "正在重启 Pi Web Box",
    message: "更新已完成，正在重新启动应用…",
    percent: 100,
  });
  await manager?.close();
  isQuitting = true;
  const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (app.isPackaged && portableExecutable) app.relaunch({ execPath: portableExecutable });
  else app.relaunch();
  app.exit(0);
}

async function checkAndUpdateVersions(): Promise<"continue" | "restart" | "quit"> {
  if (updateCheckCompleted) return "continue";
  updateCheckCompleted = true;

  const versionManager = new VersionManager(log);
  publishStartupProgress({
    title: "正在检查组件版本",
    message: "正在读取 Pi 和 Pi Web 的本机版本…",
    indeterminate: true,
  });
  const installed = await versionManager.getInstalledVersions(publishVersionCheckProgress);
  cacheInstalledVersions(installed);
  const packages = await versionManager.checkForUpdates(installed, publishVersionCheckProgress);
  if (packages.length === 0 || !mainWindow) {
    publishStartupProgress({
      title: "版本检查完成",
      message: "Pi 和 Pi Web 已是最新版本，正在启动本地服务…",
      percent: 100,
    });
    return "continue";
  }

  const answer = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "发现 Pi 更新",
    message: "检测到 Pi 相关组件有新版本，是否立即更新？",
    detail: `${formatUpdateDetail(packages)}\n\n更新过程会在当前窗口显示 npm/pnpm 输出。`,
    buttons: ["立即更新", "暂不更新"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) {
    log("User skipped available updates.");
    publishStartupProgress({
      title: "已跳过更新",
      message: "正在使用当前已安装版本启动 Pi Web…",
      percent: 100,
    });
    return "continue";
  }

  const outputLines: string[] = [formatUpdateDetail(packages), ""];
  const packageManagers = new Map(packages.map((item) => [item.displayName, item.packageManager]));
  try {
    await versionManager.update(packages, (progress) => {
      if (progress.stage === "output") outputLines.push(`[${progress.displayName}] ${progress.message}`);
      if (progress.stage === "completed") outputLines.push(`[${progress.displayName}] 更新完成`);
      if (outputLines.length > 24) outputLines.splice(2, outputLines.length - 24);

      const percent = progress.total > 0
        ? ((progress.completed + (progress.stage === "completed" ? 0 : 0.5)) / progress.total) * 100
        : 0;
      const managerName = packageManagers.get(progress.displayName) || "npm";
      publishStartupProgress({
        title: `正在更新 ${progress.displayName}`,
        message: progress.stage === "completed"
          ? progress.message
          : `${managerName} 正在下载并安装，请稍候…`,
        detail: outputLines.join("\n"),
        percent,
        indeterminate: progress.stage !== "completed",
      });
    });

    for (const item of packages) {
      if (item.commandName === "pi") componentVersions.pi = item.latestVersion;
      if (item.commandName === "pi-web") componentVersions.piWeb = item.latestVersion;
    }
    publishStartupProgress({
      title: "组件更新完成",
      message: "Pi 和 Pi Web 已更新，确认后将重启 Pi Web Box。",
      detail: outputLines.join("\n"),
      percent: 100,
    });
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "更新完成",
      message: "Pi 相关组件已更新完成。",
      detail: "点击确认后将重启 Pi Web Box，并使用新版本启动 Pi Web。",
      buttons: ["确认并重启"],
      defaultId: 0,
      noLink: true,
    });
    await restartApplication();
    return "restart";
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    log(`Automatic update failed: ${details}`);
    publishStartupProgress({
      title: "自动更新失败",
      message: "可以继续使用当前版本，详细信息已写入日志。",
      detail: [...outputLines, details].join("\n"),
      indeterminate: false,
    });
    const result = await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "自动更新失败",
      message: "未能完成自动更新。",
      detail: `${details}\n\n可以查看日志排查，或继续使用当前已安装版本。`,
      buttons: ["继续启动", "退出"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0 ? "continue" : "quit";
  }
}

function loadLocal(file: string): Promise<void> {
  if (!mainWindow) return Promise.resolve();
  return mainWindow.loadFile(appFilePath(path.join("build", file)));
}

function showError(error: unknown): void {
  const details = error instanceof Error ? error.stack || error.message : String(error);
  status = {
    message: error instanceof Error ? error.message : "无法启动 Pi Web。",
    details,
    logPath: manager?.getLogPath() || path.join(app.getPath("userData"), "logs", "pi-web.log"),
  };
  void loadLocal("error.html").finally(() => mainWindow?.show());
}

function isPiWebPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function injectVersionPanel(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !isPiWebPage(mainWindow.webContents.getURL())) return;
  if (!versionPanelIconDataUrl) {
    // 悬浮按钮使用白底黑色 Pi，避免高对比任务栏图标在页面中显得过重。
    const icon = fs.readFileSync(assetPath("pi-logo-on-light.svg")).toString("base64");
    versionPanelIconDataUrl = `data:image/svg+xml;base64,${icon}`;
  }
  try {
    await mainWindow.webContents.executeJavaScript(buildVersionPanelScript({
      ...componentVersions,
      iconDataUrl: versionPanelIconDataUrl,
    }), true);
  } catch (error) {
    log(`Could not inject version panel: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startPiWeb(): Promise<void> {
  if (startupInFlight) return startupInFlight;
  startupInFlight = (async () => {
    const logPath = getLogPath();
    manager ??= new PiWebProcessManager(
      logPath,
      (message) => console.log(`[Pi Web Box] ${message}`),
      (error) => { if (!isQuitting) showError(error); },
    );
    await loadLocal("startup.html");
    mainWindow?.show();
    try {
      const updateAction = await checkAndUpdateVersions();
      if (updateAction === "restart") return;
      if (updateAction === "quit") {
        app.quit();
        return;
      }
      publishStartupProgress({
        title: "正在启动 Pi Web",
        message: "正在启动本地服务并等待页面就绪…",
        indeterminate: true,
      });
      const result = await manager.start();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await mainWindow.loadURL(result.url);
      mainWindow.show();
      mainWindow.focus();
    } catch (error) {
      showError(error);
    }
  })().finally(() => { startupInFlight = undefined; });
  return startupInFlight;
}

function createWindow(): void {
  // 任务栏和窗口标题栏统一使用高对比度图标，避免 Windows 深色任务栏中黑色 Pi 不可见。
  const icon = assetPath("pi-logo-adaptive.ico");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Pi Web Box",
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18181b" : "#f7f8fa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: appFilePath(path.join("build", "preload.js")),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Alt" || input.code === "AltLeft" || input.code === "AltRight") event.preventDefault();
  });
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle("Pi Web Box");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isPiWebPage(url) || url.startsWith("file://")) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  mainWindow.webContents.on("did-finish-load", () => { void injectVersionPanel(); });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  void startPiWeb();
}

ipcMain.handle("pi-web-box:get-status", () => status);
ipcMain.handle("pi-web-box:get-startup-progress", () => startupProgress);
ipcMain.handle("pi-web-box:get-log-path", () => status.logPath || manager?.getLogPath() || "");
ipcMain.handle("pi-web-box:open-log", async () => {
  const logPath = status.logPath || manager?.getLogPath();
  if (logPath) await shell.openPath(logPath);
});
ipcMain.handle("pi-web-box:retry", async () => {
  if (!mainWindow || startupInFlight) return;
  await manager?.stop();
  await startPiWeb();
});

app.setAppUserModelId(APP_ID);

if (gotLock) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    shortcutManager = new ShortcutManager(log);
    createWindow();
    await applySystemTheme();
    nativeTheme.on("updated", () => { void applySystemTheme(); });
    app.on("activate", () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    void (async () => {
      await manager?.close();
      app.exit(0);
    })();
  });
}
