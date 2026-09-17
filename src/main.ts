import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type {
  BoxSettingsInput,
  ComponentVersions,
  EnhanceRequest,
  EnhanceResponse,
  ProviderOption,
  RunningState,
  SaveSettingsResult,
  SettingsSnapshot,
  StartupProgress,
  ThemeReport,
  UsageQuery,
} from "./contracts.js";
import { PiWebProcessManager } from "./pi-web-process.js";
import { isLoopbackHostname, SettingsStore, type BoxSettings } from "./config.js";
import { ShortcutManager, type IconTheme } from "./shortcut.js";
import { getPalette, isKnownTheme } from "./themes.js";
import { DesktopTabs, isServiceUrl } from "./desktop-tabs.js";
import { NoticeStore } from "./notice-store.js";
import { fetchSessionStatus, closeSessionStatusAgents } from "./session-status.js";
import type { NoticeInput, NoticeQuery } from "./desktop-contracts.js";
import {
  VersionManager,
  type InstalledVersionInfo,
  type PackageVersionInfo,
  type VersionProgress,
} from "./version-manager.js";
import { buildVersionPanelScript } from "./version-panel.js";
import { buildSettingsHtml } from "./settings-view.js";
import { buildUsageHtml, usageWindowWidth } from "./usage-view.js";
import { buildEnhancePanelScript } from "./enhance-panel.js";
import { buildUsageOverview, readUsageRecords, toLocalDate, usageLogPath } from "./usage.js";
import { checkUsageLogExtension, installUsageLogExtension, piAgentDirectory } from "./extensions.js";
import { enhancePrompt, readProviders, SCENE_PROMPTS } from "./enhance.js";
import { TrayController, trayIconPath } from "./tray.js";

