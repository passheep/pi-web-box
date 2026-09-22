/**
 * 询问提醒（attention）模块。
 *
 * 背景：Pi Web 页面里「等待用户输入」的扩展弹窗（select / input / confirm /
 * editor / custom，ask_user_question 在 pi-web 下走的就是 select + input）
 * 在窗口处于后台时没有任何提示，任务会一直卡在等人回答上。
 *
 * 本模块维护「当前有几个待回答弹窗」，并按窗口状态挑选提醒通道：
 * - 窗口在任务栏可见但未聚焦：闪烁任务栏按钮；
 * - 窗口已隐藏到托盘：改为闪烁托盘图标（此时任务栏没有按钮可闪）；
 * - 两种情况都发一条系统通知，点击后打开窗口并跳到对应会话。
 * 窗口获得焦点即视为用户已经看到，由调用方调用 clearAll() 停止全部提醒。
 *
 * 窗口本身就在前台时不发提醒：弹窗在页面上已经可见，再闪再弹只是打扰；
 * 但状态仍然记录，这样用户切走（blur）后能立刻接上提醒。
 * 设置里的「等待回答时提醒」关掉后，本模块整体不再介入（enabled 返回 false）。
 *
 * 模块不直接依赖 Electron，窗口 / 托盘 / 通知全部通过注入的回调操作，便于单测。
 */

/** 需要用户回答的扩展 UI 方法；notify / setStatus / setWidget 等只做展示，不算等待输入。 */
export const ATTENTION_METHODS = ["select", "confirm", "input", "editor", "custom"] as const;

/** 通知正文的字符上限，超出截断。 */
const MAX_BODY_CHARS = 120;

/** 页面新出现的一个待回答弹窗。 */
export type AttentionRequest = {
  /** 上报该弹窗的标签页 id，页面重载或标签关闭时按它整批撤销。 */
  tabId: string;
  sessionId: string;
  requestId: string;
  method: string;
  title: string;
  message: string;
  optionCount: number;
};

/** 一条系统通知的内容。 */
export type AttentionNotice = { sessionId: string; title: string; body: string };

/** 提醒需要的宿主能力，全部由 main.ts 注入。 */
export type AttentionDeps = {
  /** 设置开关：关闭时不提醒、也不记录等待状态。 */
  enabled: () => boolean;
  /** 主窗口当前是否聚焦。 */
  isFocused: () => boolean;
  /** 主窗口是否在任务栏可见（隐藏到托盘时为 false）。 */
  isVisible: () => boolean;
  /** 开始 / 停止闪烁任务栏按钮。 */
  flash: (active: boolean) => void;
  /** 开始 / 停止闪烁托盘图标。 */
  setTrayAttention: (active: boolean) => void;
  /** 弹一条系统通知。 */
  notify: (notice: AttentionNotice) => void;
  /** 按会话 id 取会话名，取不到返回空串。 */
  sessionName: (sessionId: string) => string;
  log: (message: string) => void;
};

/** 判断扩展 UI 方法是否需要用户回答。 */
export function isAttentionMethod(method: unknown): boolean {
  return typeof method === "string" && (ATTENTION_METHODS as readonly string[]).includes(method);
}

/**
 * 取第一行非空文本；空文本返回空串。
 * 只取首行是有意为之：select 的 title 后面会跟着整块预览正文，
 * 系统通知只需要说清楚「哪一问在等人」，长正文留给应用内查看。
 */
function summarize(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0) ?? "";
  if (line.length <= MAX_BODY_CHARS) return line;
  return `${line.slice(0, MAX_BODY_CHARS)}…`;
}

/** 拼装系统通知：标题带会话名，正文优先用 message（confirm 的问题在这里），否则用 title。 */
export function describeAttention(request: AttentionRequest, sessionName: string): AttentionNotice {
  const name = sessionName.trim();
  const title = name ? `${name} · 需要你的回答` : "Pi Web Box · 需要你的回答";
  const text = summarize(request.message) || summarize(request.title);
  // 选项数只在 select 上有意义，补在正文尾部帮助用户判断要不要切过去。
  const options = request.method === "select" && request.optionCount > 0 ? `（${request.optionCount} 个选项）` : "";
  const body = text ? `${text}${options}` : "有扩展弹窗正在等待你的回答。";
  return { sessionId: request.sessionId, title, body };
}

/** 弹窗的唯一键：标签 id 与请求 id 之间用 NUL 分隔，避免拼接歧义。 */
function pendingKey(tabId: string, requestId: string): string {
  return `${tabId}\u0000${requestId}`;
}

export class AttentionController {
  /** 待回答弹窗，key 见 pendingKey；同一弹窗重复上报只提醒一次。 */
  private readonly pending = new Map<string, AttentionRequest>();
  private flashing = false;
  private trayFlashing = false;

  constructor(private readonly deps: AttentionDeps) {}

  /** 待回答弹窗数量。 */
  get count(): number {
    return this.pending.size;
  }

  /** 弹窗出现：去重后按窗口状态发提醒。 */
  raise(request: AttentionRequest): void {
    // 设置里关掉提醒后不再记录，避免重新打开开关时补一堆历史提醒。
    if (!this.deps.enabled()) return;
    const key = pendingKey(request.tabId, request.requestId);
    if (this.pending.has(key)) return;
    this.pending.set(key, request);
    // 窗口在前台时用户已经能看到弹窗，只记录状态不打扰。
    if (!this.deps.isFocused()) {
      this.deps.notify(describeAttention(request, this.deps.sessionName(request.sessionId)));
    }
    this.refresh();
  }

  /** 弹窗关闭（已回答 / 取消 / 超时）：撤销对应提醒。 */
  resolve(tabId: string, requestId: string): void {
    if (!this.pending.delete(pendingKey(tabId, requestId))) return;
    this.refresh();
  }

  /** 页面重载或标签关闭：该标签的弹窗已经不存在，整批撤销。 */
  clearTab(tabId: string): void {
    let removed = false;
    for (const [key, item] of [...this.pending]) {
      if (item.tabId !== tabId) continue;
      this.pending.delete(key);
      removed = true;
    }
    if (removed) this.refresh();
  }

  /** 窗口获得焦点：用户已经看到窗口，立即清空并停止全部提醒。 */
  clearAll(): void {
    this.pending.clear();
    this.refresh();
  }

  /** 窗口显示 / 隐藏 / 聚焦状态变化后重新决定提醒通道。 */
  refresh(): void {
    const active = this.pending.size > 0 && this.deps.enabled();
    const focused = this.deps.isFocused();
    const visible = this.deps.isVisible();
    // 任务栏有按钮时闪按钮；隐藏到托盘后任务栏没有按钮，只能闪托盘图标。
    this.setFlashing(active && !focused && visible);
    this.setTrayFlashing(active && !focused && !visible);
  }

  private setFlashing(active: boolean): void {
    if (this.flashing === active) return;
    this.flashing = active;
    try {
      this.deps.flash(active);
    } catch (error) {
      this.deps.log(`切换任务栏闪烁失败：${String(error)}`);
    }
  }

  private setTrayFlashing(active: boolean): void {
    if (this.trayFlashing === active) return;
    this.trayFlashing = active;
    try {
      this.deps.setTrayAttention(active);
    } catch (error) {
      this.deps.log(`切换托盘闪烁失败：${String(error)}`);
    }
  }
}