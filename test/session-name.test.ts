import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_SESSION_NAME_CONFIG,
  normalizeSessionNameConfig,
  readSessionNameConfig,
  sessionNameConfigPath,
  validateSessionNameConfig,
  writeSessionNameConfig,
} from "../src/session-name.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "pi-box-session-name-"));
const file = path.join(directory, "pi-session-name.json");

test("默认配置与插件内置默认保持一致", () => {
  assert.deepEqual(DEFAULT_SESSION_NAME_CONFIG, {
    enabled: true,
    provider: "cc-switch-deep-seek",
    model: "deepseek-flash",
  });
});

test("写入后可以读回，文件是格式化 JSON", () => {
  const written = writeSessionNameConfig({ enabled: true, provider: "magpie", model: "cn:glm-5.3" }, file);
  assert.deepEqual(written, { enabled: true, provider: "magpie", model: "cn:glm-5.3" });
  assert.deepEqual(readSessionNameConfig(file), { enabled: true, provider: "magpie", model: "cn:glm-5.3" });
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /\n {2}"enabled": true,/);
  // 不留下临时文件。
  assert.throws(() => readFileSync(`${file}.tmp`, "utf8"));
});

test("非法配置拒绝写入", () => {
  assert.throws(() => writeSessionNameConfig({ enabled: "yes", provider: "", model: "" }, file), /开关状态/);
  // 启用时必须选择模型，避免插件静默落到备用名称。
  assert.throws(() => writeSessionNameConfig({ enabled: true, provider: "", model: "" }, file), /必须选择命名模型/);
  assert.throws(() => writeSessionNameConfig({ enabled: true, provider: "a b", model: "m" }, file), /空格/);
  assert.throws(() => writeSessionNameConfig({ enabled: true, provider: "", model: "x".repeat(201) }, file), /过长/);
  // 关闭状态下允许不选模型。
  assert.deepEqual(writeSessionNameConfig({ enabled: false, provider: "", model: "" }, file), {
    enabled: false,
    provider: "",
    model: "",
  });
});

test("字段缺失或类型不符时回退默认值", () => {
  assert.deepEqual(normalizeSessionNameConfig(undefined), DEFAULT_SESSION_NAME_CONFIG);
  assert.deepEqual(normalizeSessionNameConfig({ enabled: "yes", provider: 7, model: null }), DEFAULT_SESSION_NAME_CONFIG);
  assert.deepEqual(normalizeSessionNameConfig({ provider: "sui-xiang" }), {
    enabled: true,
    provider: "sui-xiang",
    model: "deepseek-flash",
  });
});

test("文件缺失或内容损坏时读取回退默认值", () => {
  assert.deepEqual(readSessionNameConfig(path.join(directory, "missing.json")), DEFAULT_SESSION_NAME_CONFIG);
  const broken = path.join(directory, "broken.json");
  writeFileSync(broken, "{ not json", "utf8");
  assert.deepEqual(readSessionNameConfig(broken), DEFAULT_SESSION_NAME_CONFIG);
});

test("校验函数区分「合法值」与「错误原因」", () => {
  const invalid = validateSessionNameConfig({ enabled: true, provider: "p", model: "" });
  assert.equal(invalid.ok, false);
  const valid = validateSessionNameConfig({ enabled: true, provider: " p ", model: " m " });
  assert.deepEqual(valid, { ok: true, value: { enabled: true, provider: "p", model: "m" } });
});

test("配置文件路径跟随环境变量", () => {
  const previousConfig = process.env.PI_SESSION_NAME_CONFIG_FILE;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_SESSION_NAME_CONFIG_FILE;
    process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
    assert.equal(sessionNameConfigPath(), path.join(directory, "agent", "pi-session-name.json"));
    // 显式覆盖优先，便于测试与特殊部署。
    process.env.PI_SESSION_NAME_CONFIG_FILE = file;
    assert.equal(sessionNameConfigPath(), file);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_SESSION_NAME_CONFIG_FILE;
    else process.env.PI_SESSION_NAME_CONFIG_FILE = previousConfig;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  }
});
