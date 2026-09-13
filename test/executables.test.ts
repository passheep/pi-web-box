import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutableOnPath } from "../src/executables.js";

/** 建一个临时目录充当 PATH 条目。 */
function makeTempDir(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pwbox-${label}-`));
  return directory;
}

/** 在目录里放一个可执行名对应的空文件。 */
function touch(directory: string, name: string): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, "");
  return file;
}

test("findExecutableOnPath finds a command inside PATH", () => {
  const directory = makeTempDir("hit");
  touch(directory, "pi.cmd");
  const found = findExecutableOnPath(["pi.cmd"], { PATH: directory });
  assert.equal(found, path.join(directory, "pi.cmd"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("findExecutableOnPath returns undefined when nothing matches", () => {
  const directory = makeTempDir("miss");
  const found = findExecutableOnPath(["definitely-missing-pi.cmd"], { PATH: directory });
  assert.equal(found, undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("findExecutableOnPath takes the first PATH entry that matches", () => {
  const first = makeTempDir("first");
  const second = makeTempDir("second");
  touch(first, "pi.cmd");
  touch(second, "pi.cmd");
  const found = findExecutableOnPath(["pi.cmd"], { PATH: [first, second].join(path.delimiter) });
  assert.equal(found, path.join(first, "pi.cmd"));
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

test("findExecutableOnPath ignores directories that share the command name", () => {
  const directory = makeTempDir("dirhit");
  // 同名目录不应被当成可执行文件，否则会拿目录去启动子进程。
  fs.mkdirSync(path.join(directory, "pi.cmd"));
  const found = findExecutableOnPath(["pi.cmd"], { PATH: directory });
  assert.equal(found, undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("findExecutableOnPath skips missing PATH entries without throwing", () => {
  const directory = makeTempDir("partial");
  touch(directory, "pi-web.cmd");
  const missing = path.join(os.tmpdir(), "pwbox-not-existing-dir");
  const found = findExecutableOnPath(["pi-web.cmd"], { PATH: [missing, directory].join(path.delimiter) });
  assert.equal(found, path.join(directory, "pi-web.cmd"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("findExecutableOnPath appends platform extensions when the name has none", () => {
  const directory = makeTempDir("ext");
  const expected = touch(directory, process.platform === "win32" ? "mytool.cmd" : "mytool");
  const found = findExecutableOnPath(["mytool"], { PATH: directory });
  assert.equal(found, expected);
  fs.rmSync(directory, { recursive: true, force: true });
});
