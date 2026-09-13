/**
 * pi-usage-log
 *
 * 背景：pi 从 0.84.3 起移除了本地用量日志（~/.pi/agent/analytics/usage.jsonl）的写入，
 * 导致 PiDeck「设置 → 用量统计」页面数据停更（只显示 0.84.2 及更早写入的记录）。
 *
 * 本扩展在每条 assistant 消息结束时，按 PiDeck 兼容格式把本轮用量追加到
 * usage.jsonl，恢复用量统计页的数据展示。写日志失败静默忽略，绝不影响会话。
 *
 * 记录格式（与 PiDeck 解析器一致，10/11 字段数组）：
 * [ts, sid, cwd, "provider/model", input, output, cacheRead, cacheWrite, totalTokens, cost, costKnown]
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 日志文件路径：跟随 pi 的配置目录（默认 ~/.pi/agent，可用 PI_CODING_AGENT_DIR 覆盖） */
export function logFilePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "analytics", "usage.jsonl");
}

/** assistant 消息用量 → PiDeck 兼容日志行；不满足条件时返回 null */
export function buildUsageRow(
  message: {
    timestamp?: unknown;
    provider?: unknown;
    model?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      totalTokens?: unknown;
      cost?: { total?: unknown } | null;
    } | null;
  },
  sid: string,
  cwd: string,
  fallbackModel?: string,
): Array<number | string> | null {
  const usage = message.usage;
  if (!usage) return null;

  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  const totalTokens = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  // 中止/出错的空回复不记录，避免统计页出现无效 0 行
  if (totalTokens <= 0) return null;

  const cost = Number(usage.cost?.total) || 0;
  const model =
    message.provider && message.model
      ? `${message.provider}/${message.model}`
      : fallbackModel || "unknown";
  const ts = Number(message.timestamp) || Date.now();

  return [
    ts,
    sid,
    cwd,
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
    cost > 0 ? 1 : 0,
  ];
}

/** 同一条消息防重 key：PiDeck 解析器同样按 ts|sid|model 去重 */
export function usageRowKey(row: Array<unknown>): string {
  return `${row[0]}|${row[1]}|${row[3]}`;
}

export default function (pi: ExtensionAPI) {
  // 串行写队列：保证多条记录按消息顺序落盘，且单次失败不影响后续
  let writeQueue: Promise<void> = Promise.resolve();
  // 进程内去重（防御事件重放）；上限防止无限增长
  const recentKeys = new Set<string>();
  const RECENT_KEYS_LIMIT = 500;
  let dirReady = false;

  pi.on("message_end", (event, ctx) => {
    const message = (event as { message?: unknown }).message as Record<string, unknown> | undefined;
    // 只统计 assistant 消息；user/toolResult 等直接跳过
    if (!message || message.role !== "assistant") return;

    const sid = ctx.sessionManager?.getSessionFile?.() || "ephemeral";
    const fallbackModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const row = buildUsageRow(message, sid, ctx.cwd, fallbackModel);
    if (!row) return;

    const key = usageRowKey(row);
    if (recentKeys.has(key)) return;
    recentKeys.add(key);
    if (recentKeys.size > RECENT_KEYS_LIMIT) {
      const oldest = recentKeys.values().next().value;
      if (oldest !== undefined) recentKeys.delete(oldest);
    }

    const line = `${JSON.stringify(row)}\n`;
    writeQueue = writeQueue
      .then(async () => {
        const file = logFilePath();
        if (!dirReady) {
          await mkdir(dirname(file), { recursive: true });
          dirReady = true;
        }
        await appendFile(file, line, "utf8");
      })
      .catch(() => {
        // 写用量日志失败不影响会话，静默忽略
      });
  });
}
