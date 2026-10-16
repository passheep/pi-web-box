import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在导入扩展之前指向临时文件：模块加载时会读取日志路径与配置路径，
// 避免测试把内容写进用户真实的 ~/.pi/agent 目录。
const workspace = mkdtempSync(join(tmpdir(), "pi-session-name-test-"));
process.env.PI_SESSION_NAME_LOG_FILE = join(workspace, "pi-session-name.log");
process.env.PI_SESSION_NAME_CONFIG_FILE = join(workspace, "pi-session-name.json");

const {
	default: sessionNameExtension,
	buildConversationSource,
	findNamingModel,
	formatLocalDate,
	normalizeGeneratedSuffix,
	readSessionNameConfig,
	DEFAULT_SESSION_NAME_CONFIG,
} = await import("./index.ts");

const configPath = process.env.PI_SESSION_NAME_CONFIG_FILE!;

/** 写入测试用配置；不传的字段回落到“旧硬编码模型”，保持既有用例的行为。 */
function writeConfig(config: Partial<{ enabled: boolean; provider: string; model: string }> = {}) {
	writeFileSync(
		configPath,
		JSON.stringify({ enabled: true, provider: "cc-switch-deep-seek", model: "deepseek-v4-flash", ...config }),
		"utf8",
	);
}

test("按本地时间格式化 Session 日期", () => {
	assert.equal(formatLocalDate(new Date(2026, 7, 21, 10, 30)), "20260821");
});

test("清理 LLM 返回的标题后缀", () => {
	assert.equal(normalizeGeneratedSuffix("标题：20260821-实现 Session 自动命名"), "实现-Session-自动命名");
	assert.equal(normalizeGeneratedSuffix('“修复 Vue/API 命名问题”'), "修复-Vue-API-命名问题");
	assert.equal(normalizeGeneratedSuffix("```text\nJava 项目构建排查\n```"), "Java-项目构建排查");
});

test("后缀超过 30 个字符时截断", () => {
	assert.equal(normalizeGeneratedSuffix("超".repeat(40)).length, 30);
	// 30 个字符以内的后缀保持原样。
	assert.equal(normalizeGeneratedSuffix("超级无敌长的标题后缀超过十个字符"), "超级无敌长的标题后缀超过十个字符");
});

test("从当前分支提取用户和助手文本", () => {
	const source = buildConversationSource([
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "实现自动命名" }] },
		},
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "正在实现" }] },
		},
		{
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "忽略工具输出" }] },
		},
	] as never);

	assert.equal(source, "用户：实现自动命名\n\n助手：正在实现");
});

test("命名模型按配置的 provider 精确查找，失败时按模型 id 全局回退", () => {
	const flash = { provider: "cc-switch-deep-seek", id: "deepseek-v4-flash" };
	const registry = {
		find: (provider: string, id: string) =>
			provider === "cc-switch-deep-seek" && id === "deepseek-v4-flash" ? flash : undefined,
		getAll: () => [],
	};
	const config = { enabled: true, provider: "cc-switch-deep-seek", model: "deepseek-v4-flash" };
	assert.equal(findNamingModel({ modelRegistry: registry } as never, config), flash);

	// provider 精确查找失败时，按模型 id 全局回退
	const fallback = { provider: "other", id: "deepseek-v4-flash" };
	const registry2 = { find: () => undefined, getAll: () => [fallback] };
	assert.equal(findNamingModel({ modelRegistry: registry2 } as never, config), fallback);

	// 未配置模型时不使用任何模型，交给调用方走备用名称
	assert.equal(findNamingModel({ modelRegistry: registry } as never, { ...config, model: "" }), null);
});

