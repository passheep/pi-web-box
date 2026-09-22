/**
 * 询问提醒真实 Electron 回归：独立数据目录与模拟服务，不启动 Pi，不修改 package.json。
 *
 * 覆盖「Pi Web 页面 SSE 的等待输入弹窗 → 页面主世界捕获 → 沙箱桥 → 主进程 → AttentionController」
 * 整条链路，用真实的 build/page-preload.js，只有提醒出口（任务栏/托盘/通知）用桩函数记录调用。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { DesktopTabs, isServiceUrl } = require("../build/desktop-tabs.js");
const { AttentionController } = require("../build/attention.js");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "box-attention-"));
app.setPath("userData", userData);
const root = path.resolve(__dirname, "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const streams = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (/\/events$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "connected", sessionId: id, isStreaming: false })}\n\n`);
    streams.set(id, res);
    res.on("close", () => streams.delete(id));
  } else if (url.pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [{ id: "s1", name: "询问提醒验证会话" }] }));
  } else if (url.pathname === "/api/agent/running") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runningSessionIds: [] }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>测试页面</title><script>
      const id = new URL(location.href).searchParams.get('session');
      if (id) window.source = new EventSource('/api/agent/' + id + '/events');
    </script>`);
  }
});
// 直接向指定会话的 SSE 连接推事件，模拟 pi-web 服务端的扩展 UI 请求。
const push = (id, payload) => {
  const stream = streams.get(id);
  if (!stream) throw new Error(`SSE 未就绪：${id}`);
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
};

let win, tabs, attention;
// 窗口状态与设置开关都由测试驱动，避免依赖真实窗口的焦点行为。
const state = { focused: false, visible: false, enabled: true };
const calls = [];
const notices = [];
const logs = [];
const watchdog = setTimeout(() => { console.error("FAIL timeout"); app.exit(1); }, 40000);
const checkUntil = async (fn, label) => {
  for (let i = 0; i < 120; i++) { if (await fn()) return; await wait(50); }
  throw new Error(label);
};

(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ width: 960, height: 700, show: false, frame: false, webPreferences: { preload: path.join(root, "build/preload.js"), sandbox: true, contextIsolation: true } });
  attention = new AttentionController({
    enabled: () => state.enabled,
    isFocused: () => state.focused,
    isVisible: () => state.visible,
    flash: (active) => calls.push(`flash:${active}`),
    setTrayAttention: (active) => calls.push(`tray:${active}`),
    notify: (notice) => notices.push(notice),
    sessionName: (id) => (id === "s1" ? "询问提醒验证会话" : ""),
    log: (message) => logs.push(message),
  });
  // 与 main.ts 的接线保持一致：只接受已注册标签主框架、且 URL 属于服务 origin 的上报。
  ipcMain.handle("pi-web-box:get-desktop-state", () => null);
  ipcMain.on("pi-web-box:report-tab", (event, report) => tabs.report(event.sender, report));
  ipcMain.on("pi-web-box:report-attention", (event, report) => {
    const tab = tabs?.fromContents(event.sender);
    if (!tab || event.senderFrame !== event.sender.mainFrame || !tabs || !isServiceUrl(event.sender.getURL(), tabs.origin)) return;
    if (report?.active !== true) {
      attention.resolve(tab.id, report.requestId);
      return;
    }
    attention.raise({
      tabId: tab.id, sessionId: report.sessionId || tab.sessionId, requestId: report.requestId,
      method: report.method || "", title: report.title || "", message: report.message || "",
      optionCount: Number.isFinite(report.optionCount) ? report.optionCount : 0,
    });
  });
  await win.loadFile(path.join(root, "build/desktop.html"));
  tabs = new DesktopTabs(win, origin, path.join(root, "build/page-preload.js"), () => {}, () => {});
  tabs.create(`${origin}/?session=s1`);
  await checkUntil(() => streams.has("s1") && tabs.all()[0].sessionId === "s1", "标签与 SSE 未就绪");
  await wait(200);

  // 1) 窗口已隐藏到托盘：闪托盘图标并弹系统通知，正文取弹窗首行（预览块不进通知）。
  push("s1", { type: "extension_ui_request", id: "req-1", method: "select", title: "[方案] 选哪个？\n\n--- 1. A 预览 ---\n细节", options: [{ label: "A" }, { label: "B" }, { label: "C" }] });
  await checkUntil(() => notices.length === 1, "未收到询问提醒");
  assert.deepEqual(calls, ["tray:true"]);
  assert.deepEqual(notices[0], { sessionId: "s1", title: "询问提醒验证会话 · 需要你的回答", body: "[方案] 选哪个？（3 个选项）" });
  console.log("PASS 隐藏到托盘：闪托盘 + 系统通知，正文取自首行");

  // 2) 窗口可见但未聚焦：改闪任务栏按钮；同一弹窗重复下发不重复提醒。
  state.visible = true;
  attention.refresh();
  push("s1", { type: "extension_ui_request", id: "req-1", method: "select", title: "重绘", options: [] });
  await wait(200);
  assert.deepEqual(calls, ["tray:true", "flash:true", "tray:false"]);
  assert.equal(notices.length, 1);
  console.log("PASS 可见未聚焦：切换为任务栏闪烁，重复下发不重复提醒");

  // 3) 弹窗关闭：撤销提醒并停止闪烁。
  push("s1", { type: "extension_ui_closed", id: "req-1" });
  await checkUntil(() => calls.length === 4, "关闭后未停止提醒");
  assert.deepEqual(calls, ["tray:true", "flash:true", "tray:false", "flash:false"]);
  console.log("PASS 弹窗关闭：撤销提醒并停止闪烁");

  // 4) notify / setStatus 只是展示，不算等待用户输入。
  push("s1", { type: "extension_ui_request", id: "n-1", method: "notify", message: "普通提示", notifyType: "info" });
  push("s1", { type: "extension_ui_request", id: "w-1", method: "setStatus", statusKey: "k", statusText: "忙" });
  await wait(300);
  assert.equal(notices.length, 1);
  assert.deepEqual(calls, ["tray:true", "flash:true", "tray:false", "flash:false"]);
  console.log("PASS notify / setStatus 不触发询问提醒");

  // 5) confirm 同样覆盖，问题正文来自 message 而不是弹窗标题；同时验证通道切回托盘。
  state.visible = false;
  attention.refresh();
  push("s1", { type: "extension_ui_request", id: "req-2", method: "confirm", title: "确认", message: "确认删除这条记录吗？" });
  await checkUntil(() => notices.length === 2, "confirm 未触发提醒");
  assert.deepEqual(notices[1], { sessionId: "s1", title: "询问提醒验证会话 · 需要你的回答", body: "确认删除这条记录吗？" });
  assert.equal(calls.at(-1), "tray:true");
  console.log("PASS confirm 弹窗同样提醒，正文取 message 首行");

  // 6) 设置里关掉「等待回答时提醒」后不再提醒，重新打开立刻恢复。
  state.enabled = false;
  attention.refresh();
  assert.equal(calls.at(-1), "tray:false");
  push("s1", { type: "extension_ui_request", id: "req-3", method: "input", title: "请输入名称" });
  await wait(300);
  assert.equal(notices.length, 2);
  assert.equal(calls.at(-1), "tray:false");
  state.enabled = true;
  push("s1", { type: "extension_ui_request", id: "req-4", method: "input", title: "请输入名称" });
  await checkUntil(() => notices.length === 3, "重新打开开关后未恢复提醒");
  assert.deepEqual(notices[2], { sessionId: "s1", title: "询问提醒验证会话 · 需要你的回答", body: "请输入名称" });
  assert.equal(calls.at(-1), "tray:true");
  console.log("PASS 提醒开关：关掉不打扰，重新打开立刻恢复");
  assert.deepEqual(logs, []);
})().then(() => finish(0), (error) => { console.error(error); finish(1); });

function finish(code) {
  clearTimeout(watchdog);
  tabs?.dispose();
  if (win && !win.isDestroyed()) win.destroy();
  for (const stream of streams.values()) stream.end();
  server.closeAllConnections();
  server.close(() => app.exit(code));
}