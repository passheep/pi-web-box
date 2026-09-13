import fs from "node:fs";
import path from "node:path";

/** Windows 上可执行命令的扩展名，按优先级排列。 */
const WINDOWS_EXTENSIONS = [".cmd", ".exe", ".bat", ""];
/** 非 Windows 平台直接使用原命令名。 */
const POSIX_EXTENSIONS = [""];

/**
 * 在 PATH 中查找可执行文件，返回绝对路径。
 *
 * 这里刻意不调用 `where.exe`：在 Electron 主进程里创建控制台子进程
 * 可能长时间阻塞主线程，导致启动流程卡在版本检查上。直接扫描目录
 * 既快又不会引入子进程，行为对用户完全一致。
 */
export function findExecutableOnPath(
  commandNames: string[],
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  // PATH 变量在不同环境下大小写不一致，两个都取一次。
  const rawPath = env.PATH || env.Path || "";
  const directories = rawPath.split(path.delimiter).map((value) => value.trim()).filter(Boolean);
  const extensions = process.platform === "win32" ? WINDOWS_EXTENSIONS : POSIX_EXTENSIONS;

  // 当前目录优先，与 where.exe 的行为保持一致。
  const searchDirectories = [process.cwd(), ...directories];
  for (const directory of searchDirectories) {
    for (const commandName of commandNames) {
      // 命令名已经带扩展名时不再追加，避免出现 pi.cmd.cmd。
      const names = path.extname(commandName)
        ? [commandName]
        : extensions.map((extension) => `${commandName}${extension}`);
      for (const name of names) {
        const candidate = path.join(directory, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // 目录无权限或已失效时跳过，继续找下一个。
        }
      }
    }
  }
  return undefined;
}

/** 按顺序查找第一个可用的命令，常用组合在这里集中定义。 */
export function findCommandOnPath(
  commandName: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return findExecutableOnPath([commandName], env);
}
