import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, Tray } from "electron";
import path from "node:path";
import fs from "node:fs";
import type {
  BoxSettingsInput,
  ComponentVersions,
  SaveSettingsResult,
  SettingsSnapshot,
  StartupProgress,
  ThemeReport,
} from "./contracts.js";
import { PiWebProcessManager } from "./pi-web-process.js";
import { SettingsStore, type BoxSettings } from "./config.js";
import { ShortcutManager, type IconTheme } from "./shortcut.js";
import { getPalette, isKnownTheme } from "./themes.js";
import { resolveTitleBarBackground, TitleBarColorizer } from "./titlebar.js";
import {
  VersionManager,
  type InstalledVersionInfo,
  type PackageVersionInfo,
  type VersionProgress,
} from "./version-manager.js";
import { buildVersionPanelScript } from "./version-panel.js";
import { buildSettingsHtml } from "./settings-view.js";

const APP_ID = "com.piweb.box";
const GITHUB_URL = "https://github.com/passheep/pi-web-box";
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let manager: PiWebProcessManager | undefined;
let shortcutManager: ShortcutManager | undefined;
let settingsStore: SettingsStore | undefined;
let titleBarColorizer: TitleBarColorizer | undefined;
let startupInFlight: Promise<void> | undefined;
let updateCheckCompleted = false;
let isQuitting = false;
let versionPanelIconDataUrl = "";
let settingsIconDataUrl = "";
let currentTheme = "";
// 记录 Pi Web 页面实测到的背景色，标题栏优先生效该值。
let currentThemeBackground = "";
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
  void loadLocal("error.html").finally(() => {
    mainWindow?.show();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  });
}

function isPiWebPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** 读取图标并转成 data URL，供注入页面和设置窗口使用。 */
function readIconDataUrl(fileName: string): string {
  const icon = fs.readFileSync(assetPath(fileName)).toString("base64");
  const mime = fileName.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${icon}`;
}

async function injectVersionPanel(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !isPiWebPage(mainWindow.webContents.getURL())) return;
  if (!versionPanelIconDataUrl) {
    // 悬浮按钮使用白底黑色 Pi，避免高对比任务栏图标在页面中显得过重。
    versionPanelIconDataUrl = readIconDataUrl("pi-logo-on-light.svg");
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

/** 把当前主题应用到 Windows 原生标题栏，缺失页面颜色时回退到内置色板。 */
function applyTitleBarTheme(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !titleBarColorizer) return;
  if (!isPiWebPage(mainWindow.webContents.getURL())) return;
  const background = resolveTitleBarBackground(currentTheme, currentThemeBackground, nativeTheme.shouldUseDarkColors);
  const hwnd = mainWindow.getNativeWindowHandle().readBigUInt64LE(0).toString();
  titleBarColorizer.apply(hwnd, background);
}

/** 通知设置窗口跟随 Pi Web 的最新主题。 */
function broadcastThemeToSettings(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const palette = getPalette(currentTheme, nativeTheme.shouldUseDarkColors);
  settingsWindow.webContents.send("pi-web-box:settings-theme", { palette, theme: currentTheme || palette.id });
}

function updateTheme(theme: string, background: string): void {
  const normalized = isKnownTheme(theme) ? theme : "";
  if (!normalized && !background) return;
  currentTheme = normalized || currentTheme;
  currentThemeBackground = background || currentThemeBackground;
  applyTitleBarTheme();
  broadcastThemeToSettings();
}

function getSettingsSnapshot(): SettingsSnapshot {
  const store = settingsStore!;
  const settings = store.get();
  const palette = getPalette(currentTheme, nativeTheme.shouldUseDarkColors);
  return {
    settings: settings as BoxSettingsInput,
    settingsFilePath: store.getFilePath(),
    commandLine: store.getPiWebCommandLine(),
    versions: componentVersions,
    theme: palette.id,
    themeLabel: palette.label,
  };
}

function broadcastSettingsChange(): void {
  const snapshot = getSettingsSnapshot();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("pi-web-box:settings-theme", {
      palette: getPalette(currentTheme, nativeTheme.shouldUseDarkColors),
      theme: currentTheme || snapshot.theme,
    });
  }
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  if (!settingsIconDataUrl) settingsIconDataUrl = readIconDataUrl("pi-logo-on-light.svg");

  settingsWindow = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 700,
    minHeight: 520,
    show: false,
    title: "Pi Web Box 设置",
    icon: assetPath("pi-logo-adaptive.ico"),
    parent: mainWindow,
    backgroundColor: getPalette(currentTheme, nativeTheme.shouldUseDarkColors).background,
    autoHideMenuBar: true,
    webPreferences: {
      preload: appFilePath(path.join("build", "preload.js")),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenu(null);
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  settingsWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  const palette = getPalette(currentTheme, nativeTheme.shouldUseDarkColors);
  const rendererScript = fs.readFileSync(appFilePath(path.join("build", "settings-renderer.js")), "utf8");
  const html = buildSettingsHtml({
    theme: palette.id,
    systemDark: nativeTheme.shouldUseDarkColors,
    iconDataUrl: settingsIconDataUrl,
    rendererScript,
  });
  // 设置页按当前主题动态生成，写入 userData 后加载，避免改动打包产物里的静态文件。
  const htmlPath = path.join(app.getPath("userData"), "settings.html");
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, "utf8");
  settingsWindow.loadFile(htmlPath).then(() => {
    settingsWindow?.show();
    settingsWindow?.focus();
  }).catch((error) => {
    log(`Could not open settings window: ${error instanceof Error ? error.message : String(error)}`);
  });
  settingsWindow.on("closed", () => { settingsWindow = undefined; });
}

async function startPiWeb(): Promise<void> {
  if (startupInFlight) return startupInFlight;
  startupInFlight = (async () => {
    const logPath = getLogPath();
    // Box 设置里的 pi-web 配置以环境变量形式下发给进程管理器，
    // 复用既有的探测与启动逻辑，同时让设置项对 Node.js 子进程生效。
    const settingsEnvironment = settingsStore?.getPiWebEnvironment() || {};
    manager ??= new PiWebProcessManager(
      logPath,
      (message) => console.log(`[Pi Web Box] ${message}`),
      (error) => { if (!isQuitting) showError(error); },
      settingsEnvironment,
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
  mainWindow.webContents.on("did-finish-load", () => {
    void injectVersionPanel();
    // 页面加载完成后立刻按当前主题刷新标题栏，页面内部的主题上报会随后覆盖它。
    setTimeout(() => applyTitleBarTheme(), 300);
  });
  // 关闭按钮按设置决定是退出还是留在托盘。
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    if (settingsStore?.get().minimizeToTrayOnClose) {
      event.preventDefault();
      mainWindow?.hide();
      ensureTray();
      log("Main window hidden to tray.");
    }
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  void startPiWeb();
}

/** 托盘图标与菜单：提供显示主窗口和彻底退出的入口。 */
function ensureTray(): void {
  if (tray) return;
  try {
    tray = new Tray(assetPath("pi-logo-adaptive.ico"));
    tray.setToolTip("Pi Web Box");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示 Pi Web Box", click: () => showMainWindow() },
      { label: "Box 设置", click: () => { showMainWindow(); createSettingsWindow(); } },
      { type: "separator" },
      { label: "退出", click: () => { isQuitting = true; app.quit(); } },
    ]));
    // 双击托盘图标直接回到主窗口，符合 Windows 使用习惯。
    tray.on("double-click", () => showMainWindow());
    log("Tray icon created.");
  } catch (error) {
    log(`Could not create tray icon: ${error instanceof Error ? error.message : String(error)}`);
    tray = undefined;
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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

// 启动页的重置入口：清空 Box 设置，回到自动探测 pi-web 与 Node.js。
ipcMain.handle("pi-web-box:reset-config", async (): Promise<SaveSettingsResult> => {
  try {
    settingsStore?.reset();
    log("Settings reset from the startup page.");
    return { ok: true, message: "已重置 Box 设置", snapshot: getSettingsSnapshot() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("pi-web-box:get-settings", () => getSettingsSnapshot());

ipcMain.handle("pi-web-box:save-settings", async (_event, input: BoxSettingsInput): Promise<SaveSettingsResult> => {
  try {
    settingsStore?.save(input);
    broadcastSettingsChange();
    log("Settings saved.");
    return { ok: true, message: "已保存", snapshot: getSettingsSnapshot() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("pi-web-box:reset-settings", async (): Promise<SaveSettingsResult> => {
  try {
    settingsStore?.reset();
    broadcastSettingsChange();
    log("Settings reset to defaults.");
    return { ok: true, message: "已恢复默认设置", snapshot: getSettingsSnapshot() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("pi-web-box:restart", async () => {
  log("Restart requested from settings.");
  await restartApplication();
});

ipcMain.handle("pi-web-box:close-settings", () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

// 手动重新同步标题栏：先让页面重新上报一次主题，再强制用内置色板兜底上色。
ipcMain.handle("pi-web-box:refresh-titlebar", async () => {
  currentThemeBackground = "";
  applyTitleBarTheme();
  try {
    await mainWindow?.webContents.executeJavaScript(
      "window.__piWebBoxThemeSync?.report?.();", true,
    );
  } catch (error) {
    log(`Could not re-report theme: ${error instanceof Error ? error.message : String(error)}`);
  }
  log("Title bar appearance refreshed manually.");
});

ipcMain.handle("pi-web-box:open-settings", () => {
  createSettingsWindow();
});

// Pi Web 页面回传主题：同步 Windows 原生标题栏，让界面保持一体感。
ipcMain.on("pi-web-box:report-theme", (_event, report: ThemeReport) => {
  updateTheme(report?.theme || "", report?.background || "");
});

// 旧版本通过环境变量传配置，这里把仍在使用的值固化成设置文件，
// 让老用户升级后能在设置界面里看到原有配置，不用重新理解一遍。
function applyEnvironmentBootstrap(store: SettingsStore): void {
  const current = store.get();
  const port = process.env.PI_WEB_BOX_PORT?.trim();
  const commandPath = process.env.PI_WEB_BOX_COMMAND?.trim();
  const nodePath = process.env.PI_WEB_BOX_NODE?.trim();
  if (!port && !commandPath && !nodePath) return;
  const next: BoxSettings = {
    ...current,
    piWeb: {
      ...current.piWeb,
      port: port || current.piWeb.port,
      commandPath: commandPath || current.piWeb.commandPath,
      nodePath: nodePath || current.piWeb.nodePath,
    },
  };
  try {
    store.save(next);
    log("Imported Pi Web settings from environment variables.");
  } catch (error) {
    log(`Could not persist bootstrap settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

app.setAppUserModelId(APP_ID);

if (gotLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    shortcutManager = new ShortcutManager(log);
    titleBarColorizer = new TitleBarColorizer(log);
    settingsStore = new SettingsStore(app.getPath("userData"));
    // 首次使用且存在环境变量配置时，把它们固化成设置文件，方便用户在界面里看到。
    if (!fs.existsSync(settingsStore.getFilePath())) applyEnvironmentBootstrap(settingsStore);
    createWindow();
    await applySystemTheme();
    nativeTheme.on("updated", () => {
      void applySystemTheme();
      applyTitleBarTheme();
      broadcastThemeToSettings();
    });
    app.on("activate", () => { if (!mainWindow) createWindow(); else showMainWindow(); });
  });

  // 开启托盘后关掉主窗口不应退出应用，只有显式退出才结束进程。
  app.on("window-all-closed", () => {
    if (settingsStore?.get().minimizeToTrayOnClose) return;
    app.quit();
  });

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
