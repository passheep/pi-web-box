import { contextBridge, ipcRenderer } from "electron";
import type { BoxSettingsInput, SaveSettingsResult, SettingsSnapshot, StartupProgress, ThemeReport } from "./contracts.js";
import type { ThemePalette } from "./themes.js";

// 预加载脚本会同时作用在启动页、错误页、设置窗口和 Pi Web 页面上，
// 这里一次暴露完整的桥接对象，各页面只调用自己需要的部分。
contextBridge.exposeInMainWorld("piWebBox", {
  // ── 启动页与错误页 ──
  getStatus: () => ipcRenderer.invoke("pi-web-box:get-status"),
  getStartupProgress: () => ipcRenderer.invoke("pi-web-box:get-startup-progress"),
  onStartupProgress: (callback: (progress: StartupProgress) => void) => {
    ipcRenderer.on("pi-web-box:startup-progress", (_event, progress: StartupProgress) => callback(progress));
  },
  retryStartup: () => ipcRenderer.invoke("pi-web-box:retry"),
  getLogPath: () => ipcRenderer.invoke("pi-web-box:get-log-path"),
  openLog: () => ipcRenderer.invoke("pi-web-box:open-log"),
  // 启动页的重置入口：清空 Box 设置并回到自动探测启动命令。
  resetStartupConfig: () => ipcRenderer.invoke("pi-web-box:reset-config"),

  // ── Box 设置窗口 ──
  getSettings: (): Promise<SettingsSnapshot> => ipcRenderer.invoke("pi-web-box:get-settings"),
  saveSettings: (input: BoxSettingsInput): Promise<SaveSettingsResult> =>
    ipcRenderer.invoke("pi-web-box:save-settings", input),
  resetSettings: (): Promise<SaveSettingsResult> => ipcRenderer.invoke("pi-web-box:reset-settings"),
  restartApp: () => ipcRenderer.invoke("pi-web-box:restart"),
  closeSettings: () => ipcRenderer.invoke("pi-web-box:close-settings"),
  // 手动重新同步一次 Windows 标题栏配色，兜底用。
  refreshTitleBar: () => ipcRenderer.invoke("pi-web-box:refresh-titlebar"),
  onSettingsTheme: (callback: (payload: { palette: ThemePalette; theme: string }) => void) => {
    ipcRenderer.on("pi-web-box:settings-theme", (_event, payload) => callback(payload));
  },

  // ── Pi Web 页面内注入脚本使用 ──
  openSettings: () => ipcRenderer.invoke("pi-web-box:open-settings"),
  reportTheme: (report: ThemeReport) => ipcRenderer.send("pi-web-box:report-theme", report),
});