test("配置文件缺失或损坏时回退默认配置", async () => {
	// 指向一个不存在的路径：读取应回退默认值而不是抛错。
	process.env.PI_SESSION_NAME_CONFIG_FILE = join(workspace, "missing.json");
	assert.deepEqual(await readSessionNameConfig(), DEFAULT_SESSION_NAME_CONFIG);

	writeFileSync(process.env.PI_SESSION_NAME_CONFIG_FILE!, "{ not json", "utf8");
	assert.deepEqual(await readSessionNameConfig(), DEFAULT_SESSION_NAME_CONFIG);

	// 字段类型不符时逐字段回退。
	writeFileSync(process.env.PI_SESSION_NAME_CONFIG_FILE!, JSON.stringify({ enabled: "yes", provider: 7 }), "utf8");
	assert.deepEqual(await readSessionNameConfig(), DEFAULT_SESSION_NAME_CONFIG);

	process.env.PI_SESSION_NAME_CONFIG_FILE = configPath;
});

test("新对话首轮立即返回，并在后台名称完成后立即应用", async () => {
	writeConfig();
	const handlers = new Map<string, Function>();
	const namingModel = { provider: "cc-switch-deep-seek", id: "deepseek-v4-flash", reasoning: true };
	let sessionName: string | undefined;
	let completeCount = 0;
	let completeModel: unknown;
	let completeOptions: Record<string, unknown> | undefined;
	let idle = false;
	let resolveComplete!: (response: unknown) => void;
	const completePromise = new Promise((resolve) => {
		resolveComplete = resolve;
	});

	sessionNameExtension({
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = name;
		},
	} as never);

	const context = {
		model: { provider: "test", id: "test-model", reasoning: true },
		modelRegistry: {
			find: () => namingModel,
			getAll: () => [namingModel],
			hasConfiguredAuth: () => true,
			complete: async (model: unknown, _request: unknown, options: Record<string, unknown>) => {
				completeCount++;
				completeModel = model;
				completeOptions = options;
				return completePromise;
			},
		},
		sessionManager: {
			getHeader: () => ({ timestamp: "2026-08-21T03:17:35.200Z" }),
			getBranch: () => [],
			getSessionId: () => "session-1",
		},
		isIdle: () => idle,
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
		},
	};

	await handlers.get("session_start")!({ reason: "startup" }, context);
	await handlers.get("before_agent_start")!({ prompt: "请开发一个自动命名插件", images: [] }, context);

	assert.equal(completeCount, 1);
	assert.equal((completeModel as { id?: string })?.id, "deepseek-v4-flash");
	assert.equal(completeOptions?.reasoningEffort, "none");
	assert.equal(completeOptions?.timeoutMs, 20_000);
	assert.equal(completeOptions?.maxRetries, 0);
	assert.equal(sessionName, undefined);

	resolveComplete({ content: [{ type: "text", text: "开发会话自动命名插件" }] });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sessionName, "20260821-开发会话自动命名插件");

	idle = true;
	await handlers.get("agent_settled")!({}, context);
	assert.equal(sessionName, "20260821-开发会话自动命名插件");
});

test("主 Agent 先完成时，agent_settled 等待名称后再返回", async () => {
	writeConfig();
	const handlers = new Map<string, Function>();
	let sessionName: string | undefined;
	let idle = false;
	let resolveComplete!: (response: unknown) => void;
	const completePromise = new Promise((resolve) => {
		resolveComplete = resolve;
	});

	sessionNameExtension({
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
	} as never);

	const namingModel = { provider: "cc-switch-deep-seek", id: "deepseek-v4-flash" };
	const context = {
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: () => namingModel,
			getAll: () => [namingModel],
			hasConfiguredAuth: () => true,
			complete: async () => completePromise,
		},
		sessionManager: {
			getHeader: () => ({ timestamp: "2026-08-21T03:17:35.200Z" }),
			getBranch: () => [],
			getSessionId: () => "session-slow-name",
		},
		isIdle: () => idle,
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	};

	await handlers.get("session_start")!({ reason: "startup" }, context);
	await handlers.get("before_agent_start")!({ prompt: "生成一个稍慢的名称", images: [] }, context);

	idle = true;
	const settledPromise = handlers.get("agent_settled")!({}, context);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sessionName, undefined);

	resolveComplete({ content: [{ type: "text", text: "异步名称完成后刷新" }] });
	await settledPromise;
	assert.equal(sessionName, "20260821-异步名称完成后刷新");
});

