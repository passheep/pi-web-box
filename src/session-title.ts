/**
 * 「生成标题」：读取当前会话的对话内容，用会话命名配置里的模型生成标题，再写回会话名。
 *
 * 为什么不由 Box 去触发插件的 /session-name rename：
 * 插件是 pi 进程里已经加载的代码，更新文件后必须 /reload 才生效；
 * 这里改用 pi-web 自己的两个接口（GET /api/sessions/<id> 读对话、PATCH /api/sessions/<id> 写会话名），
 * 因此点击即可用，且与插件保持同一套系统提示词与「YYYYMMDD-标题」格式。
 *
 * 只读 + 单次写名，不修改会话内容；请求走 Node 的独立连接池，不占用页面的 SSE 连接。
 */
import type { SessionTitleResult } from "./contracts.js";
import { completeWithModel } from "./enhance.js";
import { parseLoopbackOrigin } from "./session-status.js";

/** 与 extensions/pi-session-name/index.ts 的 SYSTEM_PROMPT 保持一致，改一处要同步另一处。 */
const SYSTEM_PROMPT = `你是一个会话标题生成器。请根据用户需求或对话内容生成一个简短、具体、便于检索的中文标题后缀。

要求：
1. 只输出标题后缀，不要输出日期、解释、引号、Markdown 或“标题：”前缀。
2. 优先使用中文，必要时保留 Java、Vue、API、MySQL 等技术名词。
3. 标题应准确体现主要任务，避免“新对话”“咨询问题”“代码处理”等空泛表述。
4. 最多不超过 30 个字符，简洁高效。`;

/** 与插件相同的截断与长度限制。 */
const MAX_SOURCE_LENGTH = 12_000;
const MAX_SUFFIX_LENGTH = 30;
/** 读取会话上下文时最多取多少条消息。 */
const CONTEXT_MESSAGES = 100;
const REQUEST_TIMEOUT_MS = 20_000;

/** 会话创建日期（本地时区的 YYYYMMDD），与插件一致。 */
export function formatTitleDate(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value ?? ""));
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = valid.getFullYear();
  const month = String(valid.getMonth() + 1).padStart(2, "0");
  const day = String(valid.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** 清洗模型返回的标题后缀，规则与插件 normalizeGeneratedSuffix 相同。 */
export function normalizeGeneratedSuffix(value: string): string {
  let suffix = value
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```(?:\w+)?/g, ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";

  suffix = suffix
    .replace(/^\s*(?:标题|会话标题|session\s*name)\s*[：:]\s*/i, "")
    .replace(/^\s*\d{8}\s*[-_—–：:]\s*/, "")
    .replace(/^\s*[-*#>]+\s*/, "")
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.，。；;：:]+|[-_.，。；;：:]+$/g, "")
    .trim();

  return Array.from(suffix).slice(0, MAX_SUFFIX_LENGTH).join("");
}

/** 从 pi-web 的消息数组里提取「用户/助手」文本，过长时保留开头目标与最近进展。 */
export function buildTitleSource(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const sections: string[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") continue;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    const parts: string[] = [];
    if (typeof content === "string") {
      parts.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const record = part as { type?: unknown; text?: unknown };
        if (record.type === "text" && typeof record.text === "string") parts.push(record.text.trim());
      }
    }
    const text = parts.filter(Boolean).join("\n");
    if (!text) continue;
    sections.push(`${role === "user" ? "用户" : "助手"}：${text}`);
  }

  const source = sections.join("\n\n");
  if (source.length <= MAX_SOURCE_LENGTH) return source;
  const headLength = Math.floor(MAX_SOURCE_LENGTH * 0.35);
  const tailLength = MAX_SOURCE_LENGTH - headLength;
  return `${source.slice(0, headLength)}\n\n……中间内容已省略……\n\n${source.slice(-tailLength)}`;
}

/** 访问 pi-web 请求头：启用访问密码时带 Basic Auth（用户名固定为 pi）。 */
function headers(password?: string, json = false): Record<string, string> {
  const result: Record<string, string> = {};
  if (json) result["Content-Type"] = "application/json";
  if (password) result.Authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
  return result;
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.status === 404 ? "（会话不存在）" : ""}`);
    }
    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

export type GenerateTitleOptions = {
  /** pi-web 地址，仅接受回环 http/https，例如 http://127.0.0.1:30141。 */
  origin: string;
  password?: string;
  sessionId: string;
  /** 命名供应商与模型，来自 ~/.pi/agent/pi-session-name.json。 */
  provider: string;
  model: string;
};

/** pi-web 会话详情接口里本模块用到的字段。 */
type SessionPayload = {
  context?: { messages?: unknown };
  info?: { created?: unknown; name?: unknown };
};

/**
 * 生成并写回会话标题。返回的新名称已经保存到会话文件，
 * 调用方只需刷新一次会话列表即可看到新名字。
 */
export async function generateSessionTitle(options: GenerateTitleOptions): Promise<SessionTitleResult> {
  if (!options.sessionId) return { ok: false, message: "当前标签还没有关联会话，先发一条消息再试。" };
  if (!options.model) return { ok: false, message: "请先在「Box 设置 → 会话命名」中选择命名模型。" };

  let base: URL;
  try {
    base = parseLoopbackOrigin(options.origin);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const query = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tail: String(CONTEXT_MESSAGES) });
  let payload: SessionPayload;
  try {
    payload = (await requestJson(
      `${base.origin}/api/sessions/${encodeURIComponent(options.sessionId)}?${query.toString()}`,
      { headers: headers(options.password) },
    ) ?? {}) as SessionPayload;
  } catch (error) {
    return { ok: false, message: `读取会话内容失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const source = buildTitleSource(payload.context?.messages);
  if (!source) return { ok: false, message: "这个会话还没有可用于命名的对话内容。" };

  const completion = await completeWithModel({
    provider: options.provider,
    model: options.model,
    systemPrompt: SYSTEM_PROMPT,
    userText: source,
    maxTokens: 1024,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!completion.ok) return { ok: false, message: completion.message };

  const suffix = normalizeGeneratedSuffix(completion.text);
  if (!suffix) return { ok: false, message: "模型没有返回可用的标题，请重试。" };
  const name = `${formatTitleDate(payload.info?.created)}-${suffix}`;

  try {
    await requestJson(`${base.origin}/api/sessions/${encodeURIComponent(options.sessionId)}`, {
      method: "PATCH",
      headers: headers(options.password, true),
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    return { ok: false, message: `保存会话名失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, name };
}
