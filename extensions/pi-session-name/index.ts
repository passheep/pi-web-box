import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `你是一个会话标题生成器。请根据用户需求或对话内容生成一个简短、具体、便于检索的中文标题后缀。

要求：
1. 只输出标题后缀，不要输出日期、解释、引号、Markdown 或“标题：”前缀。
2. 优先使用中文，必要时保留 Java、Vue、API、MySQL 等技术名词。
3. 标题应准确体现主要任务，避免“新对话”“咨询问题”“代码处理”等空泛表述。
4. 最多不超过 30 个字符，简洁高效。`;

const MAX_SOURCE_LENGTH = 12_000;
const MAX_SUFFIX_LENGTH = 30;
const NAMING_REQUEST_TIMEOUT_MS = 20_000;
const NAMING_SETTLE_TIMEOUT_MS = 15_000;
const SESSION_NAME_LOG_FILE = process.env.PI_SESSION_NAME_LOG_FILE || join(homedir(), ".pi", "agent", "pi-session-name.log");

/** 配置文件：Pi Web Box 的「会话命名」面板写入，本扩展每次命名前重新读取。 */
const CONFIG_FILENAME = "pi-session-name.json";

/** 命名配置：是否自动命名，以及命名时使用的供应商与模型。 */
export type SessionNameConfig = {
	enabled: boolean;
	provider: string;
	model: string;
};

/** 默认配置（与插件此前硬编码的命名模型保持一致），配置文件缺失或损坏时使用。 */
export const DEFAULT_SESSION_NAME_CONFIG: SessionNameConfig = {
	enabled: true,
	provider: "cc-switch-deep-seek",
	model: "deepseek-flash",
};

/** 兼容旧调用：默认的命名供应商与模型标识。 */
export const NAMING_PROVIDER = DEFAULT_SESSION_NAME_CONFIG.provider;
export const NAMING_MODEL_ID = DEFAULT_SESSION_NAME_CONFIG.model;

type MessageContent = string | Array<{ type?: string; text?: string }>;

type NamingContext = Pick<
	ExtensionContext,
	"model" | "modelRegistry" | "sessionManager" | "hasUI" | "ui" | "signal" | "isIdle"
>;

type GeneratedSessionName = {
	name: string;
	fallback: boolean;
};

type PendingRename = {
	controller: AbortController;
	ctx: NamingContext;
	automatic: boolean;
	sessionId: string;
	completion: Promise<void>;
	result?: GeneratedSessionName;
};

/** pi 的 agent 目录，跟随 PI_CODING_AGENT_DIR。 */
function agentDirectory(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** 配置文件路径，可用 PI_SESSION_NAME_CONFIG_FILE 覆盖（便于测试）。 */
export function configFilePath(): string {
	const override = process.env.PI_SESSION_NAME_CONFIG_FILE?.trim();
	return override || join(agentDirectory(), CONFIG_FILENAME);
}

/**
 * 读取命名配置。每次命名前调用，因此在 Box 设置里改完开关或模型即刻生效，
 * 不需要在 pi 里执行 /reload。
 *
 * 刻意用同步读取：配置文件很小，且这样命名请求能在同一次调用里发起，
 * 不引入额外的事件循环延迟；读取失败一律回退默认配置，绝不影响会话。
 */
export function readSessionNameConfig(): SessionNameConfig {
	try {
		const raw = readFileSync(configFilePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<SessionNameConfig>;
		if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SESSION_NAME_CONFIG };
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SESSION_NAME_CONFIG.enabled,
			provider: typeof parsed.provider === "string" ? parsed.provider.trim() : DEFAULT_SESSION_NAME_CONFIG.provider,
			model: typeof parsed.model === "string" ? parsed.model.trim() : DEFAULT_SESSION_NAME_CONFIG.model,
		};
	} catch {
		return { ...DEFAULT_SESSION_NAME_CONFIG };
	}
}

/** 查找命名专用模型：优先按配置的 provider 精确查找，找不到时按模型 id 全局回退。 */
export function findNamingModel(ctx: NamingContext, config: SessionNameConfig = DEFAULT_SESSION_NAME_CONFIG) {
	const provider = config.provider.trim();
	const modelId = config.model.trim();
	if (!modelId) return null;
	return (
		(provider ? ctx.modelRegistry.find(provider, modelId) : undefined) ??
		ctx.modelRegistry.getAll().find((model) => model.id === modelId) ??
		null
	);
}

/** 异步写入诊断日志，避免日志 IO 影响主 Agent 和命名请求。 */
function writeNameLog(event: string, details: Record<string, unknown> = {}): void {
	const line = `${JSON.stringify({
		time: new Date().toISOString(),
		event,
		...details,
	})}\n`;
	void mkdir(dirname(SESSION_NAME_LOG_FILE), { recursive: true })
		.then(() => appendFile(SESSION_NAME_LOG_FILE, line, "utf8"))
		.catch((error) => {
			console.error(`[pi-session-name] 写入日志失败：${error instanceof Error ? error.message : String(error)}`);
		});
}

