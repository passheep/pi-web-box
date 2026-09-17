/** 旧冒烟命令兼容入口：统一运行六标签回归，不再修改 package.json 或生成应用补丁。 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "node_modules/electron/cli.js"), path.join(root, "scripts/smoke-tabs.cjs")], {
  cwd: root,
  stdio: "inherit",
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
