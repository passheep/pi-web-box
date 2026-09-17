import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  closeSessionStatusAgents, fetchSessionStatus, parseLoopbackOrigin,
  SESSION_STATUS_MAX_BODY_BYTES,
} from "../src/session-status.js";

/** 真实回环服务器；不创建或删除文件。 */
async function startServer(handler: http.RequestListener) {
  const requests: Array<{ url?: string; auth?: string; method?: string }> = [];
  const sockets = new Set<unknown>();
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, method: req.method });
    sockets.add(req.socket);
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests, sockets,
    async close() {
      closeSessionStatusAgents();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function success(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/api/agent/running"
    ? { runningSessionIds: ["s1", "s2"] }
    : { sessions: [{ id: "s1", name: "会话一" }, { id: "s2" }, null] }));
}

test("origin 仅允许回环 http/https，不接受路径或凭据且错误不回显输入", () => {
  for (const origin of ["http://127.0.0.1:30141", "https://localhost", "http://[::1]:30141"]) {
    assert.equal(parseLoopbackOrigin(origin).origin, origin);
  }
  for (const origin of [
    "http://192.168.1.1", "http://example.com", "http://localhost.example.com",
    "ftp://127.0.0.1", "file:///C:/Windows", "not a url",
    "http://user:secret@127.0.0.1", "http://127.0.0.1/path",
    "http://127.0.0.1/?secret=123", "http://127.0.0.1/#secret",
  ]) {
    assert.throws(() => parseLoopbackOrigin(origin), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
});

test("成功、只读固定接口、keepAlive 复用独立连接池", async () => {
  const server = await startServer(success);
  try {
    for (let i = 0; i < 3; i++) {
      const status = await fetchSessionStatus(server.origin);
      assert.deepEqual(status.runningIds, ["s1", "s2"]);
      assert.deepEqual(status.names, new Map([["s1", "会话一"]]));
    }
    assert.equal(server.requests.length, 6);
    assert.ok(server.sockets.size <= 2);
    assert.deepEqual([...new Set(server.requests.map((r) => r.url))].sort(),
      ["/api/agent/running", "/api/sessions"]);
    assert.ok(server.requests.every((r) => r.method === "GET" && r.auth === undefined));
  } finally { await server.close(); }
});

test("Basic Auth 使用 pi 用户名；空密码/未提供不带认证头", async () => {
  const expected = `Basic ${Buffer.from("pi:密码:secret").toString("base64")}`;
  const server = await startServer((req, res) => {
    if (req.headers.authorization === expected) success(req, res);
    else { res.writeHead(401); res.end(); }
  });
  try {
    assert.deepEqual((await fetchSessionStatus(server.origin, "密码:secret")).runningIds, ["s1", "s2"]);
    for (const password of [undefined, "", "wrong"]) {
      assert.deepEqual(await fetchSessionStatus(server.origin, password), { runningIds: null, names: null });
    }
    assert.deepEqual(server.requests.map((r) => r.auth), [
      expected, expected, undefined, undefined, undefined, undefined,
      `Basic ${Buffer.from("pi:wrong").toString("base64")}`,
      `Basic ${Buffer.from("pi:wrong").toString("base64")}`,
    ]);
  } finally { await server.close(); }
});

test("两个接口分别失败返回 null；成功空数组不是失败", async () => {
  let failed = "/api/sessions";
  const server = await startServer((req, res) => {
    if (req.url === failed) { res.writeHead(500); res.end(); }
    else if (failed === "none") {
      res.end(JSON.stringify({ runningSessionIds: [], sessions: [] }));
    } else success(req, res);
  });
  try {
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: ["s1", "s2"], names: null });
    failed = "/api/agent/running";
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: null, names: new Map([["s1", "会话一"]]) });
    failed = "none";
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: [], names: new Map() });
  } finally { await server.close(); }
});

test("连接拒绝、无效 JSON、错误结构与截断响应均为 null", async () => {
  const dead = await startServer(success);
  await dead.close();
  assert.deepEqual(await fetchSessionStatus(dead.origin), { runningIds: null, names: null });
  for (const body of ["not json", "null", "{}", '{"runningSessionIds":null,"sessions":{}}']) {
    const server = await startServer((_req, res) => res.end(body));
    try {
      assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: null, names: null });
    } finally { await server.close(); }
  }
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write("{");
    setImmediate(() => res.destroy());
  });
  try {
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: null, names: null });
  } finally { await server.close(); }
});

test("真实 3 秒总超时，包括不断发送数据的响应", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/api/agent/running") return; // 连接建立后不返回响应头
    res.writeHead(200);
    res.write(" ");
    const timer = setInterval(() => res.write(" "), 100);
    res.on("close", () => clearInterval(timer));
  });
  try {
    const started = Date.now();
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: null, names: null });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_900 && elapsed < 6_000, `elapsed=${elapsed}`);
  } finally { await server.close(); }
});

test("不跟随重定向，目标真实服务器未收到请求", async () => {
  const target = await startServer(success);
  const server = await startServer((_req, res) => {
    res.writeHead(302, { Location: `${target.origin}/redirect-target` });
    res.end();
  });
  try {
    assert.deepEqual(await fetchSessionStatus(server.origin, "secret"), { runningIds: null, names: null });
    assert.equal(target.requests.length, 0);
    assert.equal(server.requests.length, 2);
  } finally { await server.close(); await target.close(); }
});

test("真实 8MB 正文边界，超出一字节失败", async () => {
  let extra = 0;
  const server = await startServer((req, res) => {
    const json = JSON.stringify(req.url === "/api/agent/running"
      ? { runningSessionIds: [] } : { sessions: [] });
    res.end(json + " ".repeat(SESSION_STATUS_MAX_BODY_BYTES - Buffer.byteLength(json) + extra));
  });
  try {
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: [], names: new Map() });
    extra = 1;
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: null, names: null });
  } finally { await server.close(); }
});

test("失败状态即使正文永不结束也释放连接，不阻塞下一轮", async () => {
  let bad = true;
  const server = await startServer((req, res) => {
    if (!bad) return success(req, res);
    res.writeHead(503);
    res.write("incomplete");
  });
  try {
    assert.deepEqual(await fetchSessionStatus(server.origin), { runningIds: null, names: null });
    bad = false;
    assert.deepEqual((await fetchSessionStatus(server.origin)).runningIds, ["s1", "s2"]);
  } finally { await server.close(); }
});