function describeModel(model: NamingContext["model"]): Record<string, unknown> {
	if (!model) return { configured: false };
	return {
		configured: true,
		provider: model.provider,
		model: model.id,
		api: model.api,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		// 命名请求固定关闭思考，日志里记 none
		reasoningEffort: "none",
	};
}

export function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

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

function extractText(content: MessageContent | unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n");
}

export function buildConversationSource(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): string {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;

		const text = extractText(entry.message.content);
		if (!text) continue;

		sections.push(`${entry.message.role === "user" ? "用户" : "助手"}：${text}`);
	}

	const source = sections.join("\n\n");
	if (source.length <= MAX_SOURCE_LENGTH) return source;

	// 保留开头目标和最近进展，避免重新命名时发送过长上下文。
	const headLength = Math.floor(MAX_SOURCE_LENGTH * 0.35);
	const tailLength = MAX_SOURCE_LENGTH - headLength;
	return `${source.slice(0, headLength)}\n\n……中间内容已省略……\n\n${source.slice(-tailLength)}`;
}

function getSessionDate(ctx: NamingContext): Date {
	const timestamp = ctx.sessionManager.getHeader().timestamp;
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function hasUserMessage(ctx: NamingContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => {
		return entry.type === "message" && entry.message.role === "user";
	});
}

function notify(ctx: NamingContext, message: string, level: "info" | "warning" | "error") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function buildFallbackName(ctx: NamingContext): string {
	return `${formatLocalDate(getSessionDate(ctx))}-新对话`;
}

async function waitForCompletion(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timeoutId = setTimeout(() => resolve(false), timeoutMs);
	});

	const completed = await Promise.race([promise.then(() => true), timeout]);
	if (timeoutId) clearTimeout(timeoutId);
	return completed;
}

async function generateSessionName(source: string, ctx: NamingContext): Promise<GeneratedSessionName> {
	const startedAt = Date.now();
	const datePrefix = formatLocalDate(getSessionDate(ctx));
	const fallbackName = buildFallbackName(ctx);
	// 命名模型来自 Box 设置（~/.pi/agent/pi-session-name.json），不跟随当前会话模型。
	const config = readSessionNameConfig();
	const model = findNamingModel(ctx, config);
	const modelDetails = { ...describeModel(model), namingProvider: config.provider, namingModel: config.model };
	writeNameLog("request_start", {
		sessionId: ctx.sessionManager.getSessionId(),
		sourceLength: source.length,
		...modelDetails,
	});

	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
		writeNameLog("request_skipped", { reason: "model_or_auth_unavailable", ...modelDetails });
		return { name: fallbackName, fallback: true };
	}

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: source.slice(0, MAX_SOURCE_LENGTH) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: 1024,
				// 关闭思考（reasoning.effort = "none"），命名更快更省
				reasoningEffort: "none",
				cacheRetention: "none",
				timeoutMs: NAMING_REQUEST_TIMEOUT_MS,
				maxRetries: 0,
				signal: ctx.signal,
			},
		);

		const rawTitle = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const suffix = normalizeGeneratedSuffix(rawTitle);
		writeNameLog("request_complete", {
			sessionId: ctx.sessionManager.getSessionId(),
			elapsedMs: Date.now() - startedAt,
			stopReason: response.stopReason,
			rawTitleLength: rawTitle.length,
			suffixLength: suffix.length,
			...modelDetails,
		});

		if (!suffix) {
			console.error(`[pi-session-name] LLM 未返回可用标题，stopReason=${response.stopReason}`);
			return { name: fallbackName, fallback: true };
		}
		return { name: `${datePrefix}-${suffix}`, fallback: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = ctx.signal?.aborted === true;
		writeNameLog(aborted ? "request_aborted" : "request_error", {
			sessionId: ctx.sessionManager.getSessionId(),
			elapsedMs: Date.now() - startedAt,
			error: message.slice(0, 1000),
			...modelDetails,
		});
		console.error(`[pi-session-name] LLM 命名失败：${message}`);
		return { name: fallbackName, fallback: true };
	}
}

function notifyRenameResult(result: GeneratedSessionName, ctx: NamingContext, automatic: boolean) {
	if (result.fallback) {
		notify(
			ctx,
			automatic
				? `LLM 命名失败，已暂时命名为：${result.name}。可稍后执行 /session-name rename 重试。`
				: `LLM 命名失败，已使用备用名称：${result.name}`,
			"warning",
		);
		return;
	}

	notify(ctx, `Session 已命名：${result.name}`, "info");
}

