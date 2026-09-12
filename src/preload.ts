import { contextBridge, ipcRenderer } from "electron";
import type { StartupProgress } from "./contracts.js";

if (window.location.protocol === "file:") {
  contextBridge.exposeInMainWorld("piWebBox", {
    getStatus: () => ipcRenderer.invoke("pi-web-box:get-status"),
    getStartupProgress: () => ipcRenderer.invoke("pi-web-box:get-startup-progress"),
    onStartupProgress: (callback: (progress: StartupProgress) => void) => {
      ipcRenderer.on("pi-web-box:startup-progress", (_event, progress: StartupProgress) => callback(progress));
    },
    retryStartup: () => ipcRenderer.invoke("pi-web-box:retry"),
    getLogPath: () => ipcRenderer.invoke("pi-web-box:get-log-path"),
    openLog: () => ipcRenderer.invoke("pi-web-box:open-log"),
  });
}

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
