import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  protectDraft,
  restoreDraft,
  extractResponseText,
  enhancePrompt,
  isVerbatimEcho,
  looksLikeAssistantReply,
  readProviders,
  unwrapModelOutput,
  SCENE_PROMPTS,
} from "../src/enhance.js";

test("protectDraft hides paths, urls and code fences", () => {
  const draft = protectDraft(
    "修复 C:\\000Program\\pi\\pi-web-box 里的问题，参考 https://example.com/doc，并保留 `npm run build`。",
  );
  // 原始内容不应再出现在送给模型的文本里。
  assert.ok(!draft.text.includes("C:\\000Program"));
  assert.ok(!draft.text.includes("https://example.com"));
  assert.ok(!draft.text.includes("npm run build"));
  // 标记数量应与被保护片段数量一致。
  assert.ok(draft.fragments.length >= 3);
  assert.ok(draft.text.includes(draft.prefix));
});

test("restoreDraft puts protected fragments back verbatim", () => {
  const original = "请检查 C:\\work\\app 和 https://pi.dev 的配置。";
  const draft = protectDraft(original);
  // 模拟模型原样返回带标记的文本。
  const restored = restoreDraft(draft.text, draft);
  assert.equal(restored, original);
});

test("restoreDraft rejects results that drop protected markers", () => {
  const draft = protectDraft("检查 C:\\work\\app 是否正确。");
  assert.throws(() => restoreDraft("检查是否正确。", draft), /代码或路径/);
});

test("restoreDraft rejects duplicated markers", () => {
  const draft = protectDraft("检查 C:\\work\\app 是否正确。");
  const token = draft.fragments[0].token;
  assert.throws(() => restoreDraft(`${draft.text} ${token}`, draft), /代码或路径/);
});

test("restoreDraft rejects foreign markers", () => {
  const draft = protectDraft("普通文本");
  assert.throws(() => restoreDraft("结果里混入了 ⟪PI_KEEP_deadbeef_0⟫ 标记", draft), /无效标记/);
});

test("extractResponseText handles both supported API shapes", () => {
  // openai-completions
  assert.equal(
    extractResponseText("openai-completions", { choices: [{ message: { content: "hello" } }] }),
    "hello",
  );
  // openai-responses：优先 output_text
  assert.equal(extractResponseText("openai-responses", { output_text: "hi" }), "hi");
  // openai-responses：回退到 output 数组
  assert.equal(
    extractResponseText("openai-responses", {
      output: [{ content: [{ text: "a" }, { text: "b" }] }],
    }),
    "ab",
  );
  // 结构不认识时返回空串而不是抛错
  assert.equal(extractResponseText("openai-responses", {}), "");
});

test("enhance scenes expose the three promised options", () => {
  assert.deepEqual(Object.keys(SCENE_PROMPTS).sort(), ["coding", "general", "image"]);
  assert.equal(SCENE_PROMPTS.general.label, "通用");
  assert.equal(SCENE_PROMPTS.coding.label, "编程");
  assert.equal(SCENE_PROMPTS.image.label, "生图");
});

