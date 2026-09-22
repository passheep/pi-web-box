/**
 * 在 preload 暴露 piWebBox 后，尽早通过 executeInMainWorld({ func: installPageCapture }) 安装。
 * 必须完全自包含：不能闭包引用模块变量、运行时 import 或编译器辅助函数。
 * 只旁听页面自己建立的 SSE；不建连接、不补历史、不拦截/修改原消息。
 * 页面内不再 fetch 会话详情（HTTP/1.1 下 SSE 已占满 6 个连接，详情请求会被阻塞）；
 * 会话名由主进程集中读取，页面只上报 sessionId，sessionName 始终留空由主进程补齐。
 */
export function installPageCapture(): void {
  const w = globalThis as any;
  try {
    if (!/^https?:$/.test(w.location?.protocol) || w.__piWebBoxPageCaptureInstalled) return;
    Object.defineProperty(w, "__piWebBoxPageCaptureInstalled", { value: true });
  } catch { return; }

  const origin = w.location.origin;
  let sessionId = "";
  let initialized = false;
  // 仅供 SSE -> DOM 当次配对，限时、限量、消费一次；不是永久文本去重。
  let recent: any[] = [];
  const seenNodes = new WeakMap<any, string>();
  const clean = (value: any): string => typeof value === "string" ? value.trim() : "";
  const levelOf = (value: any): string => ["info", "warning", "error", "success"].includes(value) ? value : "info";
  const callBridge = (method: string, payload: any): boolean => {
    try {
      if (typeof w.piWebBox?.[method] !== "function") return false;
      // IPC 失败也不向页面抛异常，不积压提示正文，不自动重发。
      const result = w.piWebBox[method](payload);
      if (result?.catch) result.catch(() => {});
      return true;
    } catch { return false; }
  };
  const readSession = (): string => {
    try {
      const url = new w.URL(w.location.href);
      if (url.origin !== origin || url.pathname !== "/") return "";
      const id = clean(url.searchParams.get("session"));
      // 不接受路径/控制字符，避免误访问保留端点；不读取其它 URL 参数。
      return /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? id : "";
    } catch { return ""; }
  };
  // 需要用户回答的扩展弹窗方法；notify / setStatus / setWidget 只做展示，不算等待输入。
  const attentionMethods = ["select", "confirm", "input", "editor", "custom"];
  // 待回答弹窗：requestId -> 所属会话 id，关闭或切换会话时按原会话撤销。
  const waiting = new Map<string, string>();
  const reportWaiting = (requestId: string, id: string, active: boolean, data?: any): void => {
    if (active) {
      // 同一弹窗会重复下发（custom 面板每次重绘都会带同一 id），只上报第一次。
      if (waiting.has(requestId)) return;
      waiting.set(requestId, id);
    } else if (!waiting.delete(requestId)) return;
    callBridge("reportAttention", {
      sessionId: id,
      requestId,
      active,
      method: clean(data?.method),
      title: clean(data?.title),
      message: clean(data?.message),
      optionCount: Array.isArray(data?.options) ? data.options.length : 0,
    });
  };
  // 会话切换后旧弹窗不会再有关闭事件，这里统一撤销，避免提醒一直挂着。
  const clearWaiting = (): void => {
    for (const [requestId, id] of [...waiting]) reportWaiting(requestId, id, false);
  };
  // 只做本地路由同步，不发起任何网络请求。
  const syncRoute = (): void => {
    try {
      const next = readSession();
      if (initialized && next === sessionId) return;
      initialized = true;
      clearWaiting();
      sessionId = next;
      recent = [];
      callBridge("reportTab", { sessionId });
    } catch { /* 路由观察不能影响导航 */ }
  };

  try {
    const NativeSource = w.EventSource;
    if (typeof NativeSource === "function") {
      // Proxy 原构造器：静态常量、prototype、instanceof、子类和构造参数均沿用原生行为。
      w.EventSource = new Proxy(NativeSource, {
        construct(target: any, args: any[], newTarget: any): any {
          const source: any = Reflect.construct(target, args, newTarget);
          try {
            // 使用原生解析后的 url，避免把用户传入的对象重复字符串化。
            const url = new w.URL(source.url, w.location.href);
            const match = /^\/api\/agent\/([^/]+)\/events$/.exec(url.pathname);
            if (url.origin !== origin || !match) return source;
            const id = decodeURIComponent(match[1]);
            source.addEventListener("message", (event: any) => {
              try {
                if (typeof event.data !== "string") return;
                const data = JSON.parse(event.data);
                // 等待用户回答的弹窗：出现时上报提醒，关闭时撤销。
                if (data?.type === "extension_ui_request" && typeof data.id === "string" && attentionMethods.includes(data.method)) {
                  // custom 面板收起时会带 closed 重发同一个 id。
                  if (data.closed === true) reportWaiting(data.id, id, false);
                  else reportWaiting(data.id, id, true, data);
                  return;
                }
                if (data?.type === "extension_ui_closed" && typeof data.id === "string") {
                  reportWaiting(data.id, id, false);
                  return;
                }
                let message: string;
                let level: string;
                if (data?.type === "extension_ui_request" && data.method === "notify") {
                  message = clean(data.message);
                  level = levelOf(data.notifyType);
                } else if (data?.type === "extension_error") {
                  message = clean(data.error ?? "Extension command failed");
                  level = "error";
                } else return;
                if (!message) return;
                // UUID 原样传给主进程去重；不从聊天内容、SSE 原始数据或凭据生成 ID。
                const eventId = typeof data.id === "string" ? data.id : undefined;
                const accepted = callBridge("recordNotice", {
                  eventId, sessionId: id,
                  // 页面不读会话名；留空由主进程按 sessionId 补齐。
                  sessionName: "",
                  message, level, source: "pi",
                });
                if (accepted) {
                  const now = Date.now();
                  recent = recent.filter((item: any) => now - item.time < 10000);
                  if (!eventId || !recent.some((item: any) => item.eventId === eventId && item.id === id)) {
                    recent.push({ eventId, id, message, level, time: now });
                    if (recent.length > 256) recent.shift();
                  }
                }
              } catch { /* 只忽略捕获失败；页面原监听器仍收到同一个 Event */ }
            });
          } catch { /* 旁听失败不能阻止 EventSource 构造 */ }
          return source;
        },
      });
    }
  } catch { /* 环境没有 EventSource 或构造器不可写 */ }

  // 只读提取本机 @agegr/pi-web 0.9.1 .next/static/chunks/app/page-*.js 确认：
  // rE 通知架 -> .notice-shelf-item -> span[tabindex="0"]，正文为 i.message。
  // 不使用泛化 div、role=alert、aria-live、React 私有属性或聊天区选择器。
  const captureNode = (node: any): void => {
    try {
      const body = node.querySelector(':scope > span[tabindex="0"]');
      const message = clean(body?.textContent);
      if (!message || seenNodes.get(node) === message) return;
      seenNodes.set(node, message);
      const color = node.querySelector(":scope > span:first-child")?.style?.background ?? "";
      const level = /#ef4444|rgb\(239,\s*68,\s*68\)/i.test(color) ? "error"
        : /#d97706|rgb\(217,\s*119,\s*6\)/i.test(color) ? "warning"
        : /#10b981|rgb\(16,\s*185,\s*129\)/i.test(color) ? "success" : "info";
      const id = readSession();
      const now = Date.now();
      recent = recent.filter((item: any) => now - item.time < 10000);
      const index = recent.findIndex((item: any) => item.id === id && item.message === message && item.level === level);
      if (index >= 0) { recent.splice(index, 1); return; }
      callBridge("recordNotice", {
        sessionId: id, sessionName: "", message, level, source: "pi-web",
      });
    } catch { /* DOM 更新/版本差异不影响页面 */ }
  };
  const inspect = (node: any): void => {
    try {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      if (!element) return;
      const notice = element.closest?.(".notice-shelf-item");
      if (notice) captureNode(notice);
      for (const item of element.querySelectorAll?.(".notice-shelf-item") ?? []) captureNode(item);
    } catch { /* 只扫描精确通知类，不读取其它节点的正文 */ }
  };
  try {
    const observer = new w.MutationObserver((records: any[]) => {
      for (const record of records) {
        if (record.type === "characterData") inspect(record.target);
        else {
          // 文字节点替换也要检查父通知，但不扫描整棵 mutation.target 子树。
          try {
            const notice = record.target?.closest?.(".notice-shelf-item");
            if (notice) captureNode(notice);
          } catch { /* 忽略已卸载节点 */ }
          for (const node of record.addedNodes ?? []) inspect(node);
        }
      }
    });
    // document 在 early preload 已存在，documentElement/body 可能尚未创建。
    observer.observe(w.document, { childList: true, subtree: true, characterData: true });
    inspect(w.document.documentElement);
  } catch { /* DOM 捕获不可用时仍保留 SSE 捕获 */ }

  try {
    for (const method of ["pushState", "replaceState"]) {
      const original = w.history[method];
      w.history[method] = new Proxy(original, {
        apply(target: any, thisArg: any, args: any[]): any {
          const result = Reflect.apply(target, thisArg, args);
          syncRoute();
          return result;
        },
      });
    }
    w.addEventListener("popstate", () => { syncRoute(); });
  } catch { /* 框架替换 history 方法时仍有下方定时兜底 */ }
  try {
    syncRoute();
    // 兜底：SPA 未走 pushState/popstate 时定期校正路由；仅本地检查，不用网络。
    w.setInterval(() => { syncRoute(); }, 3000);
  } catch { /* 定时器不可用也不影响正常页面 */ }
}
