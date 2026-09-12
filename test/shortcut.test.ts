import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isInstalledBuild } from "../src/shortcut.js";

const tempDir = process.env.TEMP || process.env.TMP || "C:\\Temp";

test("installed build is detected from the install directory", () => {
  const execPath = "C:\\Users\\user\\AppData\\Local\\Programs\\Pi Web Box\\Pi Web Box.exe";
  assert.equal(isInstalledBuild(execPath), true);
});

test("portable build is detected when PORTABLE_EXECUTABLE_FILE is set", () => {
  const execPath = path.join(tempDir, "a1b2c3", "Pi Web Box.exe");
  const portable = "D:\\tools\\Pi Web Box Portable-0.4.4.exe";
  assert.equal(isInstalledBuild(execPath, portable), false);
});

test("portable runtime unpacked into Temp is not treated as installed", () => {
  // 便携版会把内容解压到 %TEMP% 下的随机目录再运行，
  // 即使环境变量缺失也不应该被当成安装版去改写快捷方式。
  const execPath = path.join(tempDir, "3JEJgoNouMeCcm7uHSo4YRMvsAK", "Pi Web Box.exe");
  assert.equal(isInstalledBuild(execPath), false);
});