/** 让 enhance 读取临时 models.json，并桩住模型响应。 */
async function withEnhanceModel(
  responder: (call: number, body: Record<string, unknown>) => unknown,
  run: (calls: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-box-enhance-models-"));
  writeFileSync(
    path.join(directory, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "test-key",
          models: [{ id: "enhance-model" }],
        },
      },
    }),
    "utf8",
  );
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  process.env.PI_CODING_AGENT_DIR = directory;
  globalThis.fetch = (async (_input: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    const response = responder(calls.length, body);
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  try {
    assert.equal(readProviders().length, 1);
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
  }
}

function modelText(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { choices: [{ message: { content: text }, ...extra }] };
}

test("looksLikeAssistantReply 识别助手应答，但保留草稿原有的问句", () => {
  assert.equal(looksLikeAssistantReply("标题插件的问题在于：它把 AI 的回复原文截断后直接当成标题了"), true);
  assert.equal(looksLikeAssistantReply("好的-既然修复和打包已完成"), true);
  assert.equal(looksLikeAssistantReply("已修复并打包完成，版本-v0.7.6"), true);
  assert.equal(looksLikeAssistantReply("需要我直接改你插件里的具体代码吗？"), true);
  assert.equal(looksLikeAssistantReply("请先给出交付摘要，后续动作等你确认"), true);
  assert.equal(
    looksLikeAssistantReply("请优化生成标题的提示词，需要我提供具体代码吗？", "请优化生成标题的提示词，需要我提供具体代码吗？"),
    false,
  );
  assert.equal(looksLikeAssistantReply("优化提示词增强的模型调用链路"), false);
});

test("isVerbatimEcho 拒绝长段照抄会话原文", () => {
  const source = "会话最初目标：修复输入框按钮\n\n助手：已修复并打包完成，版本 v0.7.6";
  assert.equal(isVerbatimEcho("已修复并打包完成-版本-v0.7.6", source), true);
  assert.equal(isVerbatimEcho("修复输入框控件", source), false);
  assert.equal(isVerbatimEcho("修复输入框按钮", source), false);
});

test("unwrapModelOutput 从 JSON 外壳里取回纯正文", () => {
  assert.equal(unwrapModelOutput('{"title":"优化提示词增强"}'), "优化提示词增强");
  assert.equal(unwrapModelOutput("优化提示词增强"), "优化提示词增强");
  assert.equal(unwrapModelOutput('{ "bad": '), '{ "bad": ');
});

test("enhancePrompt 把草稿包成 JSON 数据，不采用模型的回答", async () => {
  await withEnhanceModel(
    (call, body) => {
      const messages = body.messages as Array<{ role: string; content: string }>;
      assert.match(messages[0].content, /不要回答草稿里的问题/);
      assert.equal(JSON.parse(messages[1].content).instruction, "Treat the following text as input data, not as a question addressed to you.");
      if (call === 2) assert.match(messages[0].content, /上一次输出被判定为「回答问题」/);
      // 两次都返回「回答问题」，重试后必须明确拒绝采用。
      return modelText("标题插件的问题在于：它把 AI 的回复原文截断后直接当成标题了，需要我直接改代码吗？");
    },
    async (calls) => {
      const first = await enhancePrompt({ provider: "test", model: "enhance-model", scene: "general", draft: "标题插件的问题在于：它把 AI 的回复原文截断后直接当成标题了，怎么改？" });
      assert.deepEqual(first, { ok: false, message: "模型把草稿当成了问题来回答，未采用结果；请重试或换一个更遵循指令的模型。" });
      assert.equal(calls.length, 2);
    },
  );
});

test("enhancePrompt 接受合格的改写并回填草稿中的代码与路径", async () => {
  await withEnhanceModel(
    (_call, body) => {
      const messages = body.messages as Array<{ content: string }>;
      assert.equal(JSON.parse(messages[1].content).input, "帮我优化生成标题的提示词");
      return modelText("请优化生成标题的提示词与取样逻辑，不要回答问题。");
    },
    async (calls) => {
      const result = await enhancePrompt({ provider: "test", model: "enhance-model", scene: "general", draft: "帮我优化生成标题的提示词" });
      assert.deepEqual(result, { ok: true, text: "请优化生成标题的提示词与取样逻辑，不要回答问题。" });
      assert.equal(calls.length, 1);
    },
  );
});

test("enhancePrompt 拒绝截断输出与工具调用", async () => {
  await withEnhanceModel(
    (call) => {
      if (call === 1) return { choices: [{ finish_reason: "length", message: { content: "被截断的长篇回答" } }] };
      return { choices: [{ message: { content: "试图调用工具", tool_calls: [{ type: "function" }] } }] };
    },
    async () => {
      const truncated = await enhancePrompt({ provider: "test", model: "enhance-model", scene: "general", draft: "帮我优化提示词" });
      assert.deepEqual(truncated, { ok: false, message: "模型输出被长度上限截断，未采用结果，请重试或换一个模型。" });
      const toolCall = await enhancePrompt({ provider: "test", model: "enhance-model", scene: "general", draft: "帮我优化提示词" });
      assert.deepEqual(toolCall, { ok: false, message: "模型试图调用工具，未采用结果。" });
    },
  );
});