test("恢复已有消息的 Session 时不自动重新命名", async () => {
	writeConfig();
	const handlers = new Map<string, Function>();
	let completeCount = 0;

	sessionNameExtension({
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		getSessionName: () => undefined,
		setSessionName() {},
	} as never);

	const context = {
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => {
				completeCount++;
				return { content: [{ type: "text", text: "不应调用" }] };
			},
		},
		sessionManager: {
			getHeader: () => ({ timestamp: "2026-08-21T03:17:35.200Z" }),
			getBranch: () => [{ type: "message", message: { role: "user", content: "已有消息" } }],
		},
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	};

	await handlers.get("session_start")!({ reason: "resume" }, context);
	await handlers.get("before_agent_start")!({ prompt: "继续对话", images: [] }, context);

	assert.equal(completeCount, 0);
});

/** 构造一个只关心「是否发起命名请求」的最小上下文。 */
function namingHarness() {
	const handlers = new Map<string, Function>();
	let completeCount = 0;
	let completeModel: { id?: string } | undefined;
	const models = [
		{ provider: "cc-switch-deep-seek", id: "deepseek-v4-flash" },
		{ provider: "magpie", id: "workbuddy2api/cn:glm-5.3" },
	];
	let sessionName: string | undefined;

	sessionNameExtension({
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
	} as never);

	const context = {
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getAll: () => models,
			hasConfiguredAuth: () => true,
			complete: async (model: { id?: string }) => {
				completeCount++;
				completeModel = model;
				return { content: [{ type: "text", text: "命名结果" }] };
			},
		},
		sessionManager: {
			getHeader: () => ({ timestamp: "2026-08-21T03:17:35.200Z" }),
			getBranch: () => [],
			getSessionId: () => `session-${completeCount}-${Math.random()}`,
		},
		isIdle: () => true,
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	};

	const startSession = async () => {
		sessionName = undefined;
		await handlers.get("session_start")!({ reason: "startup" }, context);
		await handlers.get("before_agent_start")!({ prompt: "新话题", images: [] }, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	return { startSession, count: () => completeCount, model: () => completeModel };
}

test("关闭自动命名后不再自动命名，重新打开后恢复", async () => {
	writeConfig({ enabled: false });
	const harness = namingHarness();
	await harness.startSession();
	assert.equal(harness.count(), 0);

	// 无需 /reload：改回启用后新建会话立刻恢复自动命名。
	writeConfig({ enabled: true });
	await harness.startSession();
	assert.equal(harness.count(), 1);
});

test("改配置里的命名模型后立刻生效", async () => {
	writeConfig({ model: "deepseek-v4-flash" });
	const harness = namingHarness();
	await harness.startSession();
	assert.equal(harness.model()?.id, "deepseek-v4-flash");

	// 换成另一个供应商的模型，下一轮命名立即使用新模型。
	writeConfig({ provider: "magpie", model: "workbuddy2api/cn:glm-5.3" });
	await harness.startSession();
	assert.equal(harness.model()?.id, "workbuddy2api/cn:glm-5.3");
});

test("/session-name rename 根据当前对话重新命名", async () => {
	writeConfig();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	let sessionName = "20260821-旧名称";
	let promptText = "";

	sessionNameExtension({
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: Function }) {
			commands.set(name, command);
		},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
	} as never);

	const namingModel = { provider: "cc-switch-deep-seek", id: "deepseek-v4-flash" };
	const context = {
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: () => namingModel,
			getAll: () => [namingModel],
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }) => {
				promptText = request.messages[0]!.content[0]!.text;
				return { content: [{ type: "text", text: "修复登录接口异常" }] };
			},
		},
		sessionManager: {
			getHeader: () => ({ timestamp: "2026-08-21T03:17:35.200Z" }),
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "登录接口返回 500" } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "正在排查" }] } },
			],
			getSessionId: () => "session-2",
		},
		isIdle: () => true,
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	};

	await commands.get("session-name")!.handler("rename", context);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.match(promptText, /登录接口返回 500/);
	assert.equal(sessionName, "20260821-修复登录接口异常");
});
