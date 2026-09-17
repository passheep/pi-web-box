/**
 * session-status
 *
 * 主进程集中轮询 pi-web 会话状态用的只读 HTTP 客户端（建议 4 秒一次，由调用方定时驱动）。
 *
 * 为什么不用 Electron 的 net.fetch：
 * 它走 Chromium 网络栈，与页面共享连接池（Node 全局 fetch 则不是）。
 * 周期性轮询会和页面自身请求互相挤占。这里改用 Node.js 的 http/https 模块，
 * 并使用本模块独立的 Agent（maxSockets: 2 + keepAlive），与渲染进程完全隔离。
 *
 * 行为约定：
 * - 只读两个接口：GET /api/agent/running（runningSessionIds）与 GET /api/sessions（sessions 列表），
 *   两个请求并行发出；
 * - 单次请求总超时 3 秒（覆盖连接、响应与读正文的整个过程）；
 * - 拒绝跟随重定向：3xx 一律按失败处理，绝不请求 Location 指向的地址；
 * - 响应正文上限 8MB，超出即中断连接并按失败处理；
 * - origin 仅接受 http/https 且主机为回环地址（127.0.0.1 / localhost / ::1），
 *   不合法时抛 TypeError——这属于调用方配置错误，不是可自动恢复的运行时故障；
 * - password 非空时发送 Basic Auth（用户名 pi，与 pi-web 的约定一致）；
 *   为空或未提供时不带认证头；
 * - 任一接口失败（网络错误 / 超时 / 3xx / 非 200 / 正文超限 / JSON 不合法 / 结构不符）
 *   只把对应字段置为 null，另一个字段不受影响，调用方据此保留上一次的状态；
 * - 模块不打印任何日志，错误消息不回显输入；调用方也不应记录凭据或正文。
 */

import http from "node:http";
import https from "node:https";

/** 单次请求的总超时（毫秒）。 */
export const SESSION_STATUS_TIMEOUT_MS = 3_000;
/** 响应正文上限（字节）：8MB。 */
export const SESSION_STATUS_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** fetchSessionStatus 的返回值。null 表示该接口本次失败，调用方应保留旧状态。 */
export interface SessionStatus {
  /** 运行中的会话 id 列表；/api/agent/running 失败时为 null。 */
  runningIds: string[] | null;
  /** 会话 id → 名称映射；/api/sessions 失败时为 null。 */
  names: Map<string, string> | null;
}

// 本模块专属的连接池：keepAlive 复用连接，maxSockets 限制并发为 2，
// 与 Electron net.fetch 背后的 Chromium 连接池（同源约 6 个）互不影响。
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });

/** 销毁内置 Agent 上的全部连接，供应用退出或测试结束时清理资源。 */
export function closeSessionStatusAgents(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
}

function isLoopbackHost(hostname: string): boolean {
  // WHATWG URL 对 IPv6 主机名保留方括号（如 "[::1]"），这里一并接受。
  const value = hostname.trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

/**
 * 校验并解析 origin：仅接受 http/https 且主机为回环地址。
 * 拒绝路径、查询、片段与内嵌凭据；错误消息不回显任何输入。
 */
export function parseLoopbackOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("origin 不是合法的 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("origin 仅支持 http/https 协议");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new TypeError("origin 仅允许回环地址（127.0.0.1 / localhost / ::1）");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("origin 不得包含凭据、路径、查询或片段");
  }
  // origin 属性天然不含路径与凭据，这里只留 scheme://host[:port]。
  return new URL(parsed.origin);
}

/** 由 base 构造接口地址。 */
function endpointUrl(base: URL, pathname: string): URL {
  const url = new URL(base.toString());
  url.pathname = pathname;
  return url;
}

/** 单次请求的结果：ok 为 false 表示失败，payload 仅在 ok 时有值。 */
type RequestOutcome = { ok: true; payload: unknown } | { ok: false };

