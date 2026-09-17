/** 独立 Electron 实验：复现同源六条 SSE 占满 HTTP/1.1 连接，不访问真实 Pi Web。 */
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "box-connection-check-")));
const streams = new Set();
let nameRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/events/")) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": connected\n\n");
    streams.add(res);
    res.on("close", () => streams.delete(res));
  } else if (req.url.startsWith("/name/")) {
    nameRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: req.url }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>连接上限实验</title>");
  }
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let win;
const watchdog = setTimeout(() => { console.error("FAIL watchdog"); app.exit(1); }, 20000);
(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(origin);
  await win.webContents.executeJavaScript(`window.streams = Array.from({length:6},(_,i)=>new EventSource('/events/'+i)); void 0;`);
  for (let i = 0; i < 100 && streams.size !== 6; i++) await wait(50);
  assert.equal(streams.size, 6, "六条 SSE 均已建立，避免把握手延迟误判为排队");
  await win.webContents.executeJavaScript(`window.names=[]; window.jobs=Array.from({length:6},(_,i)=>fetch('/name/'+i).then(r=>r.json()).then(v=>names.push(v))); void 0;`);
  await wait(2800);
  const blocked = await win.webContents.executeJavaScript("names.length");
  console.log(JSON.stringify({ phase: "six-sse", streams: streams.size, browserNames: blocked, serverNameRequests: nameRequests }));
  assert.equal(blocked, 0, "占满六条 SSE 后，名称查询应超过原有 2.5 秒超时仍未完成");
  assert.equal(nameRequests, 0, "请求未抵达服务器，证明是浏览器连接排队而非后端 404");
  const nodeName = await new Promise((resolve, reject) => {
    http.get(origin + "/name/node", { agent: false }, (res) => {
      let text = ""; res.on("data", (data) => text += data); res.on("end", () => resolve(JSON.parse(text).name));
    }).on("error", reject);
  });
  assert.equal(nodeName, "/name/node");
  console.log("PASS independent-node-request");
  await win.webContents.executeJavaScript("streams[5].close()");
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript("names.length") === 6) break;
    await wait(50);
  }
  assert.equal(await win.webContents.executeJavaScript("names.length"), 6);
  console.log("PASS six-name-requests-resume-after-one-sse-closes");
})().then(() => finish(0), (error) => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  for (const res of streams) res.end();
  server.closeAllConnections();
  server.close(() => app.exit(code));
}
