export type StartupProgress = {
  title: string;
  message: string;
  detail?: string;
  percent?: number;
  indeterminate?: boolean;
};

export type ComponentVersions = {
  pi: string;
  piWeb: string;
  piWebBox: string;
};

// Box 设置里可编辑的 pi-web 配置项，字段名与设置文件保持一致。
export type BoxSettingsInput = {
  minimizeToTrayOnClose: boolean;
  piWeb: {
    port: string;
    hostname: string;
    allowedHosts: string;
    password: string;
    commandPath: string;
    nodePath: string;
  };
};

// 设置窗口一次拿到的完整状态，包含只读的展示信息。
export type SettingsSnapshot = {
  settings: BoxSettingsInput;
  settingsFilePath: string;
  commandLine: string;
  versions: ComponentVersions;
  // 当前 Pi Web 主题标识与中文名，用于展示和让设置窗口跟随配色。
  theme: string;
  themeLabel: string;
};

export type SaveSettingsResult = {
  ok: boolean;
  message: string;
  snapshot?: SettingsSnapshot;
};

// Pi Web 页面把当前主题回传给主进程，用于同步 Windows 标题栏配色。
export type ThemeReport = {
  theme: string;
  background: string;
};
