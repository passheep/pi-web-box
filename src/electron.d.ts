import type {
  BoxSettingsInput,
  EnhanceRequest,
  EnhanceResponse,
  ExtensionInfo,
  RunningState,
  SaveSettingsResult,
  SettingsSnapshot,
  StartupProgress,
  ThemeReport,
  UsageQuery,
} from "./contracts.js";
import type { ThemePalette } from "./themes.js";
import type { UsageOverview } from "./usage.js";

export {};

// 渲染进程侧看到的桥接对象类型，集中在这里声明，避免与 preload 重复定义。
declare global {
  interface Window {
    piWebBox: {
      // ── 启动页与错误页 ──
      getStatus: () => Promise<{ message: string; details: string; logPath: string }>;
      getStartupProgress: () => Promise<StartupProgress>;
      onStartupProgress: (callback: (progress: StartupProgress) => void) => void;
      retryStartup: () => Promise<void>;
      getLogPath: () => Promise<string>;
      openLog: () => Promise<void>;
      resetStartupConfig: () => Promise<SaveSettingsResult>;

      // ── Box 设置窗口 ──
      getSettings: () => Promise<SettingsSnapshot>;
      saveSettings: (input: BoxSettingsInput) => Promise<SaveSettingsResult>;
      resetSettings: () => Promise<SaveSettingsResult>;
      restartApp: () => Promise<void>;
      closeSettings: () => Promise<void>;
      refreshTitleBar: () => Promise<void>;
      onSettingsTheme: (callback: (payload: { palette: ThemePalette; theme: string }) => void) => void;
      checkUsageExtension: () => Promise<ExtensionInfo>;
      installUsageExtension: () => Promise<SaveSettingsResult>;
      openExternal: (url: string) => Promise<void>;

      // ── 用量统计窗口 ──
      queryUsage: (query: UsageQuery) => Promise<{ ok: boolean; overview?: UsageOverview; message?: string }>;

      // ── Pi Web 页面内注入脚本使用 ──
      openSettings: (pane?: string) => Promise<void>;
      openUsage: () => Promise<void>;
      reportTheme: (report: ThemeReport) => void;
      enhancePrompt: (request: EnhanceRequest) => Promise<EnhanceResponse>;
      getRunningState: () => Promise<RunningState>;

      // 设置窗口的启动数据（由主进程内联写入页面）。
      __PI_WEB_BOX_BOOT__?: {
        theme: string;
        label: string;
        isDark: boolean;
        palette: {
          background: string;
          panel: string;
          border: string;
          text: string;
          textMuted: string;
          accent: string;
        };
      };
      __PI_WEB_BOX_ICONS__?: { dark: string; light: string };
    };
  }
}
