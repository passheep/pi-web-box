import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { AGENTS_TEMPLATE, ensureAgentsFile, getPiPaths } from "../src/pi-config.js";

/** 在临时 agent 目录下执行，避免碰到真实的 ~/.pi/agent。 */
function withAgentDirectory(run: (directory: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-box-pi-config-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    run(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("getPiPaths 跟随 PI_CODING_AGENT_DIR 并如实报告存在状态", () => {
  withAgentDirectory((directory) => {
    assert.deepEqual(getPiPaths(), {
      directory,
      directoryExists: true,
      agentsFile: path.join(directory, "AGENTS.md"),
      agentsExists: false,
    });
    writeFileSync(path.join(directory, "AGENTS.md"), "我的规则\n", "utf8");
    assert.equal(getPiPaths().agentsExists, true);
  });
});

test("ensureAgentsFile 只在缺失时创建，绝不覆盖已有内容", () => {
  withAgentDirectory((directory) => {
    const first = ensureAgentsFile();
    assert.equal(first.created, true);
    assert.equal(readFileSync(first.paths.agentsFile, "utf8"), AGENTS_TEMPLATE);

    // 用户编辑后再次点「新建」不能覆盖内容。
    writeFileSync(first.paths.agentsFile, "用户自己的规则\n", "utf8");
    const second = ensureAgentsFile();
    assert.equal(second.created, false);
    assert.equal(readFileSync(second.paths.agentsFile, "utf8"), "用户自己的规则\n");
    assert.equal(directory, second.paths.directory);
  });
});

test("目录不存在时会先创建目录再写入模板", () => {
  withAgentDirectory((directory) => {
    const nested = path.join(directory, "nested", "agent");
    process.env.PI_CODING_AGENT_DIR = nested;
    const result = ensureAgentsFile();
    assert.equal(result.created, true);
    assert.equal(existsSync(path.join(nested, "AGENTS.md")), true);
  });
});