const APP_ID = "com.piweb.box";
const GITHUB_URL = "https://github.com/passheep/pi-web-box";
const CONTACT_QQ = "903081605";
// 运行状态轮询间隔。接口很轻，但仍保持一个不打扰的节奏。
const RUNNING_POLL_MS = 4_000;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | undefined;
let desktopTabs: DesktopTabs | undefined;
let noticeStore: NoticeStore | undefined;
let settingsWindow: BrowserWindow | undefined;
let usageWindow: BrowserWindow | undefined;
let trayController: TrayController | undefined;
let runningPoller: NodeJS.Timeout | undefined;
let manager: PiWebProcessManager | undefined;
let shortcutManager: ShortcutManager | undefined;
let settingsStore: SettingsStore | undefined;
let startupInFlight: Promise<void> | undefined;
let updateCheckCompleted = false;
let isQuitting = false;
let currentTheme = "";
// 记录 Pi Web 页面实测到的标题栏背景色（顶栏的 --bg-panel），标题栏优先生效该值。
let currentThemeBackground = "";
// 设置窗口打开时希望定位到的页签，用于从关于面板直接进入增强设置。
let settingsInitialPane = "appearance";
// 最近一次运行状态，供界面查询。
let runningState: RunningState = { runningCount: 0, justFinished: false };
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
  try {
    mainWindow?.setIcon(assetPath("pi-logo-adaptive.ico"));
  } catch (error) {
    // 图标缺失不应阻断启动，记录下来继续。
    log(`Could not apply window icon: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  desktopTabs?.dispose();
  desktopTabs = undefined;
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

async function injectVersionPanel(contents = desktopTabs?.active()?.view.webContents): Promise<void> {
  if (!contents || contents.isDestroyed() || !desktopTabs || !isServiceUrl(contents.getURL(), desktopTabs.origin)) return;
  try {
    // 关于面板：版本、联系方式、设置与统计入口。
    await contents.executeJavaScript(
      buildVersionPanelScript(buildPanelData()), true,
    );
  } catch (error) {
    log(`Could not inject version panel: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    // 输入区：场景选择 + 提示词增强 + 回到底部。
    await contents.executeJavaScript(
      buildEnhancePanelScript(buildEnhanceData()), true,
    );
  } catch (error) {
    log(`Could not inject enhance panel: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 把当前主题应用到主窗口页面内的自绘标题栏。
 * DWM 着色在 Electron 窗口上不生效（调用成功但系统忽略），
 * 所以主窗口也改为页面内绘制，颜色直接跟随 Pi Web 主题。
 */
async function applyTitleBarTheme(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("pi-web-box:desktop-theme", getPalette(currentTheme, nativeTheme.shouldUseDarkColors));
}

/**
 * 子窗口（设置 / 统计）使用页面自绘的标题栏，
 * 这里把主题色板推给它们，颜色由页面自己的变量控制。
 */
function applyChildTitleBarTheme(): void {
  const palette = getPalette(currentTheme, nativeTheme.shouldUseDarkColors);
  const payload = { palette, theme: currentTheme || palette.id };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("pi-web-box:settings-theme", payload);
  }
  if (usageWindow && !usageWindow.isDestroyed()) {
    usageWindow.webContents.send("pi-web-box:settings-theme", payload);
  }
}

/** 通知设置窗口跟随 Pi Web 的最新主题。 */
function broadcastThemeToSettings(): void {
  // 子窗口的自绘标题栏依赖页面里的主题变量，每次主题变化都要推送一次。
  applyChildTitleBarTheme();
}

function updateTheme(theme: string, background: string): void {
  const normalized = isKnownTheme(theme) ? theme : "";
  if (!normalized && !background) return;
  currentTheme = normalized || currentTheme;
  currentThemeBackground = background || currentThemeBackground;
  void applyTitleBarTheme();
  broadcastThemeToSettings();
}

/** 取本机内网 IPv4 地址，用于在设置里展示局域网访问地址。 */
function getLanAddress(): string {
  const store = settingsStore!;
  const { hostname, port } = store.get().piWeb;
  // 只在真正监听了非回环地址时才给出地址，否则那个地址根本连不上。
  if (isLoopbackHostname(hostname)) return "";
  // 优先物理网卡，跳过虚拟网卡常见的地址段。
  const candidates: Array<{ name: string; address: string; priority: number }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const priority = /wi-?fi|wlan|无线/i.test(name) ? 0 : /ethernet|以太/i.test(name) ? 1 : 2;
      candidates.push({ name, address: entry.address, priority });
    }
  }
  const picked = candidates.sort((left, right) => left.priority - right.priority)[0];
  if (!picked) return "";
  return `http://${picked.address}:${port.trim() || "30141"}`;
}

/** 读取 pi 已配置的供应商与模型，供设置界面选择增强模型。 */
function getProviderOptions(): ProviderOption[] {
  return readProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    hasApiKey: provider.hasApiKey,
    models: provider.models.map((model) => ({ id: model.id, name: model.name })),
  }));
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
    providers: getProviderOptions(),
    usageExtension: usageExtensionInfo(),
    lanAddress: getLanAddress(),
    about: {
      version: app.getVersion(),
      github: GITHUB_URL,
      qq: CONTACT_QQ,
      electron: process.versions.electron || "-",
      node: process.versions.node || "-",
      chrome: process.versions.chrome || "-",
    },
  };
}

/** 组装注入到页面里的关于面板数据。 */
function buildPanelData() {
  const { provider, model } = settingsStore!.get().enhance;
  return {
    ...componentVersions,
    darkIconDataUrl: readIconDataUrl("pi-logo-on-dark.svg"),
    lightIconDataUrl: readIconDataUrl("pi-logo-on-light.svg"),
    github: GITHUB_URL,
    qq: CONTACT_QQ,
    enhanceConfigured: !!(provider && model),
  };
}

/** 组装提示词增强控件需要的数据。 */
function buildEnhanceData() {
  const { provider, model } = settingsStore!.get().enhance;
  return {
    palette: getPalette(currentTheme, nativeTheme.shouldUseDarkColors),
    configured: !!(provider && model),
    scenes: Object.entries(SCENE_PROMPTS).map(([id, scene]) => ({ id, label: scene.label })),
    defaultScene: "general",
  };
}

/** 查询 pi-usage-log 是否已安装。开发环境下内置扩展在应用根目录。 */
function usageExtensionInfo() {
  return checkUsageLogExtension(process.resourcesPath, app.isPackaged, app.getAppPath());
}

