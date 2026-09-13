import { app, Menu, nativeImage, Notification, Tray } from "electron";
import path from "node:path";

export type TrayCallbacks = {
  showMainWindow: () => void;
  openSettings: () => void;
  openUsage: () => void;
  quit: () => void;
  recentSessions: () => Promise<Array<{ id: string; name: string }>>;
  openSession: (id: string) => void;
};

/**
 * 托盘图标与角标。角标表示有会话正在运行，任务结束时发一条系统通知。
 *
 * 角标不用额外图标文件：直接在主图标上叠加一个圆点绘制成新的 NativeImage，
 * 这样只需维护一套图标资源。
 */
export class TrayController {
  private tray: Tray | undefined;
  private baseIcon: Electron.NativeImage | undefined;
  private runningCount = 0;
  private lastFinishedAt = 0;

  constructor(
    private readonly iconPath: string,
    private readonly log: (message: string) => void,
    private readonly callbacks: TrayCallbacks,
  ) {}

  /** 应用设置里的开关：关闭时销毁图标，重新打开时重建。 */
  setVisible(visible: boolean): void {
    if (visible) this.create();
    else this.destroy();
  }

  isVisible(): boolean {
    return !!this.tray;
  }

  private getBaseIcon(): Electron.NativeImage {
    if (!this.baseIcon) this.baseIcon = nativeImage.createFromPath(this.iconPath);
    return this.baseIcon;
  }

  /** 在图标右下角画一个状态圆点，表示有任务在运行。 */
  private buildBadgedIcon(): Electron.NativeImage {
    const base = this.getBaseIcon().resize({ width: 32, height: 32 });
    if (this.runningCount === 0) return base;
    const size = 32;
    const canvas = Buffer.alloc(size * size * 4);
    const src = base.toBitmap();
    // 先复制原图
    src.copy(canvas, 0, 0, Math.min(src.length, canvas.length));
    // 再在右下角画实心圆：绿色底 + 深色描边，深浅任务栏都能看清。
    const radius = 5;
    const centerX = size - radius - 2;
    const centerY = size - radius - 2;
    const ringRadius = radius + 1;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const distance = Math.hypot(x - centerX, y - centerY);
        if (distance > ringRadius) continue;
        const offset = (y * size + x) * 4;
        // BGRA 排列
        if (distance <= radius) {
          canvas[offset] = 60; // B
          canvas[offset + 1] = 190; // G
          canvas[offset + 2] = 50; // R
          canvas[offset + 3] = 255;
        } else {
          canvas[offset] = 20;
          canvas[offset + 1] = 20;
          canvas[offset + 2] = 20;
          canvas[offset + 3] = 255;
        }
      }
    }
    return nativeImage.createFromBitmap(canvas, { width: size, height: size });
  }

  private create(): void {
    if (this.tray) return;
    try {
      this.tray = new Tray(this.buildBadgedIcon());
      this.tray.setToolTip("Pi Web Box");
      this.tray.on("double-click", () => this.callbacks.showMainWindow());
      void this.refreshMenu();
      this.log("Tray icon created.");
    } catch (error) {
      this.log(`Could not create tray icon: ${error instanceof Error ? error.message : String(error)}`);
      this.tray = undefined;
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }

  /** 托盘菜单：显示窗口、最近会话、统计、设置与退出。 */
  private async refreshMenu(): Promise<void> {
    if (!this.tray) return;
    const sessions = await this.callbacks.recentSessions().catch(() => []);
    const sessionItems = sessions.slice(0, 6).map((session) => ({
      label: session.name.length > 42 ? `${session.name.slice(0, 42)}…` : session.name,
      click: () => this.callbacks.openSession(session.id),
    }));
    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: this.runningCount > 0 ? `Pi Web Box · ${this.runningCount} 个会话运行中` : "显示 Pi Web Box",
        click: () => this.callbacks.showMainWindow(),
      },
      { type: "separator" },
      ...(sessionItems.length > 0
        ? [{ label: "最近会话", enabled: false } as const, ...sessionItems, { type: "separator" } as const]
        : []),
      { label: "Token 统计", click: () => this.callbacks.openUsage() },
      { label: "Box 设置", click: () => this.callbacks.openSettings() },
      { type: "separator" },
      { label: "退出", click: () => this.callbacks.quit() },
    ]));
  }

  /**
   * 更新运行状态。返回值可用于界面展示；
   * 由运行中变为空闲时发系统通知，并记录时间避免重复提醒。
   */
  updateRunningState(count: number, sessions: Array<{ id: string; name: string }>): { justFinished: boolean } {
    const previous = this.runningCount;
    this.runningCount = count;
    const justFinished = previous > 0 && count === 0;
    if (this.tray) {
      this.tray.setImage(this.buildBadgedIcon());
      this.tray.setToolTip(count > 0 ? `Pi Web Box · ${count} 个会话运行中` : "Pi Web Box");
      void this.refreshMenu();
    }
    if (justFinished) {
      this.lastFinishedAt = Date.now();
      const name = sessions[0]?.name;
      this.notify(name);
    }
    return { justFinished };
  }

  private notify(sessionName?: string): void {
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: "Pi Web Box",
        body: sessionName ? `会话已完成：${sessionName}` : "任务已完成",
        silent: false,
      });
      notification.on("click", () => this.callbacks.showMainWindow());
      notification.show();
    } catch (error) {
      this.log(`Could not show notification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getLastFinishedAt(): number {
    return this.lastFinishedAt;
  }
}

/** 解析图标路径，打包后位于 resources/assets。 */
export function trayIconPath(resourcesPath: string, isPackaged: boolean, appPath: string): string {
  return isPackaged
    ? path.join(resourcesPath, "assets", "pi-logo-adaptive.ico")
    : path.join(appPath, "assets", "pi-logo-adaptive.ico");
}

/** 供主进程使用的默认回调占位，真实实现由 main.ts 注入。 */
export type TrayDependencies = {
  app: typeof app;
};
