import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { checkRuntimeEnvironment, compareVersions, isNewerVersion, VersionManager } from "../src/version-manager.js";

test("compareVersions compares stable semantic versions", () => {
  assert.equal(compareVersions("0.84.2", "0.84.2"), 0);
  assert.equal(compareVersions("0.84.3", "0.84.2"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.8.9", "0.10.0"), -1);
});

test("stable versions are newer than prereleases", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
});

test("isNewerVersion only reports a strictly newer latest version", () => {
  assert.equal(isNewerVersion("0.8.9", "0.9.0"), true);
  assert.equal(isNewerVersion("0.9.0", "0.9.0"), false);
  assert.equal(isNewerVersion("1.0.0", "0.9.0"), false);
});

// 用临时目录模拟 PATH，验证环境自检的判定条件（不访问真实环境）。
function isolatedPath(files: string[]): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-box-runtime-"));
  for (const file of files) {
    const target = path.join(dir, file);
    if (file.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  // 不在搜索路径里附加当前工作目录之外的内容；findExecutableOnPath 会先查 cwd。
  return { PATH: dir, Path: dir };
}

test("checkRuntimeEnvironment requires node.exe and npm-cli.js", () => {
  // 空 PATH：三者都找不到。
  assert.deepEqual(checkRuntimeEnvironment(isolatedPath([])), {
    nodePath: "",
    npmPath: "",
    npmCliPath: "",
    npmAvailable: false,
  });
  // 只有 node.exe 时 npm 仍不可用。
  assert.equal(checkRuntimeEnvironment(isolatedPath(["node.exe"])).npmAvailable, false);
  // npm.cmd 就位但缺少 npm-cli.js 时同样判定不可用，避免启动时才失败。
  const withoutCli = checkRuntimeEnvironment(isolatedPath(["node.exe", "npm.cmd"]));
  assert.equal(withoutCli.npmAvailable, false);
  assert.equal(withoutCli.npmPath.endsWith("npm.cmd"), true);
});

test("checkRuntimeEnvironment reports the npm entry once everything is in place", () => {
  const runtime = checkRuntimeEnvironment(
    isolatedPath(["node.exe", "npm.cmd", "node_modules/npm/bin/npm-cli.js"]),
  );
  assert.equal(runtime.npmAvailable, true);
  assert.equal(runtime.nodePath.endsWith("node.exe"), true);
  assert.equal(runtime.npmCliPath.endsWith(path.join("node_modules", "npm", "bin", "npm-cli.js")), true);
});

// 启动自检的两份清单必须互补：已安装的不再要求安装，总数恒等于内置组件个数。
test("checkEnvironment 的缺失清单与已安装清单互补", async () => {
  const check = await new VersionManager(() => {}).checkEnvironment();
  const installedCommands = new Set(check.installed.map((item) => item.commandName));
  for (const item of check.missing) {
    assert.equal(installedCommands.has(item.commandName), false, item.commandName);
    assert.ok(item.packageName.startsWith("@"), item.packageName);
    assert.ok(item.displayName.length > 0, item.commandName);
  }
  assert.equal(check.installed.length + check.missing.length, 2);
  assert.equal(typeof check.npmAvailable, "boolean");
  assert.equal(check.missing.every((item, index, list) => list.findIndex((entry) => entry.commandName === item.commandName) === index), true);
});
