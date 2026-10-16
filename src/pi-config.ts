/**
 * pi 本地配置的只读展示与最小改动创建。
 *
 * 这里只碰两个固定位置：pi 的 agent 目录与其中的全局 AGENTS.md，
 * 供 Box 设置的「Pi 配置」面板展示与打开。AGENTS.md 是用户自己的规则文件，
 * 任何情况下都不会覆盖已有内容。
 */
import fs from "node:fs";
import path from "node:path";
import type { PiPaths } from "./contracts.js";
import { piAgentDirectory } from "./extensions.js";

/** pi 全局 AGENTS.md 不存在时写入的空白模板。 */
export const AGENTS_TEMPLATE = `# 全局规则\n\n<!-- 在此编写对所有项目生效的规则与约定。 -->\n`;

/** pi 的本地目录与全局 AGENTS.md 的当前状态。 */
export function getPiPaths(): PiPaths {
  const directory = piAgentDirectory();
  const agentsFile = path.join(directory, "AGENTS.md");
  return {
    directory,
    directoryExists: fs.existsSync(directory),
    agentsFile,
    agentsExists: fs.existsSync(agentsFile),
  };
}

/**
 * 创建全局 AGENTS.md。已存在时原样保留，只在文件缺失时写入模板，
 * 返回 created 表示本次是否真正写入。
 */
export function ensureAgentsFile(): { created: boolean; paths: PiPaths } {
  const paths = getPiPaths();
  if (paths.agentsExists) return { created: false, paths };
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.agentsFile, AGENTS_TEMPLATE, "utf8");
  return { created: true, paths };
}
