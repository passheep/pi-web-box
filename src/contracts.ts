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