export default function (pi: ExtensionAPI) {
	let shouldAutoName = false;
	let pendingRename: PendingRename | undefined;

	const clearPendingRename = (pending: PendingRename) => {
		if (pendingRename !== pending) return;
		pending.ctx.ui.setStatus("pi-session-name", undefined);
		pendingRename = undefined;
	};

	// 在 pi-web 的 agent_settled 刷新前落名，确保右上角 Session 信息实时更新。
	const applyPendingRename = (pending: PendingRename) => {
		if (pendingRename !== pending || pending.controller.signal.aborted || !pending.result) return;
		if (pending.ctx.sessionManager.getSessionId() !== pending.sessionId) {
			clearPendingRename(pending);
			return;
		}

		pi.setSessionName(pending.result.name);
		writeNameLog("name_applied", {
			sessionId: pending.sessionId,
			name: pending.result.name,
			fallback: pending.result.fallback,
		});
		notifyRenameResult(pending.result, pending.ctx, pending.automatic);
		clearPendingRename(pending);
	};

	// 后台执行 LLM 请求，不阻塞当前 Session 的主模型请求。
	const startBackgroundRename = (source: string, ctx: NamingContext, automatic: boolean) => {
		const controller = new AbortController();
		const pending: PendingRename = {
			controller,
			ctx: { ...ctx, signal: controller.signal },
			automatic,
			sessionId: ctx.sessionManager.getSessionId(),
			completion: Promise.resolve(),
		};
		pendingRename = pending;
		writeNameLog("background_start", {
			sessionId: pending.sessionId,
			automatic,
			sourceLength: source.length,
			...describeModel(ctx.model),
		});
		ctx.ui.setStatus("pi-session-name", "正在生成会话名称...");

		pending.completion = generateSessionName(source, pending.ctx)
			.then((result) => {
				if (pendingRename !== pending || controller.signal.aborted) return;
				pending.result = result;
				writeNameLog("result_ready", {
					sessionId: pending.sessionId,
					name: result.name,
					fallback: result.fallback,
					idle: pending.ctx.isIdle(),
				});

				applyPendingRename(pending);
			})
			.catch((error) => {
				if (pendingRename !== pending || controller.signal.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				writeNameLog("background_error", {
					sessionId: pending.sessionId,
					error: message.slice(0, 1000),
				});
				console.error(`[pi-session-name] 后台命名失败：${message}`);
				notify(ctx, "后台生成 Session 名称失败，请稍后重试。", "warning");
				clearPendingRename(pending);
			});
	};

	pi.on("session_start", (_event, ctx) => {
		if (pendingRename) {
			writeNameLog("background_cancelled", { sessionId: pendingRename.sessionId, reason: "session_start" });
			pendingRename.controller.abort();
			clearPendingRename(pendingRename);
		}
		// 关掉自动命名后新建的 Session 不再自动命名；手动 /session-name rename 仍可用。
		const config = readSessionNameConfig();
		shouldAutoName = config.enabled && !pi.getSessionName() && !hasUserMessage(ctx);
	});

	pi.on("session_shutdown", () => {
		if (pendingRename) {
			writeNameLog("background_cancelled", { sessionId: pendingRename.sessionId, reason: "session_shutdown" });
			pendingRename.controller.abort();
			clearPendingRename(pendingRename);
		}
	});

	pi.on("agent_settled", async () => {
		const pending = pendingRename;
		if (!pending) return;
		writeNameLog("agent_settled", {
			sessionId: pending.sessionId,
			hasResult: Boolean(pending.result),
		});

		if (!pending.result) {
			const completed = await waitForCompletion(pending.completion, NAMING_SETTLE_TIMEOUT_MS);
			if (pendingRename !== pending) return;

			if (!completed && !pending.result) {
				pending.result = { name: buildFallbackName(pending.ctx), fallback: true };
				writeNameLog("settle_timeout_fallback", {
					sessionId: pending.sessionId,
					waitMs: NAMING_SETTLE_TIMEOUT_MS,
					name: pending.result.name,
				});
				applyPendingRename(pending);
				pending.controller.abort();
				return;
			}
		}

		if (pendingRename === pending && pending.result) {
			applyPendingRename(pending);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!shouldAutoName || pendingRename || pi.getSessionName()) return;
		// 会话进行中关掉开关也要立刻生效。
		const config = readSessionNameConfig();
		if (!config.enabled) {
			shouldAutoName = false;
			writeNameLog("auto_name_disabled", { sessionId: ctx.sessionManager.getSessionId() });
			return;
		}

		shouldAutoName = false;
		const source = event.prompt.trim() || (event.images?.length ? "用户发起了一个图片相关的新对话" : "用户发起了新对话");
		startBackgroundRename(source, ctx, true);
	});

	pi.registerCommand("session-name", {
		description: "查看或重新生成 Session 名称（用法：/session-name rename）",
		getArgumentCompletions: (prefix) => {
			const item = { value: "rename", label: "rename", description: "调用 LLM 重新生成当前 Session 名称" };
			return "rename".startsWith(prefix.trim().toLowerCase()) ? [item] : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) {
				const currentName = pi.getSessionName();
				notify(ctx, currentName ? `当前 Session：${currentName}` : "当前 Session 尚未命名", "info");
				return;
			}

			if (action !== "rename") {
				notify(ctx, "用法：/session-name rename", "warning");
				return;
			}

			if (pendingRename) {
				notify(ctx, "Session 名称正在生成或等待主会话完成，请稍候。", "warning");
				return;
			}

			const source = buildConversationSource(ctx.sessionManager.getBranch());
			if (!source) {
				notify(ctx, "当前对话没有可用于命名的文本内容。", "warning");
				return;
			}

			notify(ctx, "已开始后台生成 Session 名称。", "info");
			startBackgroundRename(source, ctx, false);
		},
	});
}