/** 解析用量查询区间，日期非法时回退到最近 30 天。 */
function resolveUsageRange(query: UsageQuery): { from: string; to: string } {
  const today = new Date();
  const isoDate = (date: Date) => toLocalDate(date.getTime());
  const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  let to = isDate(query?.to) ? query.to : isoDate(today);
  let from = isDate(query?.from) ? query.from : "";
  if (!from) {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    from = isoDate(start);
  }
  // 起止写反时自动交换，避免出现空结果让人困惑。
  if (from > to) [from, to] = [to, from];
  return { from, to };
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

function createSettingsWindow(pane?: string): void {
  if (pane) settingsInitialPane = pane;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 700,
    minHeight: 520,
    show: false,
    title: "Pi Web Box 设置",
    icon: assetPath("pi-logo-adaptive.ico"),
    parent: mainWindow,
    // 子窗口属于主窗口的一部分，不单独占任务栏位置。
    skipTaskbar: true,
    // 不用 Windows 原生标题栏：改用页面自绘的标题栏，
    // 颜色完全跟随 Pi Web 主题，不会出现系统默认灰。
    frame: false,
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
    rendererScript,
    darkIconDataUrl: readIconDataUrl("pi-logo-on-dark.svg"),
    lightIconDataUrl: readIconDataUrl("pi-logo-on-light.svg"),
  });
  // 设置页按当前主题动态生成，写入 userData 后加载，避免改动打包产物里的静态文件。
  const htmlPath = path.join(app.getPath("userData"), "settings.html");
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, "utf8");
  settingsWindow.loadFile(htmlPath).then(() => {
    // 带页签参数打开时直接切过去，例如从关于面板点「提示词增强」。
    if (settingsInitialPane && settingsInitialPane !== "appearance") {
      const pane = settingsInitialPane.replace(/[^a-z]/gi, "");
      void settingsWindow?.webContents.executeJavaScript(
        `document.querySelector('[data-pane="${pane}"]')?.click();`, true,
      );
    }
    settingsInitialPane = "appearance";
    settingsWindow?.show();
    settingsWindow?.focus();
    // 窗口显示后再着色：此时句柄已就绪，不会出现默认色一闪而过。
    applyChildTitleBarTheme();
  }).catch((error) => {
    log(`Could not open settings window: ${error instanceof Error ? error.message : String(error)}`);
  });
  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
  });
}

