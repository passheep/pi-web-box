import { contextBridge, ipcRenderer } from "electron";
import type {
  BoxSettingsInput,
  EnhanceRequest,
  EnhanceResponse,
  SaveSettingsResult,
  SettingsSnapshot,
  StartupProgress,
  ThemeReport,
  UsageQuery,
} from "./contracts.js";
import type { ThemePalette } from "./themes.js";
import type { AttentionReport, DesktopState, DesktopTab, NoticeInput, NoticePage, NoticeQuery } from "./desktop-contracts.js";

// 不把 Electron 事件对象传入页面；返回注销函数，避免页面重复订阅后泄漏监听器。
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

// 预加载脚本同时作用在启动页、错误页、设置窗口、用量窗口和 Pi Web 页面上，
// 这里一次暴露完整的桥接对象，各页面只调用自己需要的部分。
contextBridge.exposeInMainWorld("piWebBox", {
  // ── 启动页与错误页 ──
  getStatus: () => ipcRenderer.invoke("pi-web-box:get-status"),
  getStartupProgress: () => ipcRenderer.invoke("pi-web-box:get-startup-progress"),
  onStartupProgress: (callback: (progress: StartupProgress) => void) =>
    subscribe("pi-web-box:startup-progress", callback),
  retryStartup: () => ipcRenderer.invoke("pi-web-box:retry"),
  getLogPath: () => ipcRenderer.invoke("pi-web-box:get-log-path"),
  openLog: () => ipcRenderer.invoke("pi-web-box:open-log"),
  resetStartupConfig: () => ipcRenderer.invoke("pi-web-box:reset-config"),

  // ── Box 设置窗口 ──
  getSettings: (): Promise<SettingsSnapshot> => ipcRenderer.invoke("pi-web-box:get-settings"),
  saveSettings: (input: BoxSettingsInput): Promise<SaveSettingsResult> =>
    ipcRenderer.invoke("pi-web-box:save-settings", input),
  resetSettings: (): Promise<SaveSettingsResult> => ipcRenderer.invoke("pi-web-box:reset-settings"),
  restartApp: () => ipcRenderer.invoke("pi-web-box:restart"),
  closeSettings: () => ipcRenderer.invoke("pi-web-box:close-settings"),
  refreshTitleBar: () => ipcRenderer.invoke("pi-web-box:refresh-titlebar"),
  onSettingsTheme: (callback: (payload: { palette: ThemePalette; theme: string }) => void) =>
    subscribe("pi-web-box:settings-theme", callback),
  // 用量记录插件的检测与一键安装
  checkUsageExtension: () => ipcRenderer.invoke("pi-web-box:check-usage-extension"),
  installUsageExtension: () => ipcRenderer.invoke("pi-web-box:install-usage-extension"),
  // 在系统浏览器中打开链接（内网地址、仓库等）
  openExternal: (url: string) => ipcRenderer.invoke("pi-web-box:open-external", url),

  // ── 用量统计窗口 ──
  queryUsage: (query: UsageQuery) => ipcRenderer.invoke("pi-web-box:query-usage", query),
  // 统计窗口宽度固定，但需按实际字体/DPI 微调，避免查询条件行折行。
  fitUsageWindow: (width: number) => ipcRenderer.invoke("pi-web-box:fit-usage-window", width),

  // ── 自绘标题栏 ──
  titleBarMinimize: () => ipcRenderer.invoke("pi-web-box:titlebar-minimize"),
  titleBarClose: () => ipcRenderer.invoke("pi-web-box:titlebar-close"),
  // 主窗口的标题栏额外提供最大化/还原。
  titleBarToggleMaximize: () => ipcRenderer.invoke("pi-web-box:titlebar-toggle-maximize"),

  // ── 桌面标签与消息中心 ──
  getDesktopState: (): Promise<DesktopState | null> => ipcRenderer.invoke("pi-web-box:get-desktop-state"),
  onDesktopState: (callback: (state: DesktopState) => void) =>
    subscribe("pi-web-box:desktop-state", callback),
  newTab: (): Promise<void> => ipcRenderer.invoke("pi-web-box:new-tab"),
  activateTab: (id: string): Promise<void> => ipcRenderer.invoke("pi-web-box:activate-tab", id),
  closeTab: (id: string): Promise<void> => ipcRenderer.invoke("pi-web-box:close-tab", id),
  reorderTab: (id: string, beforeId: string | null): Promise<void> =>
    ipcRenderer.invoke("pi-web-box:reorder-tab", id, beforeId),
  toggleMessages: (): Promise<void> => ipcRenderer.invoke("pi-web-box:toggle-messages"),
  queryNotices: (query: NoticeQuery): Promise<NoticePage> => ipcRenderer.invoke("pi-web-box:query-notices", query),
  markNoticesRead: (through: number): Promise<void> => ipcRenderer.invoke("pi-web-box:mark-notices-read", through),
  onNoticesChanged: (callback: (payload: { hasNew: boolean; unread: number }) => void) =>
    subscribe("pi-web-box:notices-changed", callback),
  onDesktopTheme: (callback: (palette: ThemePalette) => void) =>
    subscribe("pi-web-box:desktop-theme", callback),
  openNoticeSession: (sessionId: string): Promise<void> => ipcRenderer.invoke("pi-web-box:open-notice-session", sessionId),
  // 页面捕获仅单向上报，权限与数据校验由主进程负责。
  recordNotice: (notice: NoticeInput): void => ipcRenderer.send("pi-web-box:record-notice", notice),
  // 「等待用户输入」的弹窗状态：主进程据此闪任务栏/托盘并弹系统通知。
  reportAttention: (report: AttentionReport): void => ipcRenderer.send("pi-web-box:report-attention", report),
  reportTab: (report: Pick<DesktopTab, "sessionId"> & Partial<Pick<DesktopTab, "title">>): void =>
    ipcRenderer.send("pi-web-box:report-tab", report),

  // ── Pi Web 页面内注入脚本使用 ──
  openSettings: (pane?: string) => ipcRenderer.invoke("pi-web-box:open-settings", pane),
  openUsage: () => ipcRenderer.invoke("pi-web-box:open-usage"),
  reportTheme: (report: ThemeReport) => ipcRenderer.send("pi-web-box:report-theme", report),
  enhancePrompt: (request: EnhanceRequest): Promise<EnhanceResponse> =>
    ipcRenderer.invoke("pi-web-box:enhance-prompt", request),
  // 托盘角标轮询：页面内脚本不直接轮询，统一由主进程负责。
  getRunningState: () => ipcRenderer.invoke("pi-web-box:get-running-state"),
});

// 渲染进程侧的类型声明统一放在 electron.d.ts，这里只负责运行时桥接。
