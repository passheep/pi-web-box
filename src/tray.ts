import { app, Menu, nativeImage, Notification, Tray } from "electron";
import path from "node:path";

/** 托盘与任务栏统一的图标尺寸。 */
const TRAY_ICON_SIZE = 32;
/** 托盘闪烁的切换间隔：太慢像卡住，太快像抖动。 */
const TRAY_FLASH_INTERVAL_MS = 600;

/** 在 BGRA 位图上画一个实心圆点（含深色描边），运行角标与闪烁高亮共用。 */
function paintDot(
  canvas: Buffer,
  size: number,
  centerX: number,
  centerY: number,
  radius: number,
  color: { r: number; g: number; b: number },
): void {
  const ringRadius = radius + 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > ringRadius) continue;
      const offset = (y * size + x) * 4;
      // Electron 的位图是 BGRA 排列。
      const solid = distance <= radius;
      canvas[offset] = solid ? color.b : 20;
      canvas[offset + 1] = solid ? color.g : 20;
      canvas[offset + 2] = solid ? color.r : 20;
      canvas[offset + 3] = 255;
    }
  }
}

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
  // 是否有弹窗等待用户回答；开启后图标在两个帧之间来回切换。
  private attention = false;
  private attentionPhase = false;
  private attentionTimer: NodeJS.Timeout | undefined;

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

  /** 复制一份可写的位图并叠加角标，不改动缓存的基础图标。 */
  private withBadge(paint: (canvas: Buffer, size: number) => void): Electron.NativeImage {
    const base = this.getBaseIcon().resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
    const canvas = Buffer.alloc(TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4);
    const src = base.toBitmap();
    // 先复制原图，再让调用方叠加角标。
    src.copy(canvas, 0, 0, Math.min(src.length, canvas.length));
    paint(canvas, TRAY_ICON_SIZE);
    return nativeImage.createFromBitmap(canvas, { width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  }

  /** 在图标右下角画一个状态圆点，表示有任务在运行。 */
  private buildBadgedIcon(): Electron.NativeImage {
    if (this.runningCount === 0) {
      return this.getBaseIcon().resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
    }
    return this.withBadge((canvas, size) => {
      // 绿色底 + 深色描边，深浅任务栏都能看清。
      const radius = 5;
      paintDot(canvas, size, size - radius - 2, size - radius - 2, radius, { r: 50, g: 190, b: 60 });
    });
  }

  /** 在图标右上角画一个橙色圆点，作为「有弹窗等待回答」的闪烁高亮帧。 */
  private buildAttentionIcon(): Electron.NativeImage {
    return this.withBadge((canvas, size) => {
      const radius = 6;
      paintDot(canvas, size, size - radius - 2, radius + 2, radius, { r: 240, g: 110, b: 40 });
    });
  }

  /** 当前图标：基础图标 + 运行角标；闪烁的亮帧再叠加等待回答的橙点。 */
  private applyIcon(): void {
    if (!this.tray) return;
    this.tray.setImage(this.attention && this.attentionPhase ? this.buildAttentionIcon() : this.buildBadgedIcon());
  }

  private applyToolTip(): void {
    if (!this.tray) return;
    if (this.attention) this.tray.setToolTip("Pi Web Box · 有弹窗等待你的回答");
    else this.tray.setToolTip(this.runningCount > 0 ? `Pi Web Box · ${this.runningCount} 个会话运行中` : "Pi Web Box");
  }

  /** 闪烁定时器跟随 attention 开关；托盘销毁后重建也能自动恢复。 */
  private syncAttentionTimer(): void {
    if (this.attention && !this.attentionTimer) {
      this.attentionTimer = setInterval(() => {
        this.attentionPhase = !this.attentionPhase;
        this.applyIcon();
      }, TRAY_FLASH_INTERVAL_MS);
    } else if (!this.attention && this.attentionTimer) {
      clearInterval(this.attentionTimer);
      this.attentionTimer = undefined;
      this.attentionPhase = false;
    }
  }

  /**
   * 托盘闪烁开关。窗口隐藏到托盘时任务栏没有按钮可闪，
   * 这时让图标在「普通」与「高亮」之间切换，作为唯一可见的提醒通道。
   */
  setAttention(active: boolean): void {
    if (this.attention === active) return;
    this.attention = active;
    this.syncAttentionTimer();
    this.applyIcon();
    this.applyToolTip();
    void this.refreshMenu();
  }

  private create(): void {
    if (this.tray) return;
    try {
      this.tray = new Tray(this.buildBadgedIcon());
      this.tray.on("double-click", () => this.callbacks.showMainWindow());
      this.syncAttentionTimer();
      this.applyIcon();
      this.applyToolTip();
      void this.refreshMenu();
      this.log("Tray icon created.");
    } catch (error) {
      this.log(`Could not create tray icon: ${error instanceof Error ? error.message : String(error)}`);
      this.tray = undefined;
    }
  }

  destroy(): void {
    // 只停定时器、保留 attention 标志：托盘重新打开后闪烁能自动接上。
    clearInterval(this.attentionTimer);
    this.attentionTimer = undefined;
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
        label: this.attention
          ? "Pi Web Box · 有弹窗等待你的回答"
          : this.runningCount > 0 ? `Pi Web Box · ${this.runningCount} 个会话运行中` : "显示 Pi Web Box",
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
      this.applyIcon();
      this.applyToolTip();
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
