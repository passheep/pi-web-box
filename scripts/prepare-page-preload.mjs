import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(root, "build");
const require = createRequire(import.meta.url);

// 必须在 tsc 后执行：只在构建进程加载 CommonJS 模块，沙箱 preload 不 require 本地模块。
const preload = await fs.readFile(path.join(build, "preload.js"), "utf8");
const { installPageCapture } = require(path.join(build, "page-capture.js"));
if (typeof installPageCapture !== "function") {
  throw new Error("build/page-capture.js 未导出 installPageCapture，请先完成 tsc 编译。");
}
const captureSource = installPageCapture.toString();
// 主世界执行时没有原模块闭包；捕获函数须自包含（对应 page-capture.test.ts 的独立上下文测试）。
// 提前拒绝常见编译辅助函数和模块依赖，避免把不能在主世界运行的代码悄悄打包。
if (/\brequire\s*\(|\bexports\s*\.|\bmodule\s*\.|\b__(?:name|awaiter|generator)\b/.test(captureSource)) {
  throw new Error("installPageCapture 包含模块或编译辅助依赖，必须保持函数自包含。");
}
new Script(`(${captureSource})`, { filename: "installPageCapture.js" });

// Electron 43 提供 executeInMainWorld（实验性 API），支持 contextIsolation + sandbox。
// 只在 http(s) 主框架安装；本地壳、启动页和子框架不捕获，异常也不能中断页面渲染。
const output = `${preload.replace(/^\/\/# sourceMappingURL=.*$/gm, "")}
;try {
  if (process.isMainFrame === true && /^https?:$/.test(globalThis.location?.protocol || "")) {
    require('electron').contextBridge.executeInMainWorld({ func: ${captureSource} });
  }
} catch {
  // 捕获只是附加功能，API 不可用或页面异常时保留正常页面行为。
}
`;
new Script(output, { filename: "page-preload.js" });
await fs.writeFile(path.join(build, "page-preload.js"), output, "utf8");
console.log("已生成 build/page-preload.js（保留沙箱，主世界捕获函数内联）。");
