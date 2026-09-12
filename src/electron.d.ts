import type { StartupProgress } from "./contracts.js";

export {};

declare global {
  interface Window {
    piWebBox: {
      getStatus: () => Promise<{ message: string; details: string; logPath: string }>;
      getStartupProgress: () => Promise<StartupProgress>;
      onStartupProgress: (callback: (progress: StartupProgress) => void) => void;
      retryStartup: () => Promise<void>;
      getLogPath: () => Promise<string>;
      openLog: () => Promise<void>;
    };
  }
}
