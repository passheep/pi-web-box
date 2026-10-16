/**
 * session-title 的单元测试：标题来源文本、后缀清洗、日期前缀与整条
 * 「读对话 → 生成 → 写回会话名」流程（用桩 fetch，不访问真实服务）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  buildTitleSource,
  formatTitleDate,
  generateSessionTitle,
  normalizeGeneratedSuffix,
} from "../src/session-title.js";

/** 让 enhance 读取临时 models.json，避免依赖真实 pi 配置。 */
function useFakeModels(provider = "test", model = "naming-model"): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-box-title-models-"));
  writeFileSync(
    path.join(directory, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "test-key",
          models: [{ id: model, name: model }],
        },
      },
    }),
    "utf8",
  );
  process.env.PI_CODING_AGENT_DIR = directory;
}

/** 用桩 fetch 跑一遍完整流程，返回记录下来的请求。 */
async function withStubbedFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string },
  run: () => Promise<T>,
): Promise<{ result: T; requests: Array<{ url: string; init: RequestInit }> }> {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const stub = handler(url, init);
    const status = stub.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => stub.body ?? {},
      text: async () => stub.text ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("buildTitleSource 提取用户与助手文本，忽略思考与工具调用", () => {
  const source = buildTitleSource([
    { role: "user", content: [{ type: "text", text: "帮我改登录接口" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "内部推理不应进入标题" },
        { type: "text", text: "先看接口实现" },
        { type: "toolCall", toolName: "read" },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: "工具输出也要忽略" }] },
    { role: "user", content: "再补一个测试" },
  ]);
  assert.equal(source, "用户：帮我改登录接口\n\n助手：先看接口实现\n\n用户：再补一个测试");
  assert.ok(!source.includes("内部推理"));
  assert.ok(!source.includes("工具输出"));
});

test("buildTitleSource 对非法输入返回空串", () => {
  assert.equal(buildTitleSource(undefined), "");
  assert.equal(buildTitleSource("not an array"), "");
  assert.equal(buildTitleSource([{ role: "user", content: "   " }]), "");
  assert.equal(buildTitleSource([null, 7, { role: "system", content: "忽略" }]), "");
});

test("buildTitleSource 过长时保留开头目标与最近进展", () => {
  const long = "甲".repeat(20_000);
  const source = buildTitleSource([{ role: "user", content: long }]);
  assert.ok(source.length <= 12_000 + 20);
  assert.match(source, /中间内容已省略/);
  assert.ok(source.startsWith("用户：甲"));
  assert.ok(source.endsWith("甲"));
});

test("normalizeGeneratedSuffix 与插件规则一致", () => {
  assert.equal(normalizeGeneratedSuffix("标题：修复登录接口异常"), "修复登录接口异常");
  assert.equal(normalizeGeneratedSuffix('“修复 Vue/API 命名问题”'), "修复-Vue-API-命名问题");
  assert.equal(normalizeGeneratedSuffix("```text\nJava 项目构建排查\n```"), "Java-项目构建排查");
  assert.equal(normalizeGeneratedSuffix("20261016-会话标题"), "会话标题");
  assert.equal(normalizeGeneratedSuffix("超".repeat(40)).length, 30);
  assert.equal(normalizeGeneratedSuffix("   \n  "), "");
});

test("formatTitleDate 使用本地日期，非法输入回退今天", () => {
  assert.equal(formatTitleDate(new Date(2026, 9, 16, 10, 30).toISOString()), "20261016");
  assert.equal(formatTitleDate(new Date(2026, 0, 5).getTime()), "20260105");
  assert.equal(formatTitleDate("not a date"), formatTitleDate(new Date()));
  assert.equal(formatTitleDate(undefined), formatTitleDate(new Date()));
});

