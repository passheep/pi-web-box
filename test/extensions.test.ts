import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
  checkBuiltinExtension,
  checkUsageLogExtension,
  extensionsDirectory,
  installBuiltinExtension,
  piAgentDirectory,
} from "../src/extensions.js";

test("extensions directory follows the pi agent directory", () => {
  const expected = path.join(piAgentDirectory(), "extensions");
  assert.equal(extensionsDirectory(), expected);
});

test("checkUsageLogExtension reports the target install path", () => {
  const status = checkUsageLogExtension("C:\\resources", true, "C:\\resources");
  assert.equal(status.name, "pi-usage-log");
  // 安装路径必须落在 pi 的扩展目录下，否则 pi 不会加载。
  assert.equal(status.installPath, path.join(extensionsDirectory(), "pi-usage-log"));
  // 资源路径不可用时如实标记，便于界面提示而不是假装成功。
  assert.equal(status.sourceAvailable, false);
  // 未安装且无来源时不应被判定为「已是最新」。
  assert.equal(status.upToDate, false);
});

test("checkUsageLogExtension detects the bundled source in development layout", () => {
  // 开发环境下内置扩展位于仓库根的 extensions/ 目录，这里用真实路径验证能被识别。
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const status = checkUsageLogExtension(repoRoot, false, repoRoot);
  assert.equal(status.sourceAvailable, true);
  assert.ok(status.sourcePath.endsWith("pi-usage-log"));
});

test("checkBuiltinExtension 也支持会话命名插件", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const status = checkBuiltinExtension("pi-session-name", repoRoot, false, repoRoot);
  assert.ok(status);
  assert.equal(status!.name, "pi-session-name");
  assert.equal(status!.displayName, "会话自动命名");
  // 安装路径必须落在 pi 的扩展目录下，否则 pi 不会加载。
  assert.equal(status!.installPath, path.join(extensionsDirectory(), "pi-session-name"));
  assert.equal(status!.sourceAvailable, true);
  // 本地已有 package.json 版本时才可能判定为最新，这里不强求具体结果，但字段必须是布尔值。
  assert.equal(typeof status!.upToDate, "boolean");
});

test("未知扩展名直接拒绝，避免把任意目录名传给安装逻辑", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  assert.equal(checkBuiltinExtension("../evil", repoRoot, false, repoRoot), undefined);
  assert.equal(checkBuiltinExtension("pi-delete-guard", repoRoot, false, repoRoot), undefined);
  assert.equal(checkBuiltinExtension("", repoRoot, false, repoRoot), undefined);
});

// 安装会把内置插件复制到用户的扩展目录：清单里的文件必须齐全，且不能删掉用户自己的文件。
test("installBuiltinExtension 复制会话命名插件（含测试文件）并保留其它文件", async () => {
  const agentDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-box-install-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  try {
    const target = path.join(agentDirectory, "extensions", "pi-session-name");
    mkdirSync(target, { recursive: true });
    // 用户自己放在插件目录里的文件必须原样保留。
    writeFileSync(path.join(target, "notes.txt"), "keep me", "utf8");
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const result = await installBuiltinExtension("pi-session-name", repoRoot, false, repoRoot);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.status?.installed, true);
    for (const file of ["index.ts", "package.json", "README.md", "index.test.ts"]) {
      assert.ok(existsSync(path.join(target, file)), file);
    }
    // 复制过来的实现必须是可配置（读取 pi-session-name.json）的新版本。
    assert.match(readFileSync(path.join(target, "index.ts"), "utf8"), /pi-session-name\.json/);
    assert.equal(readFileSync(path.join(target, "notes.txt"), "utf8"), "keep me");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
