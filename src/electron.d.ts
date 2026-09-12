import type {
  BoxSettingsInput,
  SaveSettingsResult,
  SettingsSnapshot,
  StartupProgress,
  ThemeReport,
} from "./contracts.js";
import type { ThemePalette } from "./themes.js";

export {};

// 渲染进程侧看到的桥接对象类型，集中在这里声明，避免与 preload 重复定义。
declare global {
  interface Window {
    piWebBox: {
      // 启动页与错误页
      getStatus: () => Promise<{ message: string; details: string; logPath: string }>;
      getStartupProgress: () => Promise<StartupProgress>;
      onStartupProgress: (callback: (progress: StartupProgress) => void) => void;
      retryStartup: () => Promise<void>;
      getLogPath: () => Promise<string>;
      openLog: () => Promise<void>;
      resetStartupConfig: () => Promise<SaveSettingsResult>;

      // Box 设置窗口
      getSettings: () => Promise<SettingsSnapshot>;
      saveSettings: (input: BoxSettingsInput) => Promise<SaveSettingsResult>;
      resetSettings: () => Promise<SaveSettingsResult>;
      restartApp: () => Promise<void>;
      closeSettings: () => Promise<void>;
      refreshTitleBar: () => Promise<void>;
      onSettingsTheme: (callback: (payload: { palette: ThemePalette; theme: string }) => void) => void;

      // Pi Web 页面内注入脚本使用
      openSettings: () => Promise<void>;
      reportTheme: (report: ThemeReport) => void;
    };
  }
}
