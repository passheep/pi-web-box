import { BrowserWindow, WebContentsView, type WebContents } from "electron";
import type { DesktopState, DesktopTab } from "./desktop-contracts.js";

/** 只接受当前 Pi Web 服务的页面，不把外部地址装进有桌面桥接权限的标签。 */
export function isServiceUrl(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin && /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

export const MAX_DESKTOP_TABS = 6;
// 蓝、绿、紫、橙、玫红、青：略提高饱和度并拉开色相，避免不同色值看起来重色。
export const TAB_COLORS = ["#588ddd", "#55a76f", "#a576cf", "#d39a45", "#ce718f", "#40a9b5"];

export type TabEntry = DesktopTab & { view: WebContentsView; theme?: { theme: string; background: string } };

/** 标签只管理浏览器页面，绝不启动或停止 Pi Web 服务。 */
export class DesktopTabs {
  private entries: TabEntry[] = [];
  private activeId = "";
  private panelOpen = false;
  private nextId = 0;
  private names = new Map<string, string>();
  private runningIds = new Set<string>();

  constructor(
    private readonly window: BrowserWindow,
    readonly origin: string,
    private readonly preload: string,
    private readonly setup: (contents: WebContents) => void,
    private readonly changed: () => void,
  ) {}

  all(): TabEntry[] { return [...this.entries]; }
  active(): TabEntry | undefined { return this.entries.find((tab) => tab.id === this.activeId); }
  fromContents(contents: WebContents): TabEntry | undefined { return this.entries.find((tab) => tab.view.webContents === contents); }

  snapshot(unread: number): DesktopState {
    return { tabs: this.entries.map(({ id, title, sessionId, url, loading, color, running }) => ({ id, title, sessionId, url, loading, color, running })), activeId: this.activeId, unread, maximized: this.window.isMaximized(), messagePanelOpen: this.panelOpen, maxTabs: MAX_DESKTOP_TABS };
  }

  create(url = this.origin): void {
    if (this.entries.length >= MAX_DESKTOP_TABS || !isServiceUrl(url, this.origin)) return;
    // 仅从当前未占用的颜色中抽取；关闭标签才释放颜色，绝不回退到共用默认色。
    const usedColors = new Set(this.entries.map((tab) => tab.color));
    const available = [...new Set(TAB_COLORS)].filter((color) => !usedColors.has(color));
    if (!available.length) return;
    const color = available[Math.floor(Math.random() * available.length)];
    const view = new WebContentsView({ webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const entry: TabEntry = { id: String(++this.nextId), title: "新标签页", sessionId: "", url, loading: true, color, running: false, view };
    this.entries.push(entry);
    this.window.contentView.addChildView(view);
    this.setup(view.webContents);
    const update = () => {
      entry.url = view.webContents.getURL() || url;
      entry.loading = view.webContents.isLoading();
      this.changed();
    };
    view.webContents.on("did-start-loading", update);
    view.webContents.on("did-stop-loading", update);
    view.webContents.on("did-navigate", update);
    view.webContents.on("did-navigate-in-page", update);
    view.webContents.on("render-process-gone", () => { entry.title = "页面已停止（可刷新）"; entry.loading = false; this.changed(); });
    this.activate(entry.id);
    void view.webContents.loadURL(url).catch(() => { entry.title = "页面加载失败（可刷新）"; entry.loading = false; this.changed(); });
  }

  activate(id: string): void {
    if (!this.entries.some((tab) => tab.id === id)) return;
    this.activeId = id;
    this.layout();
    this.active()?.view.webContents.focus();
    this.changed();
  }

  close(id: string): void {
    const index = this.entries.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const [tab] = this.entries.splice(index, 1);
    this.window.contentView.removeChildView(tab.view);
    // 仅销毁页面连接，不向后端发送 abort，也不结束会话运行。
    tab.view.webContents.close();
    if (this.activeId === id) this.activeId = this.entries[Math.min(index, this.entries.length - 1)]?.id || "";
    if (!this.entries.length) this.create();
    else { this.layout(); this.active()?.view.webContents.focus(); this.changed(); }
  }

  reorder(id: string, beforeId: string | null): void {
    if (id === beforeId || (beforeId !== null && !this.entries.some((tab) => tab.id === beforeId))) return;
    const index = this.entries.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const [tab] = this.entries.splice(index, 1);
    const target = beforeId === null ? this.entries.length : this.entries.findIndex((item) => item.id === beforeId);
    this.entries.splice(target, 0, tab);
    this.changed();
  }

  report(contents: WebContents, report: { sessionId?: unknown; title?: unknown }): void {
    const tab = this.fromContents(contents);
    if (!tab || !report || typeof report.sessionId !== "string") return;
    const id = report.sessionId.slice(0, 200);
    const switched = tab.sessionId !== id;
    const name = this.names.get(id);
    const title = name || (switched ? (id ? "未命名会话" : "新标签页") : tab.title);
    const running = this.runningIds.has(id);
    if (!switched && tab.title === title && tab.running === running) return;
    tab.sessionId = id;
    tab.title = title;
    tab.running = running;
    this.changed();
  }

  /** 集中查询只更新名字和运行状态，不重载页面。失败返回 null 时保留上次有效结果。 */
  syncSessions(names: Map<string, string> | null, runningIds: string[] | null): void {
    if (names) this.names = new Map(names);
    if (runningIds) this.runningIds = new Set(runningIds);
    let changed = false;
    for (const tab of this.entries) {
      const name = this.names.get(tab.sessionId);
      const title = name || tab.title;
      const running = this.runningIds.has(tab.sessionId);
      if (tab.title === title && tab.running === running) continue;
      tab.title = title;
      tab.running = running;
      changed = true;
    }
    if (changed) this.changed();
  }

  togglePanel(): void { this.panelOpen = !this.panelOpen; this.layout(); this.changed(); }

  layout(): void {
    if (this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    // 最小化时 Windows 会把内容尺寸临时归零：跳过这次无效布局，
    // 避免把页面压成 1×1 触发 Pi Web 窄屏逻辑自动收起侧边栏。
    if (this.window.isMinimized() || width <= 0 || height <= 40) return;
    for (const tab of this.entries) {
      tab.view.setVisible(tab.id === this.activeId);
      tab.view.setBounds({ x: 0, y: 40, width: Math.max(1, width - (this.panelOpen ? 380 : 0)), height: Math.max(1, height - 40) });
    }
  }

  openSession(id: string): void {
    const existing = this.entries.find((tab) => tab.sessionId === id);
    if (existing) this.activate(existing.id);
    else {
      const url = `${this.origin}/?session=${encodeURIComponent(id)}`;
      // 达到上限后消息/托盘跳转复用当前标签，不偷偷创建第七个页面。
      if (this.entries.length >= MAX_DESKTOP_TABS) {
        const tab = this.active();
        if (tab) {
          this.report(tab.view.webContents, { sessionId: id });
          void tab.view.webContents.loadURL(url).catch(() => {});
        }
      } else this.create(url);
    }
  }

  dispose(): void {
    for (const tab of this.entries) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.entries = [];
  }
}