test("generateSessionTitle 读对话、调用模型并写回会话名", async () => {
  useFakeModels();
  const { result, requests } = await withStubbedFetch(
    (url) => {
      if (url.includes("/api/sessions/session-1?")) {
        return { body: { context: { messages: [{ role: "user", content: [{ type: "text", text: "实现自动命名" }] }] }, info: { created: "2026-10-16T01:13:55.279Z" } } };
      }
      if (url.endsWith("/chat/completions")) {
        return { body: { choices: [{ message: { content: "标题：自动命名插件开发" } }] } };
      }
      if (url.endsWith("/api/sessions/session-1")) {
        return { body: { ok: true } };
      }
      return { status: 404 };
    },
    () => generateSessionTitle({
      origin: "http://127.0.0.1:30141",
      sessionId: "session-1",
      provider: "test",
      model: "naming-model",
    }),
  );

  assert.deepEqual(result, { ok: true, name: "20261016-自动命名插件开发" });
  assert.equal(requests.length, 3);
  // 1) 读会话上下文：只带必要的查询参数
  assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:30141\/api\/sessions\/session-1\?deferThinking=1&deferMedia=1&tail=100$/);
  // 2) 调模型：走 models.json 里的 baseUrl
  assert.match(requests[1].url, /^http:\/\/127\.0\.0\.1:9\/v1\/chat\/completions$/);
  assert.equal((requests[1].init.headers as Record<string, string>).Authorization, "Bearer test-key");
  // 3) 写回会话名
  assert.equal(requests[2].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), { name: "20261016-自动命名插件开发" });
});

test("generateSessionTitle 带上访问密码的 Basic 认证", async () => {
  useFakeModels();
  const { requests } = await withStubbedFetch(
    (url) => (url.includes("/api/sessions/")
      ? { body: { context: { messages: [{ role: "user", content: "hi" }] }, info: { created: "2026-10-16T00:00:00.000Z" } } }
      : { body: { choices: [{ message: { content: "打招呼" } }] } }),
    () => generateSessionTitle({
      origin: "http://127.0.0.1:30141",
      sessionId: "session-1",
      provider: "test",
      model: "naming-model",
      password: "密码",
    }),
  );
  const expected = `Basic ${Buffer.from("pi:密码").toString("base64")}`;
  for (const request of requests.filter((item) => item.url.includes("/api/sessions/"))) {
    assert.equal((request.init.headers as Record<string, string>).Authorization, expected);
  }
});

test("generateSessionTitle 提前拒绝缺模型、缺会话与非回环地址", async () => {
  useFakeModels();
  assert.deepEqual(
    await generateSessionTitle({ origin: "http://127.0.0.1:30141", sessionId: "s", provider: "", model: "" }),
    { ok: false, message: "请先在「Box 设置 → 会话命名」中选择命名模型。" },
  );
  assert.deepEqual(
    await generateSessionTitle({ origin: "http://127.0.0.1:30141", sessionId: "", provider: "test", model: "m" }),
    { ok: false, message: "当前标签还没有关联会话，先发一条消息再试。" },
  );
  const blocked = await generateSessionTitle({ origin: "http://example.com", sessionId: "s", provider: "test", model: "m" });
  assert.equal(blocked.ok, false);
});

test("generateSessionTitle 把读取失败、空对话与模型错误如实返回", async () => {
  useFakeModels();
  const missing = await withStubbedFetch(
    () => ({ status: 404, body: { error: "Session not found" } }),
    () => generateSessionTitle({ origin: "http://127.0.0.1:30141", sessionId: "s", provider: "test", model: "naming-model" }),
  );
  assert.deepEqual(missing.result, { ok: false, message: "读取会话内容失败：HTTP 404（会话不存在）" });

  const empty = await withStubbedFetch(
    () => ({ body: { context: { messages: [] }, info: {} } }),
    () => generateSessionTitle({ origin: "http://127.0.0.1:30141", sessionId: "s", provider: "test", model: "naming-model" }),
  );
  assert.deepEqual(empty.result, { ok: false, message: "这个会话还没有可用于命名的对话内容。" });

  const modelFailure = await withStubbedFetch(
    (url) => (url.includes("/api/sessions/")
      ? { body: { context: { messages: [{ role: "user", content: "hi" }] }, info: {} } }
      : { status: 401, text: "unauthorized" }),
    () => generateSessionTitle({ origin: "http://127.0.0.1:30141", sessionId: "s", provider: "test", model: "naming-model" }),
  );
  assert.deepEqual(modelFailure.result, { ok: false, message: "模型返回 HTTP 401：unauthorized" });
});