/** 创建（或复用）Token 用量统计窗口。 */
function createUsageWindow(): void {
  if (usageWindow && !usageWindow.isDestroyed()) {
    usageWindow.show();
    usageWindow.focus();
    return;
  }
  const palette = getPalette(currentTheme, nativeTheme.shouldUseDarkColors);
  const rendererScript = fs.readFileSync(appFilePath(path.join("build", "usage-renderer.js")), "utf8");

  // 默认展示今天，符合“先看今天用了多少”的习惯。
  const today = new Date();
  const isoDate = (date: Date) => toLocalDate(date.getTime());

  const html = buildUsageHtml({
    theme: palette.id,
    systemDark: nativeTheme.shouldUseDarkColors,
    rendererScript,
    darkIconDataUrl: readIconDataUrl("pi-logo-on-dark.svg"),
    lightIconDataUrl: readIconDataUrl("pi-logo-on-light.svg"),
    defaultFrom: isoDate(today),
    defaultTo: isoDate(today),
  });

  usageWindow = new BrowserWindow({
    // 宽度按查询条件行计算，保证筛选控件不换行。
    width: usageWindowWidth(),
    height: 780,
    // 宽度固定，避免手动缩放后布局错位。
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Token 用量统计",
    icon: assetPath("pi-logo-adaptive.ico"),
    parent: mainWindow,
    // 与设置窗口一致：作为子窗口不单独占任务栏位置。
    skipTaskbar: true,
    // 不用 Windows 原生标题栏，改用页面自绘的标题栏。
    frame: false,
    backgroundColor: palette.background,
    autoHideMenuBar: true,
    webPreferences: {
      preload: appFilePath(path.join("build", "preload.js")),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  usageWindow.setMenu(null);
  usageWindow.setMenuBarVisibility(false);
  usageWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  usageWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  const htmlPath = path.join(app.getPath("userData"), "usage.html");
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, "utf8");
  usageWindow.loadFile(htmlPath).then(() => {
    usageWindow?.show();
    usageWindow?.focus();
    // 与设置窗口一致，显示后重新着色标题栏。
    applyChildTitleBarTheme();
  }).catch((error) => {
    log(`Could not open usage window: ${error instanceof Error ? error.message : String(error)}`);
  });
  usageWindow.on("closed", () => {
    usageWindow = undefined;
  });
}

let sessionPollInFlight: Promise<{ count: number; sessions: Array<{ id: string; name: string }> }> | undefined;
let cachedSessionNames = new Map<string, string>();
let cachedRunningIds: string[] = [];

/** 名称、标签圆环、托盘共用一次查询；独立 Node 连接不与页面 SSE 争抢六条连接。 */
async function fetchRunningSessions(): Promise<{ count: number; sessions: Array<{ id: string; name: string }> }> {
  if (sessionPollInFlight) return sessionPollInFlight;
  sessionPollInFlight = (async () => {
    const port = manager?.getPort() || Number(process.env.PI_WEB_BOX_PORT) || 30141;
    const origin = desktopTabs?.origin || `http://127.0.0.1:${port}`;
    const status = await fetchSessionStatus(origin, settingsStore?.get().piWeb.password)
      .catch(() => ({ names: null, runningIds: null }));
    if (status.names) cachedSessionNames = status.names;
    if (status.runningIds) cachedRunningIds = status.runningIds;
    desktopTabs?.syncSessions(status.names, status.runningIds);
    return {
      count: cachedRunningIds.length,
      sessions: cachedRunningIds.map((id) => ({ id, name: cachedSessionNames.get(id) || id.slice(0, 8) })),
    };
  })().finally(() => { sessionPollInFlight = undefined; });
  return sessionPollInFlight;
}

/** 启动运行状态轮询：驱动托盘角标与任务完成通知。 */
function startRunningPoller(): void {
  if (runningPoller) return;
  runningPoller = setInterval(() => { void pollRunningState(); }, RUNNING_POLL_MS);
}

async function pollRunningState(): Promise<void> {
  const { count, sessions } = await fetchRunningSessions();
  if (!trayController) {
    runningState = { runningCount: count, justFinished: false };
    return;
  }
  const { justFinished } = trayController.updateRunningState(count, sessions);
  runningState = { runningCount: count, justFinished };
}

/** 在主窗口内加载指定会话，供托盘菜单跳转使用。 */
async function openSessionInWindow(sessionId: string): Promise<void> {
  showMainWindow();
  desktopTabs?.openSession(sessionId);
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
      await loadLocal("desktop.html");
      desktopTabs?.dispose();
      desktopTabs = new DesktopTabs(mainWindow, new URL(result.url).origin,
        appFilePath(path.join("build", "page-preload.js")), setupTabContents, publishDesktopState);
      desktopTabs.create(result.url);
      void pollRunningState();
      mainWindow.show();
      mainWindow.focus();
    } catch (error) {
      showError(error);
    }
  })().finally(() => { startupInFlight = undefined; });
  return startupInFlight;
}

/** 公共标题栏与子窗口只跟随当前标签的主题。 */
function publishDesktopState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (desktopTabs) mainWindow.webContents.send("pi-web-box:desktop-state", desktopTabs.snapshot(noticeStore?.unreadCount() ?? 0));
  const theme = desktopTabs?.active()?.theme;
  if (theme && theme.theme !== currentTheme) updateTheme(theme.theme, theme.background);
  else void applyTitleBarTheme();
}

/** 保留原页面增强、外链行为和键盘操作，不在每个标签里重复绘制标题栏。 */
function setupTabContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (desktopTabs && isServiceUrl(url, desktopTabs.origin)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  contents.on("did-finish-load", () => void injectVersionPanel(contents));
  contents.on("before-input-event", handleDesktopShortcut);
}

