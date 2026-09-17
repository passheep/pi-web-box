import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";

// 使用与项目 tsc 一致的 ES2022 输出；tsx 的 keepNames 辅助函数不能代表生产 bundle。
const source = readFileSync(new URL("../src/page-capture.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleContext = vm.createContext({ exports: {} });
vm.runInContext(compiled, moduleContext);
const script = `(${moduleContext.exports.installPageCapture.toString()})()`;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(initial = "http://127.0.0.1:30141/?session=alpha") {
  const notices: any[] = [];
  const reports: any[] = [];
  const requests: any[] = [];
  const observers: any[] = [];
  const intervals: any[] = [];
  const listeners: Record<string, any[]> = {};
  let now = 1000;
  const location = new URL(initial);
  class FakeSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    url: string;
    options: any;
    closed = false;
    onmessage: any;
    listeners: Record<string, any[]> = {};
    constructor(url: any, options?: any) {
      this.url = new URL(url, location.href).href;
      this.options = options;
    }
    addEventListener(type: string, fn: any) { (this.listeners[type] ??= []).push(fn); }
    emit(data: any) {
      const event = { data: typeof data === "string" ? data : JSON.stringify(data) };
      for (const fn of this.listeners.message ?? []) fn(event);
      this.onmessage?.(event);
      return event;
    }
    close() { this.closed = true; }
  }
  const c: any = vm.createContext({
    URL, location, EventSource: FakeSource,
    Date: class extends Date { static now() { return now; } },
    document: { documentElement: null },
    MutationObserver: class {
      constructor(public callback: any) { observers.push(this); }
      observe(target: any, options: any) { assert.ok(target); this.options = options; }
      options: any;
    },
    history: {
      pushState(_state: any, _title: any, url: string) { location.href = new URL(url, location.href).href; return 17; },
      replaceState(_state: any, _title: any, url: string) { location.href = new URL(url, location.href).href; },
    },
    addEventListener(type: string, fn: any) { (listeners[type] ??= []).push(fn); },
    setInterval(fn: any, ms: number) { intervals.push({ fn, ms }); return intervals.length; },
    setTimeout(fn: any) { throw Error("页面采集不得使用 setTimeout"); },
    clearTimeout() { /* 未用到 */ },
    // 会话名读取已移到主进程：页面内任何 fetch 都视为回归缺陷。
    fetch(url: string, options: any) {
      // 先计数再抛错，避免采集器吞掉异常后测试误判为没有请求。
      requests.push({ url, options });
      throw Error("页面采集不得发起网络请求");
    },
    AbortController: class { constructor() { throw Error("页面采集不得使用 AbortController"); } },
    piWebBox: {
      recordNotice(payload: any) { notices.push(JSON.parse(JSON.stringify(payload))); },
      reportTab(payload: any) { reports.push(JSON.parse(JSON.stringify(payload))); },
    },
  });
  const install = () => vm.runInContext(script, c);
  const addToast = (message: string, color = "", node?: any) => {
    const body = { textContent: message };
    const toast: any = node ?? {
      nodeType: 1,
      body,
      querySelector(selector: string) {
        if (selector === ':scope > span[tabindex="0"]') return this.body;
        if (selector === ":scope > span:first-child") return { style: { background: color } };
        throw Error("Unexpected selector: " + selector);
      },
      closest(selector: string) { assert.equal(selector, ".notice-shelf-item"); return this; },
      querySelectorAll(selector: string) { assert.equal(selector, ".notice-shelf-item"); return []; },
    };
    toast.body.textContent = message;
    for (const observer of observers) observer.callback([{ type: "childList", target: {}, addedNodes: [toast] }]);
    return toast;
  };
  return {
    c, notices, reports, requests, observers, intervals, listeners, FakeSource, install, addToast,
    tick: async () => { for (const timer of intervals) timer.fn(); await flush(); },
    advance: (ms: number) => { now += ms; },
  };
}

const notify = (id: string, message = "提示正文") => ({
  type: "extension_ui_request", method: "notify", id, message, notifyType: "warning",
  credential: "不可采集", context: { messages: ["聊天正文"] },
});

test("采集函数自包含、只装一次，且页面不再发起 fetch 会话名", async () => {
  assert.doesNotMatch(script, /require\(|exports\.|__name|__awaiter|\.fetch\(|AbortController|setTimeout/);
  const h = harness();
  h.install();
  const Wrapped = h.c.EventSource;
  h.install();
  await flush();
  assert.equal(h.c.EventSource, Wrapped);
  assert.equal(h.observers.length, 1);
  // 只保留路由兜底定时器；不再有 fetch 名称轮询。
  assert.deepEqual(h.intervals.map((timer) => timer.ms), [3000]);
  assert.deepEqual(h.reports, [{ sessionId: "alpha" }]);
  const local = harness("file:///startup.html");
  local.install();
  assert.equal(local.c.EventSource, local.FakeSource);
  assert.equal(local.intervals.length, 0);
});

test("包装器保持构造器/原型/静态/子类/参数与原始事件不受影响", async () => {
  const h = harness(); h.install(); await flush();
  const Wrapped = h.c.EventSource;
  assert.equal(Wrapped.prototype, h.FakeSource.prototype);
  assert.equal(Wrapped.OPEN, h.FakeSource.OPEN);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Wrapped, "OPEN"), Object.getOwnPropertyDescriptor(h.FakeSource, "OPEN"));
  class Child extends Wrapped { marker = 1; }
  const options = { withCredentials: true };
  const stream = new Child("/api/agent/alpha/events", options);
  assert.ok(stream instanceof Child && stream instanceof Wrapped && stream instanceof h.FakeSource);
  assert.equal(stream.options, options);
  const delivered: any[] = [];
  stream.addEventListener("message", (event: any) => delivered.push(event));
  stream.onmessage = (event: any) => delivered.push(event);
  const event = stream.emit(notify("original-uuid"));
  assert.equal(delivered[0], event); assert.equal(delivered[1], event);
  assert.equal(JSON.parse(event.data).credential, "不可采集");
  // 旧通知路径：sessionName 留空由主进程补齐，归属来自 SSE URL 的会话。
  assert.deepEqual(h.notices, [{
    eventId: "original-uuid", sessionId: "alpha", sessionName: "", message: "提示正文", level: "warning", source: "pi",
  }]);
  stream.close(); assert.equal(stream.closed, true);
});

test("仅同源 agent 事件流和 notify/extension_error 被采集，凭据不外泄", () => {
  const h = harness(); h.install();
  for (const url of ["http://evil.invalid/api/agent/alpha/events", "http://127.0.0.1:30142/api/agent/alpha/events", "/api/auth/login/key", "/api/terminal/a/events", "/api/agent/alpha/events/other"]) {
    const stream = new h.c.EventSource(url);
    assert.equal(stream.listeners.message, undefined);
    stream.emit(notify("ignored"));
  }
  const stream = new h.c.EventSource("/api/agent/alpha/events");
  for (const data of ["not json", null, { type: "message_end", message: "聊天" }, { ...notify("no"), method: "input" }, { ...notify("blank"), message: " " }]) stream.emit(data);
  stream.emit({ type: "extension_error", id: "error-id", error: "扩展出错", stack: "secret path" });
  stream.emit({ type: "extension_error" });
  assert.equal(h.notices.length, 2);
  assert.equal(h.notices[0].eventId, "error-id");
  assert.equal(h.notices[0].message, "扩展出错");
  assert.equal(h.notices[0].level, "error");
  assert.equal(h.notices[1].message, "Extension command failed");
  assert.ok(!JSON.stringify(h.notices).includes("secret"));
});

test("SSE 与 DOM 当次配对去重、过期后不再吞掉未来提示", () => {
  const h = harness(); h.install();
  const stream = new h.c.EventSource("/api/agent/alpha/events");
  stream.emit(notify("n1"));
  const node = h.addToast("提示正文", "rgb(217, 119, 6)");
  h.addToast("提示正文", "rgb(217, 119, 6)", node);
  assert.equal(h.notices.length, 1);
  h.addToast("提示正文", "rgb(217, 119, 6)");
  assert.equal(h.notices.length, 2); // 新节点、相同文本仍是新提示
  assert.equal(h.notices[1].source, "pi-web");
  assert.equal(h.notices[1].sessionName, ""); // DOM 采集同样留空给主进程补齐
  stream.emit(notify("n2", "延迟提示"));
  h.advance(11000);
  h.addToast("延迟提示", "#d97706");
  assert.equal(h.notices.length, 4); // 短期排除不无限吞掉未来提示
  h.addToast("已改变正文", "", node);
  assert.equal(h.notices.at(-1).message, "已改变正文");
  const unrelated = {
    nodeType: 1,
    get textContent() { throw Error("Must not read chat text"); },
    closest: () => null,
    querySelectorAll: (selector: string) => { assert.equal(selector, ".notice-shelf-item"); return []; },
  };
  assert.doesNotThrow(() => h.observers[0].callback([{ type: "childList", target: unrelated, addedNodes: [unrelated] }]));
});

test("路由同步只本地上报 sessionId，归属 SSE/旧会话，不做网络请求", async () => {
  const h = harness();
  h.install();
  // 旧会话路由的通知归属 push 前的 session，不因路由切换错挂到新会话。
  const staleStream = new h.c.EventSource("/api/agent/alpha/events");
  assert.equal(h.c.history.pushState(null, "", "?session=beta"), 17);
  // pushState 只本地上报，不触发任何 fetch（harness 中 fetch 会直接抛错）。
  assert.deepEqual(h.reports, [{ sessionId: "alpha" }, { sessionId: "beta" }]);
  const pushed = new h.c.EventSource("/api/agent/beta/events");
  staleStream.emit(notify("old"));
  pushed.emit(notify("new"));
  assert.equal(h.notices[0].sessionId, "alpha");
  assert.equal(h.notices[1].sessionId, "beta");
  assert.ok(h.notices.every((item) => item.sessionName === ""));
  // 旧 SSE 的同文提示不能吞掉当前会话的 DOM 提示。
  staleStream.emit(notify("old-only", "旧流提示"));
  h.addToast("旧流提示", "#d97706");
  assert.deepEqual(h.notices.at(-1), {
    sessionId: "beta", sessionName: "", message: "旧流提示", level: "warning", source: "pi-web",
  });
  // 定时兜底：同样的路由不重复上报，回首页时上报空会话。
  await h.tick();
  assert.deepEqual(h.reports, [{ sessionId: "alpha" }, { sessionId: "beta" }]);
  h.c.history.replaceState(null, "", "/");
  assert.deepEqual(h.reports.at(-1), { sessionId: "" });
  await h.tick();
  assert.deepEqual(h.reports.filter((item) => item.sessionId === "").length, 1);
  // 非法 session id 仍被拦截；路径遍历不会进入 reportTab。
  h.c.history.replaceState(null, "", "?session=..%2Fauth");
  assert.deepEqual(h.reports.at(-1), { sessionId: "" });
  assert.ok(!h.reports.some((item) => String(item.sessionId).includes("/")));
  // popstate 兜底：不触发 fetch（harness 中 fetch 会直接抛错）。
  h.c.location.href = "http://127.0.0.1:30141/?session=gamma";
  h.listeners.popstate[0]();
  assert.deepEqual(h.reports.at(-1), { sessionId: "gamma" });
  // 绕过 history 的路由变化也会被定时器发现，不重复报告或附带标题。
  h.c.location.href = "http://127.0.0.1:30141/?session=delta";
  await h.tick();
  await h.tick();
  assert.deepEqual(h.reports, [
    { sessionId: "alpha" }, { sessionId: "beta" }, { sessionId: "" },
    { sessionId: "gamma" }, { sessionId: "delta" },
  ]);
  assert.deepEqual(h.requests, []);
});

test("IPC 失败不影响页面事件，重装不重放通知", async () => {
  const h = harness();
  h.install(); await flush();
  h.c.piWebBox.recordNotice = () => { throw Error("IPC unavailable"); };
  const stream = new h.c.EventSource("/api/agent/alpha/events");
  let delivered = 0;
  stream.onmessage = () => delivered++;
  assert.doesNotThrow(() => stream.emit(notify("unavailable")));
  h.c.piWebBox.recordNotice = () => Promise.reject(Error("IPC rejected"));
  assert.doesNotThrow(() => stream.emit(notify("rejected")));
  await flush();
  assert.equal(delivered, 2);
  assert.equal(h.notices.length, 0);
  h.install(); // 不重放 IPC 失败的通知
  assert.equal(h.notices.length, 0);
});