/**
 * 发起一次 GET 请求并解析 JSON。
 * 永不 reject：任何失败（网络 / 超时 / 状态码 / 正文）都以 { ok: false } 收场。
 */
function tryRequestJson(
  url: URL,
  authHeader: string | undefined,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<RequestOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: RequestOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    const isHttps = url.protocol === "https:";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authHeader) headers.Authorization = authHeader;
    const options: http.RequestOptions = {
      method: "GET",
      agent: isHttps ? httpsAgent : httpAgent,
      headers,
      // localhost 不经 DNS，保证请求始终落在回环地址。
      ...(url.hostname === "localhost" ? { hostname: "127.0.0.1" } : {}),
    };

    let request: http.ClientRequest;
    try {
      request = isHttps
        ? https.request(url, options, onResponse)
        : http.request(url, options, onResponse);
    } catch {
      // URL 已经过校验，这里只是防御性兜底。
      finish({ ok: false });
      return;
    }

    function onResponse(response: http.IncomingMessage): void {
      const status = response.statusCode ?? 0;
      response.on("error", () => finish({ ok: false }));
      // 错误响应可能无限流式输出，不能清掉超时后继续 resume 占用连接。
      // Node request 不跟随重定向，所有非 200 都立即销毁连接。
      if (status !== 200) {
        finish({ ok: false });
        response.destroy();
        request.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > maxBodyBytes) {
          finish({ ok: false });
          request.destroy(); // 正文超限，直接中断连接，不再读取
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        try {
          finish({ ok: true, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          finish({ ok: false }); // 不是合法 JSON
        }
      });
      // 服务端中途断开也按失败处理。
      response.on("aborted", () => finish({ ok: false }));
    }

    request.on("error", () => finish({ ok: false }));
    // 总超时：覆盖连接、响应与读正文的整个过程。
    timer = setTimeout(() => {
      finish({ ok: false });
      request.destroy();
    }, timeoutMs);
    request.end();
  });
}

/** /api/agent/running → { runningSessionIds: string[] }。结构不符按失败处理。 */
function parseRunningIds(payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as Record<string, unknown>).runningSessionIds;
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string")) return null;
  return raw;
}

/** /api/sessions → { sessions: [{ id, name }] }。缺名称的条目跳过，结构不符按失败处理。 */
function parseSessionNames(payload: unknown): Map<string, string> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as Record<string, unknown>).sessions;
  if (!Array.isArray(raw)) return null;
  const names = new Map<string, string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.name === "string") {
      names.set(record.id, record.name);
    }
  }
  return names;
}

/**
 * 读取 pi-web 的会话状态：并行请求 /api/agent/running 与 /api/sessions。
 * 两个请求互不影响，任一失败只把对应字段置为 null，供调用方保留旧状态。
 *
 * @param origin pi-web 的地址，如 "http://127.0.0.1:30141"（仅回环 http/https）。
 * @param password 访问密码；非空时发送 Basic Auth（用户名 pi），为空或省略时不带认证头。
 */
export async function fetchSessionStatus(
  origin: string,
  password?: string,
): Promise<SessionStatus> {
  const base = parseLoopbackOrigin(origin);
  const timeoutMs = SESSION_STATUS_TIMEOUT_MS;
  const maxBodyBytes = SESSION_STATUS_MAX_BODY_BYTES;
  // 密码只在内存中拼认证头，不落日志、不进 URL。
  const authHeader = password
    ? `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`
    : undefined;

  const [running, sessions] = await Promise.all([
    tryRequestJson(endpointUrl(base, "/api/agent/running"), authHeader, timeoutMs, maxBodyBytes),
    tryRequestJson(endpointUrl(base, "/api/sessions"), authHeader, timeoutMs, maxBodyBytes),
  ]);
  return {
    runningIds: running.ok ? parseRunningIds(running.payload) : null,
    names: sessions.ok ? parseSessionNames(sessions.payload) : null,
  };
}