/** 快捷键只切换页面；关闭标签不终止后台任务。 */
function handleDesktopShortcut(event: Electron.Event, input: Electron.Input): void {
  if (!desktopTabs || input.type !== "keyDown") return;
  const key = input.key.toLowerCase();
  if (input.control && key === "t") { event.preventDefault(); desktopTabs.create(); }
  else if (input.control && key === "w") { event.preventDefault(); const tab = desktopTabs.active(); if (tab) desktopTabs.close(tab.id); }
  else if (input.control && key === "tab") {
    event.preventDefault();
    const tabs = desktopTabs.all();
    const index = tabs.findIndex((tab) => tab.id === desktopTabs?.active()?.id);
    const next = tabs[(index + (input.shift ? -1 : 1) + tabs.length) % tabs.length];
    if (next) desktopTabs.activate(next.id);
  } else if (key === "f5" || (input.control && key === "r")) {
    event.preventDefault(); desktopTabs.active()?.view.webContents.reload();
  }
}

function createWindow(): void {
  // 任务栏和窗口标题栏统一使用高对比度图标，避免 Windows 深色任务栏中黑色 Pi 不可见。
  const icon = assetPath("pi-logo-adaptive.ico");
  // 还原上次的窗口位置与尺寸，并确保窗口落在可见区域内。
  const saved = settingsStore?.get().window ?? {
    x: undefined,
    y: undefined,
    width: 1440,
    height: 920,
    maximized: false,
  };
  mainWindow = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Pi Web Box",
    icon,
    // 不用 Windows 原生标题栏：DWM 着色在 Electron 窗口上不生效，
    // 改为在页面内自绘标题栏，与设置/统计窗口保持一致。
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18181b" : "#f7f8fa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: appFilePath(path.join("build", "preload.js")),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved.maximized) mainWindow.maximize();
  // 位置可能来自已拔掉的显示器，这里校验一次并回退到居中。
  ensureWindowOnScreen(mainWindow);
  // 窗口尺寸与位置变化时延迟保存，避免拖动过程中频繁写文件。
  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSaveBounds = () => {
    // 主进程没有 window 全局对象，定时器直接用 clearTimeout。
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowBounds(), 600);
  };
  mainWindow.on("resize", scheduleSaveBounds);
  mainWindow.on("move", scheduleSaveBounds);
  mainWindow.on("maximize", scheduleSaveBounds);
  mainWindow.on("unmaximize", scheduleSaveBounds);
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on("before-input-event", handleDesktopShortcut);
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
    // 页面加载完成后立刻画出自绘标题栏；启动时若是最大化状态，
    // 也要把按钮图标切换到「向下还原」。
    setTimeout(() => {
      void applyTitleBarTheme().then(() => notifyMaximizeState());
    }, 300);
  });
  // 关闭按钮按设置决定是退出还是留在托盘。
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    if (settingsStore?.get().minimizeToTrayOnClose) {
      event.preventDefault();
      saveWindowBounds();
      mainWindow?.hide();
      // 主窗口进托盘时一并收起子窗口，避免留下孤立的设置/统计窗口。
      closeChildWindows();
      log("Main window hidden to tray.");
    }
  });
  mainWindow.on("closed", () => { desktopTabs?.dispose(); desktopTabs = undefined; mainWindow = undefined; });
  mainWindow.on("resize", () => desktopTabs?.layout());
  // 恢复窗口时补一次有效布局，不依赖 Windows 是否同时发出 resize。
  mainWindow.on("restore", () => desktopTabs?.layout());
  // 主窗口使用页面自绘标题栏，重新获得焦点时补画一次：
  // 主题上报可能晚于页面渲染，这里保证颜色始终与页面一致。
  mainWindow.on("focus", () => void applyTitleBarTheme());
  // 最大化状态变化时通知页面切换按钮图标（最大化 / 向下还原）。
  const notifyMaximizeState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    publishDesktopState();
  };
  mainWindow.on("maximize", notifyMaximizeState);
  mainWindow.on("unmaximize", notifyMaximizeState);
  void startPiWeb();
}

