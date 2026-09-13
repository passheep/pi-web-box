import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, screen, shell } from "electron";
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
import { resolveTitleBarBackground, TitleBarColorizer } from "./titlebar.js";
import {
  VersionManager,
  type InstalledVersionInfo,
  type PackageVersionInfo,
  type VersionProgress,
} from "./version-manager.js";
import { buildVersionPanelScript } from "./version-panel.js";
import { buildSettingsHtml } from "./settings-view.js";
import { buildUsageHtml } from "./usage-view.js";
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
let settingsWindow: BrowserWindow | undefined;
let usageWindow: BrowserWindow | undefined;
let trayController: TrayController | undefined;
let runningPoller: NodeJS.Timeout | undefined;
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
    // 悬浮按钮的图标随主题在深浅两版间切换，这里只预热，具体用哪张由页面决定。
    versionPanelIconDataUrl = readIconDataUrl("pi-logo-on-light.svg");
  }
  try {
    // 关于面板：版本、联系方式、设置与统计入口。
    await mainWindow.webContents.executeJavaScript(
      buildVersionPanelScript(buildPanelData(versionPanelIconDataUrl)), true,
    );
  } catch (error) {
    log(`Could not inject version panel: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    // 输入区：场景选择 + 提示词增强 + 回到底部。
    await mainWindow.webContents.executeJavaScript(
      buildEnhancePanelScript(buildEnhanceData()), true,
    );
  } catch (error) {
    log(`Could not inject enhance panel: ${error instanceof Error ? error.message : String(error)}`);
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
function buildPanelData(iconDataUrl: string) {
  const { provider, model } = settingsStore!.get().enhance;
  return {
    ...componentVersions,
    iconDataUrl,
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
  }).catch((error) => {
    log(`Could not open settings window: ${error instanceof Error ? error.message : String(error)}`);
  });
  settingsWindow.on("closed", () => { settingsWindow = undefined; });
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

  // 默认展示最近 30 天，与快捷按钮的默认口径保持一致。
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const isoDate = (date: Date) => toLocalDate(date.getTime());

  const html = buildUsageHtml({
    theme: palette.id,
    systemDark: nativeTheme.shouldUseDarkColors,
    iconDataUrl: "",
    rendererScript,
    defaultFrom: isoDate(start),
    defaultTo: isoDate(today),
  });

  usageWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: "Token 用量统计",
    icon: assetPath("pi-logo-adaptive.ico"),
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
  }).catch((error) => {
    log(`Could not open usage window: ${error instanceof Error ? error.message : String(error)}`);
  });
  usageWindow.on("closed", () => { usageWindow = undefined; });
}

/** 查询 pi-web 的运行中会话，供托盘角标与完成通知使用。 */
async function fetchRunningSessions(): Promise<{ count: number; sessions: Array<{ id: string; name: string }> }> {
  const port = manager?.getPort() || Number(process.env.PI_WEB_BOX_PORT) || 30141;
  try {
    const response = await net.fetch(`http://127.0.0.1:${port}/api/agent/running`);
    if (!response.ok) return { count: 0, sessions: [] };
    const data = (await response.json()) as { runningSessionIds?: unknown };
    const ids = Array.isArray(data.runningSessionIds) ? data.runningSessionIds.filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) return { count: 0, sessions: [] };
    // 会话名通过列表接口补齐，失败时用短 id 代替，不影响角标。
    const names = new Map<string, string>();
    try {
      const listResponse = await net.fetch(`http://127.0.0.1:${port}/api/sessions`);
      if (listResponse.ok) {
        const listData = (await listResponse.json()) as { sessions?: Array<{ id?: unknown; name?: unknown }> };
        for (const session of listData.sessions ?? []) {
          if (typeof session.id === "string" && typeof session.name === "string") names.set(session.id, session.name);
        }
      }
    } catch {
      /* 列表取不到时宁缺勿错 */
    }
    return { count: ids.length, sessions: ids.map((id) => ({ id, name: names.get(id) || id.slice(0, 8) })) };
  } catch {
    // 服务未就绪时视为空闲，避免启动阶段误报。
    return { count: 0, sessions: [] };
  }
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showMainWindow();
  try {
    await mainWindow.webContents.executeJavaScript(
      `window.location.href = window.location.origin + "/?session=" + encodeURIComponent(${JSON.stringify(sessionId)});`,
      true,
    );
  } catch (error) {
    log(`Could not open session from tray: ${error instanceof Error ? error.message : String(error)}`);
  }
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
      saveWindowBounds();
      mainWindow?.hide();
      // 主窗口进托盘时一并收起子窗口，避免留下孤立的设置/统计窗口。
      closeChildWindows();
      log("Main window hidden to tray.");
    }
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
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
    void injectVersionPanel();
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

ipcMain.handle("pi-web-box:open-settings", (_event, pane?: string) => {
  createSettingsWindow(typeof pane === "string" ? pane : undefined);
});

ipcMain.handle("pi-web-box:open-usage", () => {
  createUsageWindow();
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
    ensureTray();
    await applySystemTheme();
    startRunningPoller();
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
    // 第一次会拦下来做清理，清理完用 app.exit 退出，避免再次进入这里。
    if (isQuitting) return;
    isQuitting = true;
    if (runningPoller) {
      clearInterval(runningPoller);
      runningPoller = undefined;
    }
    trayController?.destroy();
    saveWindowBounds();
    event.preventDefault();
    void (async () => {
      await manager?.close();
      app.exit(0);
    })();
  });
}
