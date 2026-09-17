/** 六标签真实 Electron 回归：独立数据目录与模拟服务，不启动 Pi，不修改 package.json。 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { DesktopTabs } = require("../build/desktop-tabs.js");
const { fetchSessionStatus } = require("../build/session-status.js");
const { NoticeStore } = require("../build/notice-store.js");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "box-six-tabs-"));
app.setPath("userData", userData);
const root = path.resolve(__dirname, "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let running = ["s6"];
let suffix = "";
const streams = new Set();
const errors = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ sessions: Array.from({ length: 6 }, (_, i) => ({ id: `s${i+1}`, name: `测试会话${i+1}${suffix}` })) }));
  } else if (url.pathname === "/api/agent/running") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ runningSessionIds: running }));
  } else if (/\/events$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "extension_ui_request", method: "notify", id: `event-${id}`, message: `中文通知-${id}`, notifyType: "info" })}\n\n`);
    streams.add(res); res.on("close", () => streams.delete(res));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>测试页面</title><script>
      const id = new URL(location.href).searchParams.get('session');
      if (id) window.source = new EventSource('/api/agent/'+id+'/events');
    </script>`);
  }
});
let win, tabs, store;
const watchdog = setTimeout(() => { console.error("FAIL timeout", errors); app.exit(1); }, 30000);
const checkUntil = async (fn, label) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(50); }
  throw new Error(label);
};
function publish() { if (tabs && !win.isDestroyed()) win.webContents.send("pi-web-box:desktop-state", tabs.snapshot(store.unreadCount())); }
async function queryStatus(origin) { const result = await fetchSessionStatus(origin); tabs.syncSessions(result.names, result.runningIds); }
(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  store = new NoticeStore(path.join(userData, "notifications.sqlite"));
  win = new BrowserWindow({ width: 960, height: 700, show: true, frame: false, webPreferences: { preload: path.join(root, "build/preload.js"), sandbox: true, contextIsolation: true } });
  win.webContents.on("console-message", (_event, details) => { if (details?.level === "error") errors.push(details.message); });
  ipcMain.handle("pi-web-box:get-desktop-state", () => tabs?.snapshot(store.unreadCount()) ?? null);
  ipcMain.handle("pi-web-box:new-tab", () => tabs.create(origin));
  ipcMain.handle("pi-web-box:close-tab", (_event, id) => tabs.close(id));
  ipcMain.handle("pi-web-box:activate-tab", (_event, id) => tabs.activate(id));
  ipcMain.handle("pi-web-box:reorder-tab", (_event, id, before) => tabs.reorder(id, before));
  ipcMain.handle("pi-web-box:toggle-messages", () => tabs.togglePanel());
  ipcMain.handle("pi-web-box:query-notices", (_event, query) => store.query(query));
  ipcMain.handle("pi-web-box:mark-notices-read", (_event, seq) => { store.markRead(seq); publish(); });
  ipcMain.on("pi-web-box:report-tab", (event, report) => tabs.report(event.sender, report));
  ipcMain.on("pi-web-box:record-notice", (_event, input) => { store.add(input); publish(); });
  await win.loadFile(path.join(root, "build/desktop.html"));
  tabs = new DesktopTabs(win, origin, path.join(root, "build/page-preload.js"), (contents) => {
    contents.on("preload-error", (_event, _path, error) => errors.push(String(error)));
  }, publish);
  win.on("resize", () => tabs.layout());
  win.on("restore", () => tabs.layout());
  for (let i = 1; i <= 6; i++) {
    tabs.create(`${origin}/?session=s${i}`);
    await checkUntil(() => streams.size === i && tabs.all()[i-1].sessionId === `s${i}`, `第${i}个标签/SSE未就绪`);
  }
  await queryStatus(origin);
  assert.deepEqual(tabs.all().map((tab) => tab.title), Array.from({length:6},(_,i)=>`测试会话${i+1}`));
  assert.equal(new Set(tabs.all().map((tab) => tab.color)).size, 6);
  assert.equal(tabs.all()[5].running, true);
  assert.equal(tabs.all().filter((tab) => tab.running).length, 1);
  const originalIds = tabs.all().map((tab) => tab.id);
  tabs.create(origin);
  assert.deepEqual(tabs.all().map((tab) => tab.id), originalIds);
  await checkUntil(() => win.webContents.executeJavaScript("document.querySelectorAll('.tab').length === 6 && document.getElementById('newTabBtn').disabled"), "标签上限UI未生效");
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const last = [...document.querySelectorAll('.tab')].at(-1).getBoundingClientRect();
    const plus = document.getElementById('newTabBtn').getBoundingClientRect();
    return { gap: plus.left-last.right, width:last.width };
  })()`);
  assert.ok(geometry.gap >= 0 && geometry.gap < 16, JSON.stringify(geometry));
  const renderedColors = await win.webContents.executeJavaScript("[...document.querySelectorAll('.tab-dot')].map(dot => getComputedStyle(dot).backgroundColor)");
  assert.equal(new Set(renderedColors).size, 6);
  assert.ok(renderedColors.every(color => color !== 'rgba(0, 0, 0, 0)'));
  console.log("PASS six SSE / six names / unique colors including rendered dots / seventh rejected / plus adjacent");
  const first = tabs.all()[0];
  await win.webContents.executeJavaScript("window.firstTabNode = document.querySelector('.tab'); void 0;");
  running = [];
  await queryStatus(origin);
  await wait(100);
  assert.equal(tabs.all().some((tab) => tab.running), false);
  assert.equal(await win.webContents.executeJavaScript("firstTabNode === document.querySelector('.tab')"), true);
  suffix = "已改名";
  await queryStatus(origin);
  assert.equal(tabs.all()[5].title, "测试会话6已改名");
  tabs.report(tabs.all()[5].view.webContents, { sessionId: "s6" });
  assert.equal(tabs.all()[5].title, "测试会话6已改名");
  const colors = new Map(tabs.all().map((tab) => [tab.id, tab.color]));
  tabs.reorder(first.id, null);
  assert.equal(tabs.all().at(-1).color, colors.get(first.id));
  console.log("PASS running stop / DOM preserved / rename / route preserves name / reorder preserves color");
  await wait(100);
  await win.webContents.executeJavaScript("document.querySelector('.tab').dispatchEvent(new MouseEvent('auxclick', {button:1,bubbles:true})); void 0;");
  await checkUntil(() => tabs.all().length === 5, "中键未关闭标签");
  await checkUntil(() => win.webContents.executeJavaScript("!document.getElementById('newTabBtn').disabled"), "关闭后新增未恢复");
  const remaining = tabs.all().map((tab) => tab.color);
  tabs.create(origin);
  assert.equal(new Set(tabs.all().map((tab) => tab.color)).size, 6);
  assert.deepEqual(tabs.all().slice(0,5).map((tab) => tab.color), remaining);
  const records = store.query({limit:100}).items;
  assert.equal(records.length, 6);
  assert.ok(records.every((record) => record.message === `中文通知-${record.sessionId}`));
  console.log("PASS middle click / reopen color reuse / all six SSE notices exact");
  // 复现 Pi Web 的 640px 窄屏收栏规则，验证真实 Windows 最小化不会误触发。
  const page = tabs.active().view.webContents;
  await checkUntil(() => !page.isLoading(), "测试页面未加载完成");
  await page.executeJavaScript(`window.sidebarOpen = true; window.narrowEvents = [];
    matchMedia('(max-width: 640px)').addEventListener('change', event => {
      narrowEvents.push(event.matches); if (event.matches) sidebarOpen = false;
    }); void 0;`);
  for (const maximized of [false, true]) {
    if (maximized) win.maximize();
    await wait(400);
    const bounds = tabs.all().map(tab => tab.view.getBounds());
    win.minimize();
    await wait(400);
    assert.equal(win.isMinimized(), true);
    tabs.layout();
    assert.deepEqual(tabs.all().map(tab => tab.view.getBounds()), bounds);
    win.restore();
    await wait(500);
    assert.equal(await page.executeJavaScript("sidebarOpen && !narrowEvents.includes(true)"), true);
    assert.equal(tabs.active().view.getBounds().width, win.getContentSize()[0]);
  }
  console.log("PASS normal/maximized minimize-restore / six page bounds preserved / sidebar stays open");
  assert.equal(errors.length, 0, errors.join("\n"));
})().then(() => finish(0), (error) => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(watchdog);
  tabs?.dispose();
  if (win && !win.isDestroyed()) win.destroy();
  store?.close();
  for (const res of streams) res.end();
  server.closeAllConnections();
  server.close(() => app.exit(code));
}