/** 保存当前窗口的位置与尺寸（含最大化状态）。 */
function saveWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !settingsStore) return;
  try {
    const saved = settingsStore.get().window;
    const maximized = mainWindow.isMaximized();
    // 最大化时窗口尺寸是屏幕尺寸，还原时会失效，
    // 因此只记录标志位，位置与尺寸沿用上次保存的值。
    const bounds = maximized ? saved : mainWindow.getNormalBounds();
    settingsStore.saveWindowBounds({
      x: maximized ? saved.x : bounds.x,
      y: maximized ? saved.y : bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    });
  } catch (error) {
    log(`Could not save window bounds: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 确保窗口在可见屏幕内，否则居中显示，避免窗口“跑出”屏幕。 */
function ensureWindowOnScreen(targetWindow: BrowserWindow): void {
  try {
    const bounds = targetWindow.getBounds();
    const displays = screen.getAllDisplays();
    const visible = displays.some((display) => {
      const area = display.workArea;
      return (
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
      );
    });
    if (!visible) targetWindow.center();
  } catch {
    // 屏幕信息取不到时不动窗口，交给系统默认行为。
  }
}

/** 主窗口进托盘时收起子窗口。 */
function closeChildWindows(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  if (usageWindow && !usageWindow.isDestroyed()) usageWindow.close();
}

/** 按设置开关托盘图标。 */
function applyTrayVisibility(): void {
  const visible = settingsStore?.get().showTrayIcon ?? true;
  trayController?.setVisible(visible);
}

/** 创建托盘控制器。角标与通知由运行状态轮询驱动。 */
function ensureTray(): void {
  if (trayController) {
    applyTrayVisibility();
    return;
  }
  trayController = new TrayController(
    trayIconPath(process.resourcesPath, app.isPackaged, app.getAppPath()),
    log,
    {
      showMainWindow,
      openSettings: () => createSettingsWindow(),
      openUsage: () => createUsageWindow(),
      quit: () => { isQuitting = true; app.quit(); },
      recentSessions: async () => (await fetchRunningSessions()).sessions,
      openSession: (id: string) => void openSessionInWindow(id),
    },
  );
  applyTrayVisibility();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 桌面管理接口仅允许本地壳调用，页面只能上报自己的会话与通知。 */
function isDesktopSender(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame;
}
ipcMain.handle("pi-web-box:get-desktop-state", (event) => {
  if (!isDesktopSender(event)) return null;
  return desktopTabs?.snapshot(noticeStore?.unreadCount() ?? 0) ?? null;
});
ipcMain.handle("pi-web-box:new-tab", (event) => { if (isDesktopSender(event)) desktopTabs?.create(); });
ipcMain.handle("pi-web-box:activate-tab", (event, id: string) => { if (isDesktopSender(event)) desktopTabs?.activate(id); });
ipcMain.handle("pi-web-box:close-tab", (event, id: string) => { if (isDesktopSender(event)) desktopTabs?.close(id); });
ipcMain.handle("pi-web-box:reorder-tab", (event, id: string, beforeId: string | null) => { if (isDesktopSender(event)) desktopTabs?.reorder(id, beforeId); });
ipcMain.handle("pi-web-box:toggle-messages", (event) => { if (isDesktopSender(event)) desktopTabs?.togglePanel(); });
ipcMain.handle("pi-web-box:query-notices", (event, query: NoticeQuery) => {
  if (!isDesktopSender(event)) throw new Error("无权查询消息");
  if (!noticeStore) throw new Error("消息数据库不可用，请查看日志");
  return noticeStore.query(query);
});
ipcMain.handle("pi-web-box:mark-notices-read", (event, through: number) => {
  if (!isDesktopSender(event) || !Number.isSafeInteger(through) || through < 0) return;
  noticeStore?.markRead(through); publishDesktopState();
});
ipcMain.handle("pi-web-box:open-notice-session", (event, id: string) => {
  if (isDesktopSender(event) && typeof id === "string" && id.length <= 200) void openSessionInWindow(id);
});
ipcMain.on("pi-web-box:report-tab", (event, report) => {
  if (event.senderFrame !== event.sender.mainFrame) return;
  desktopTabs?.report(event.sender, report);
});
ipcMain.on("pi-web-box:record-notice", (event, input: NoticeInput) => {
  const tab = desktopTabs?.fromContents(event.sender);
  if (!tab || event.senderFrame !== event.sender.mainFrame || !desktopTabs || !isServiceUrl(event.sender.getURL(), desktopTabs.origin)) return;
  try {
    const sessionId = input?.sessionId || tab.sessionId;
    const sessionName = cachedSessionNames.get(sessionId) || (sessionId === tab.sessionId ? tab.title : "");
    if (noticeStore?.add({ ...input, sessionName, sessionId })) {
      mainWindow?.webContents.send("pi-web-box:notices-changed", { hasNew: true, unread: noticeStore.unreadCount() });
      publishDesktopState();
    }
  } catch (error) { log(`保存通知失败：${String(error)}`); }
});

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
    // 托盘开关与增强模型变更后立即生效，无需重启。
    applyTrayVisibility();
    for (const tab of desktopTabs?.all() ?? []) void injectVersionPanel(tab.view.webContents);
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
    applyTrayVisibility();
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

// 手动重新同步标题栏：让页面重新上报一次主题，再把三个窗口的标题栏都画一遍。
ipcMain.handle("pi-web-box:refresh-titlebar", async () => {
  currentThemeBackground = "";
  await applyTitleBarTheme();
  try {
    await desktopTabs?.active()?.view.webContents.executeJavaScript(
      "window.__piWebBoxThemeSync?.report?.();", true,
    );
  } catch (error) {
    log(`Could not re-report theme: ${error instanceof Error ? error.message : String(error)}`);
  }
  applyChildTitleBarTheme();
  log("Title bar appearance refreshed manually.");
});

ipcMain.handle("pi-web-box:open-settings", (_event, pane?: string) => {
  createSettingsWindow(typeof pane === "string" ? pane : undefined);
});

ipcMain.handle("pi-web-box:open-usage", () => {
  createUsageWindow();
});

// 统计窗口加载完成后按实际内容宽度微调一次：
// 不同 DPI 与字体下查询条件行的实际宽度会变，固定值容易折行。
ipcMain.handle("pi-web-box:fit-usage-window", (_event, width: unknown) => {
  if (!usageWindow || usageWindow.isDestroyed()) return false;
  const wanted = Math.round(Number(width));
  if (!Number.isFinite(wanted) || wanted < 640 || wanted > 2400) return false;
  const [current] = usageWindow.getSize();
  // 只在确实需要变宽时调整，避免反复设置尺寸引起抖动。
  if (Math.abs(current - wanted) < 4) return true;
  usageWindow.setContentSize(wanted, usageWindow.getContentSize()[1]);
  log(`Usage window width adjusted to ${wanted}px.`);
  return true;
});

/** 自绘标题栏的窗口按钮：作用于发起请求的那个窗口。 */
function windowFromEvent(event: { sender: Electron.WebContents }): BrowserWindow | undefined {
  const target = desktopTabs?.fromContents(event.sender) ? mainWindow : BrowserWindow.fromWebContents(event.sender);
  return target && !target.isDestroyed() ? target : undefined;
}

ipcMain.handle("pi-web-box:titlebar-minimize", (event) => {
  windowFromEvent(event)?.minimize();
});

ipcMain.handle("pi-web-box:titlebar-close", (event) => {
  windowFromEvent(event)?.close();
});

ipcMain.handle("pi-web-box:titlebar-toggle-maximize", (event) => {
  const target = windowFromEvent(event);
  if (!target) return false;
  // 设置/统计窗口不可最大化，这里只对主窗口生效。
  if (target.isMaximizable()) {
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
  }
  return target.isMaximized();
});

// 用量统计查询：主进程直接读日志文件，渲染进程不接触文件系统。
ipcMain.handle("pi-web-box:query-usage", async (_event, query: UsageQuery) => {
  try {
    const logFile = usageLogPath();
    const records = readUsageRecords(logFile);
    const range = resolveUsageRange(query);
    // 按模型筛选时只对区间汇总生效，热力图仍展示全部模型的总量。
    const filtered = query?.model
      ? records.filter((record) => record.model === query.model)
      : records;
    const overview = buildUsageOverview(filtered, { from: range.from, to: range.to, logFile });
    // 热力图始终基于全部记录，避免筛选模型后绿格子变得不可比。
    if (query?.model) {
      const full = buildUsageOverview(records, { from: range.from, to: range.to, logFile });
      overview.heatmap = full.heatmap;
      overview.thresholds = full.thresholds;
    }
    return { ok: true, overview };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

// 检测与一键安装 pi-usage-log 插件。
ipcMain.handle("pi-web-box:check-usage-extension", () => usageExtensionInfo());

ipcMain.handle("pi-web-box:install-usage-extension", async (): Promise<SaveSettingsResult> => {
  const result = await installUsageLogExtension(process.resourcesPath, app.isPackaged, app.getAppPath());
  if (result.ok) log(`Installed usage extension into ${piAgentDirectory()}.`);
  else log(`Could not install usage extension: ${result.message}`);
  return {
    ok: result.ok,
    message: result.message,
    snapshot: result.ok ? getSettingsSnapshot() : undefined,
  };
});

// 提示词增强：在主进程发起请求，API Key 不进入渲染进程。
ipcMain.handle("pi-web-box:enhance-prompt", async (_event, request: EnhanceRequest): Promise<EnhanceResponse> => {
  const store = settingsStore!;
  const { provider, model } = store.get().enhance;
  if (!provider || !model) {
    return { ok: false, message: "请先在 Box 设置的「提示词增强」中选择模型。" };
  }
  const result = await enhancePrompt({
    provider,
    model,
    scene: typeof request?.scene === "string" ? request.scene : "general",
    draft: typeof request?.draft === "string" ? request.draft : "",
  });
  if (!result.ok) log(`Prompt enhancement failed: ${result.message}`);
  return result.ok ? { ok: true, text: result.text } : { ok: false, message: result.message };
});

ipcMain.handle("pi-web-box:get-running-state", () => runningState);

ipcMain.handle("pi-web-box:open-external", async (_event, url: string) => {
  // 只放行 http/https，避免被页面利用去执行本地协议。
  if (typeof url === "string" && /^https?:\/\//i.test(url)) await shell.openExternal(url);
});

// Pi Web 页面回传主题：同步 Windows 原生标题栏，让界面保持一体感。
ipcMain.on("pi-web-box:report-theme", (event, report: ThemeReport) => {
  const tab = desktopTabs?.fromContents(event.sender);
  if (!tab || typeof report?.theme !== "string" || typeof report?.background !== "string") return;
  tab.theme = { theme: report.theme, background: report.background };
  if (tab.id === desktopTabs?.active()?.id) updateTheme(report.theme, report.background);
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
    settingsStore = new SettingsStore(app.getPath("userData"));
    try { noticeStore = new NoticeStore(path.join(app.getPath("userData"), "notifications.sqlite")); }
    catch (error) { log(`消息数据库打开失败：${String(error)}`); }
    // 首次使用且存在环境变量配置时，把它们固化成设置文件，方便用户在界面里看到。
    if (!fs.existsSync(settingsStore.getFilePath())) applyEnvironmentBootstrap(settingsStore);
    createWindow();
    ensureTray();
    await applySystemTheme();
    startRunningPoller();
    nativeTheme.on("updated", () => {
      void applySystemTheme();
      void applyTitleBarTheme();
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
    // 第一次会拦下来做清理，清理完用 app.exit 退出，避免再次进入这里。
    if (isQuitting) return;
    isQuitting = true;
    if (runningPoller) {
      clearInterval(runningPoller);
      runningPoller = undefined;
    }
    trayController?.destroy();
    closeSessionStatusAgents();
    saveWindowBounds();
    event.preventDefault();
    void (async () => {
      await manager?.close();
      app.exit(0);
    })();
  });
}
