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
import type { DesktopState, DesktopTab, NoticeInput, NoticePage, NoticeQuery } from "./desktop-contracts.js";

export {};

// 渲染进程侧看到的桥接对象类型，集中在这里声明，避免与 preload 重复定义。
declare global {
  interface Window {
    piWebBox: {
      // ── 启动页与错误页 ──
      getStatus: () => Promise<{ message: string; details: string; logPath: string }>;
      getStartupProgress: () => Promise<StartupProgress>;
      onStartupProgress: (callback: (progress: StartupProgress) => void) => () => void;
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
      onSettingsTheme: (callback: (payload: { palette: ThemePalette; theme: string }) => void) => () => void;
      checkUsageExtension: () => Promise<ExtensionInfo>;
      installUsageExtension: () => Promise<SaveSettingsResult>;
      openExternal: (url: string) => Promise<void>;

      // ── 用量统计窗口 ──
      queryUsage: (query: UsageQuery) => Promise<{ ok: boolean; overview?: UsageOverview; message?: string }>;
      // 按实际内容宽度微调统计窗口，避免查询条件行折行。
      fitUsageWindow: (width: number) => Promise<boolean>;
      // 自绘标题栏的窗口按钮。
      titleBarMinimize: () => Promise<void>;
      titleBarClose: () => Promise<void>;
      titleBarToggleMaximize: () => Promise<boolean>;

      // ── 桌面标签与消息中心（事件订阅返回注销函数） ──
      getDesktopState: () => Promise<DesktopState | null>;
      onDesktopState: (callback: (state: DesktopState) => void) => () => void;
      newTab: () => Promise<void>;
      activateTab: (id: string) => Promise<void>;
      closeTab: (id: string) => Promise<void>;
      reorderTab: (id: string, beforeId: string | null) => Promise<void>;
      toggleMessages: () => Promise<void>;
      queryNotices: (query: NoticeQuery) => Promise<NoticePage>;
      markNoticesRead: (through: number) => Promise<void>;
      onNoticesChanged: (callback: (payload: { hasNew: boolean; unread: number }) => void) => () => void;
      onDesktopTheme: (callback: (palette: ThemePalette) => void) => () => void;
      openNoticeSession: (sessionId: string) => Promise<void>;
      recordNotice: (notice: NoticeInput) => void;
      reportTab: (report: Pick<DesktopTab, "sessionId"> & Partial<Pick<DesktopTab, "title">>) => void;

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
