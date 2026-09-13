import test from "node:test";
import assert from "node:assert/strict";
import { protectDraft, restoreDraft, extractResponseText, SCENE_PROMPTS } from "../src/enhance.js";

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
