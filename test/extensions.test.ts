import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkUsageLogExtension, extensionsDirectory, piAgentDirectory } from "../src/extensions.js";

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
