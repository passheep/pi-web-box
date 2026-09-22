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

// Box 设置里可编辑的字段，结构与设置文件保持一致。
export type BoxSettingsInput = {
  minimizeToTrayOnClose: boolean;
  showTrayIcon: boolean;
  // 等待用户回答的弹窗是否提醒（闪任务栏/托盘 + 系统通知）。
  notifyOnPrompt: boolean;
  piWeb: {
    port: string;
    hostname: string;
    allowedHosts: string;
    password: string;
    commandPath: string;
    nodePath: string;
  };
  enhance: {
    provider: string;
    model: string;
  };
};

// 供应商与模型的精简结构，仅用于设置界面下拉选择。
export type ProviderOption = {
  id: string;
  name: string;
  hasApiKey: boolean;
  models: Array<{ id: string; name: string }>;
};

// pi 扩展（用量记录插件）的安装状态。
export type ExtensionInfo = {
  name: string;
  displayName: string;
  description: string;
  installed: boolean;
  installPath: string;
  sourceAvailable: boolean;
  upToDate: boolean;
};

// 设置窗口一次拿到的完整状态，包含只读的展示信息。
export type SettingsSnapshot = {
  settings: BoxSettingsInput;
  settingsFilePath: string;
  commandLine: string;
  versions: ComponentVersions;
  // 当前 Pi Web 主题标识与中文名，用于让设置窗口跟随配色。
  theme: string;
  themeLabel: string;
  // 提示词增强可选的供应商与模型。
  providers: ProviderOption[];
  // 用量记录插件的安装状态。
  usageExtension: ExtensionInfo;
  // 内网访问地址，仅在监听非回环地址时给出。
  lanAddress: string;
  // 关于信息。
  about: {
    version: string;
    github: string;
    qq: string;
    electron: string;
    node: string;
    chrome: string;
  };
};

export type SaveSettingsResult = {
  ok: boolean;
  message: string;
  snapshot?: SettingsSnapshot;
};

// Pi Web 页面把当前主题回传给主进程，用于同步 Windows 标题栏。
export type ThemeReport = {
  theme: string;
  background: string;
  isDark?: boolean;
};

// Pi Web 页面的运行状态，用于托盘角标与完成通知。
export type RunningState = {
  runningCount: number;
  // 相对上一次采样的变化：有任务刚刚结束。
  justFinished: boolean;
};

export type UsageQuery = {
  from: string;
  to: string;
  model: string;
  includeHeatmap: boolean;
};

export type EnhanceRequest = {
  draft: string;
  scene: string;
};

export type EnhanceResponse = {
  ok: boolean;
  text?: string;
  message?: string;
};
