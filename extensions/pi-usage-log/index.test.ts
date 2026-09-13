import assert from "node:assert/strict";
import test from "node:test";

import usageLogExtension, { buildUsageRow, logFilePath, usageRowKey } from "./index.ts";

const SAMPLE_USAGE = {
  input: 7682,
  output: 111,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 7793,
  cost: { total: 0.026245 },
};

test("构建 PiDeck 兼容日志行：字段顺序与格式", () => {
  const row = buildUsageRow(
    {
      timestamp: 1787533141169,
      provider: "cc-switch-deep-seek",
      model: "deepseek-v4-flash",
      usage: SAMPLE_USAGE,
    },
    "ephemeral",
    "C:\\Users\\yzy90\\AppData\\Roaming\\pi-desktop\\chat-workspace",
  );
  assert.deepEqual(row, [
    1787533141169,
    "ephemeral",
    "C:\\Users\\yzy90\\AppData\\Roaming\\pi-desktop\\chat-workspace",
    "cc-switch-deep-seek/deepseek-v4-flash",
    7682,
    111,
    0,
    0,
    7793,
    0.026245,
    1,
  ]);
});

test("费用为 0 时 costKnown 标记为 0", () => {
  const row = buildUsageRow(
    {
      timestamp: 1,
      provider: "p",
      model: "m",
      usage: { input: 10, output: 1, totalTokens: 11, cost: { total: 0 } },
    },
    "ephemeral",
    ".",
  );
  assert.equal(row?.[10], 0);
});

test("总 token 为 0 的空回复不记录", () => {
  assert.equal(
    buildUsageRow({ provider: "p", model: "m", usage: { input: 0, output: 0 } }, "ephemeral", "."),
    null,
  );
});

test("无 usage 的消息不记录", () => {
  assert.equal(buildUsageRow({ provider: "p", model: "m" }, "ephemeral", "."), null);
});

test("缺 totalTokens 时按 input+output+cache 求和", () => {
  const row = buildUsageRow(
    { provider: "p", model: "m", usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5 } },
    "ephemeral",
    ".",
  );
  assert.equal(row?.[8], 175);
});

test("去重 key 与 PiDeck 解析器一致：ts|sid|model", () => {
  const row = [1, "ephemeral", ".", "p/m", 10, 1, 0, 0, 11, 0.1, 1];
  assert.equal(usageRowKey(row), "1|ephemeral|p/m");
});

test("日志路径落在 ~/.pi/agent/analytics/usage.jsonl，且支持 PI_CODING_AGENT_DIR 覆盖", () => {
  const defaultPath = logFilePath();
  assert.ok(defaultPath.endsWith("usage.jsonl"));
  assert.ok(defaultPath.replace(/\\/g, "/").includes(".pi/agent/analytics/"));

  process.env.PI_CODING_AGENT_DIR = "C:/test-agent";
  try {
    assert.equal(logFilePath().replace(/\\/g, "/"), "C:/test-agent/analytics/usage.jsonl");
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("只处理 assistant 消息，其余角色直接跳过不抛异常", () => {
  const handlers = new Map<string, Function>();
  usageLogExtension({
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
  } as never);

  const messageEnd = handlers.get("message_end");
  assert.ok(messageEnd);
  messageEnd({ message: { role: "user" } }, { cwd: "." });
  messageEnd({ message: { role: "toolResult" } }, { cwd: "." });
  messageEnd({ message: { role: "assistant", usage: null } }, { cwd: "." });
});
