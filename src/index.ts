import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type Config,
	canTrace,
	getConfigWarnings,
	resolveConfig,
} from "./config.js";
import { exportRedactedData } from "./export.js";
import {
	flushClient,
	getClient,
	type LangfuseGeneration,
	type LangfuseSpan,
	type LangfuseTrace,
	shutdownClient,
} from "./langfuse-client.js";
import { ensureLocalLangfuseStarted } from "./local-autostart.js";
import { runLangfuseInit } from "./local-init.js";
import { appendRawTrace } from "./raw-trace.js";
import { redactionMetadata, redactString } from "./redaction.js";
import {
	EXTENSION_ID,
	getStoredSettingsValues,
	registerSettings,
	type SettingsValues,
	setSettingsValues,
} from "./settings.js";

interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; total?: number };
}

interface PromptState {
	trace?: LangfuseTrace;
	promptSpan?: LangfuseSpan;
	userPrompt: string;
	systemPrompt: string;
	cwd: string;
	startedAt: number;
	toolCalls: number;
	toolErrors: number;
	turns: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	lastAssistantText: string;
	lastUsage?: PiUsage;
	activeTurns: Map<number, TurnState>;
	activeTools: Map<string, ToolState>;
	lastMessages?: Array<{ role: string; content: unknown }>;
}

interface TurnState {
	index: number;
	startedAt: number;
	span?: LangfuseSpan;
	generation?: LangfuseGeneration;
	streamingText?: string;
	streamingThinking?: string;
	requests?: Array<{
		timestamp: string;
		payloadSize: number;
		model: string;
	}>;
}

interface ToolState {
	toolName: string;
	startedAt: number;
	span?: LangfuseSpan;
	argsSummary: string;
	argsRaw?: unknown;
	partialOutput?: string;
	resultOutput?: string;
	isError?: boolean;
}

let currentSessionId = "";
let currentSessionFile = "";
let currentPreviousSessionFile = "";
let currentSessionReason = "startup";
let currentModel = "";
let currentProvider = "";
let promptState: PromptState | null = null;
let compactCount = 0;

const LANGFUSE_STATUS_KEY = "pi-langfuse:status";

interface LangfuseUiContext {
	ui?: {
		setStatus?: (key: string, text: string | undefined) => void;
	};
	sessionManager?: { getSessionFile?: () => string | undefined };
}

function getLiveSettingsView(
	settings: Partial<SettingsValues>,
): SettingsValues {
	const config = resolveConfig(settings);
	return {
		enabled: config.enabled,
		"public-key": config.publicKey,
		"secret-key": config.secretKey,
		"base-url": config.host,
		"user-id": config.userId,
		"default-tags": config.defaultTags.join(", "),
		release: config.release,
		environment: config.environment,
		"trace-input-max-chars": config.traceInputMaxChars,
		"trace-output-max-chars": config.traceOutputMaxChars,
		"tool-args-max-chars": config.toolArgsMaxChars,
		"tool-output-max-chars": config.toolOutputMaxChars,
		"capture-tool-progress": config.captureToolProgress,
		"capture-message-updates": config.captureMessageUpdates,
		"redaction-enabled": config.redactionEnabled,
		"raw-trace-enabled": config.rawTraceEnabled,
		"raw-trace-dir": config.rawTraceDir,
	};
}

function announceConfigState(settings: Partial<SettingsValues>) {
	const config = resolveConfig(settings);
	if (!config.enabled) return;
	if (!config.publicKey || !config.secretKey) {
		console.log(
			"📊 Langfuse: Configure public/secret key in settings, pi-langfuse.json, or LANGFUSE_* env vars to enable",
		);
	}
	for (const warning of getConfigWarnings(config)) {
		console.warn(`📊 Langfuse: ${warning}`);
	}
}

function getLangfuseStatus(config: Config, sessionFile?: string) {
	if (!config.enabled) {
		return { icon: "⚪", label: "OFF", detail: "disabled in settings" };
	}
	if (!config.publicKey || !config.secretKey) {
		return { icon: "⚪", label: "OFF", detail: "missing Langfuse keys" };
	}
	if (config.skipUnpersistedSessions && !sessionFile) {
		return { icon: "⚪", label: "OFF", detail: "no session file" };
	}
	return { icon: "🟢", label: "ON", detail: config.host };
}

function updateLangfuseStatusLine(
	ctx: LangfuseUiContext | undefined,
	config: Config,
) {
	const setStatus = ctx?.ui?.setStatus;
	if (!setStatus) return;

	const sessionFile = ctx?.sessionManager?.getSessionFile?.();
	const status = getLangfuseStatus(config, sessionFile);
	setStatus(LANGFUSE_STATUS_KEY, `Langfuse ${status.icon}`);
}

function truncate(text: string, max = 1200) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function telemetryText(config: Config, text: string, max: number) {
	const scanLimit = Math.max(max * 2, max + 500);
	const bounded =
		text.length > scanLimit
			? `${text.slice(0, scanLimit)}…[truncated ${text.length - scanLimit} chars]`
			: text;
	return truncate(redactString(config, bounded), max);
}

function safeJson(config: Config, value: unknown, max = 1200) {
	try {
		return telemetryText(config, JSON.stringify(value, null, 2), max);
	} catch {
		return "[unserializable]";
	}
}

function summarizeToolArgs(config: Config, toolName: string, args: unknown) {
	if (!args || typeof args !== "object")
		return safeJson(config, args, config.toolArgsMaxChars);
	const data = args as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return telemetryText(
				config,
				String(data.command ?? ""),
				config.toolArgsMaxChars,
			);
		case "read":
			return telemetryText(
				config,
				`${String(data.path ?? "")}#${String(data.offset ?? 1)}:${String(data.limit ?? "")}`,
				config.toolArgsMaxChars,
			);
		case "write":
		case "edit":
			return telemetryText(
				config,
				String(data.path ?? ""),
				config.toolArgsMaxChars,
			);
		case "web_search":
			return telemetryText(
				config,
				String(
					data.query ??
						(Array.isArray(data.queries) ? data.queries.join(" | ") : ""),
				),
				config.toolArgsMaxChars,
			);
		default:
			return safeJson(config, args, config.toolArgsMaxChars);
	}
}

function extractTextFromContent(
	content: Array<{ type: string; text?: string }> | undefined,
) {
	if (!content?.length) return "";
	return content
		.filter((item) => item.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
}

function summarizeMessageContent(config: Config, content: unknown) {
	if (typeof content === "string") {
		return telemetryText(config, content, config.traceInputMaxChars);
	}
	if (Array.isArray(content)) {
		const text = extractTextFromContent(
			content.slice(0, 20) as Array<{ type: string; text?: string }>,
		);
		if (text) return telemetryText(config, text, config.traceInputMaxChars);
		return `[${content.length} content item(s)]`;
	}
	if (content && typeof content === "object") {
		const maybeContent = (content as { content?: unknown }).content;
		if (Array.isArray(maybeContent))
			return summarizeMessageContent(config, maybeContent);
		return "[object content]";
	}
	return content == null ? "" : String(content);
}

function summarizeMessages(
	config: Config,
	messages: Array<{ role?: string; content?: unknown }>,
) {
	const limit = 40;
	const selected = messages.slice(-limit).map((message) => ({
		role: message.role || "unknown",
		content: summarizeMessageContent(config, message.content),
	}));
	if (messages.length > limit) {
		selected.unshift({
			role: "system",
			content: `[truncated ${messages.length - limit} earlier message(s)]`,
		});
	}
	return selected;
}

function summarizeProviderPayload(config: Config, payload: unknown) {
	if (!payload || typeof payload !== "object") return { type: typeof payload };
	const data = payload as Record<string, unknown>;
	const messages = Array.isArray(data.messages)
		? summarizeMessages(
				config,
				data.messages as Array<{ role?: string; content?: unknown }>,
			)
		: undefined;
	return {
		model: typeof data.model === "string" ? data.model : currentModel,
		messageCount: Array.isArray(data.messages)
			? data.messages.length
			: undefined,
		messages,
		keys: Object.keys(data).slice(0, 50),
	};
}

function summarizeToolResult(config: Config, result: unknown) {
	if (!result) return "";
	if (typeof result === "string")
		return telemetryText(config, result, config.toolOutputMaxChars);
	if (typeof result === "object") {
		const data = result as { content?: Array<{ type: string; text?: string }> };
		const text = extractTextFromContent(data.content);
		if (text) return telemetryText(config, text, config.toolOutputMaxChars);
	}
	return safeJson(config, result, config.toolOutputMaxChars);
}

function usageDetailsFromUsage(usage?: PiUsage) {
	if (!usage) return undefined;
	const details: Record<string, number> = {};
	if (usage.input) details.input = usage.input;
	if (usage.output) details.output = usage.output;
	if (usage.cacheRead) details.input_cached_read = usage.cacheRead;
	if (usage.cacheWrite) details.input_cached_write = usage.cacheWrite;
	if (usage.totalTokens) details.total = usage.totalTokens;
	return Object.keys(details).length > 0 ? details : undefined;
}

function standardUsageFromUsage(usage?: PiUsage) {
	if (!usage) return undefined;
	const standard: Record<string, number> = {};
	if (usage.input) standard.input = usage.input;
	if (usage.output) standard.output = usage.output;
	if (usage.totalTokens) {
		standard.total = usage.totalTokens;
	} else if (usage.input || usage.output) {
		standard.total = (usage.input ?? 0) + (usage.output ?? 0);
	}
	return Object.keys(standard).length > 0 ? standard : undefined;
}

function costDetailsFromUsage(usage?: PiUsage) {
	const cost = usage?.cost;
	if (!cost) return undefined;
	const details: Record<string, number> = {};
	if (typeof cost.input === "number") details.input = cost.input;
	if (typeof cost.output === "number") details.output = cost.output;
	if (typeof cost.total === "number") details.total = cost.total;
	return Object.keys(details).length > 0 ? details : undefined;
}

function getUserId(config?: Config) {
	return config?.userId || undefined;
}

function getRuntimeName() {
	return process.env.TIA_ACTIVE === "1" ? "tia" : "pi";
}

function getSessionRoot(sessionFile = currentSessionFile) {
	const marker = "/sessions/";
	const index = sessionFile.indexOf(marker);
	return index >= 0
		? sessionFile.slice(0, index + marker.length - 1)
		: undefined;
}

function rawTraceBase(turnIndex?: number) {
	return {
		timestamp: new Date().toISOString(),
		sessionId: currentSessionId || undefined,
		sessionFile: currentSessionFile || undefined,
		turnIndex,
		provider: currentProvider || undefined,
		model: currentModel || undefined,
		runtime: getRuntimeName(),
	};
}

function currentTurnIndex() {
	if (!promptState) return undefined;
	const activeTurns = Array.from(promptState.activeTurns.values());
	return activeTurns.length > 0
		? activeTurns[activeTurns.length - 1]?.index
		: undefined;
}

function writeRawTrace(
	config: Config,
	record: { type: string } & Record<string, unknown>,
) {
	appendRawTrace(config, currentSessionFile, {
		...rawTraceBase(
			typeof record.turnIndex === "number" ? record.turnIndex : undefined,
		),
		redaction: redactionMetadata(config),
		traceId: promptState?.trace?.id,
		...record,
	});
}

function rawTraceSummary(
	config: Config,
	value: unknown,
	max = config.toolOutputMaxChars,
) {
	return summarizeToolResult(config, value) || safeJson(config, value, max);
}

function buildTraceTags(config: Config | undefined, cwd: string) {
	const runtime = getRuntimeName();
	const tags = [
		"pi",
		"pi-langfuse",
		`runtime:${runtime}`,
		...(config?.defaultTags ?? []),
	];
	const projectName = basename(cwd || process.cwd());
	if (projectName) tags.push(`project:${projectName}`);
	if (currentProvider) tags.push(`provider:${currentProvider}`);
	if (currentModel) tags.push(`model:${currentModel}`);
	if (currentSessionReason) tags.push(`session:${currentSessionReason}`);
	return Array.from(new Set(tags)).slice(0, 20);
}

async function finalizePrompt(config: Config | undefined, flush = false) {
	if (!promptState) return;

	for (const [, tool] of promptState.activeTools) {
		tool.span?.end({
			isError: tool.isError ?? true,
			output: tool.resultOutput || tool.partialOutput,
			statusMessage: tool.isError
				? "tool error"
				: "tool ended without completion event",
			metadata: {
				tool: tool.toolName,
				argsSummary: tool.argsSummary,
				durationMs: Date.now() - tool.startedAt,
				abandoned: true,
			},
		});
	}
	promptState.activeTools.clear();

	for (const [, turn] of promptState.activeTurns) {
		if (turn.generation) {
			turn.generation.end({
				isError: true,
				statusMessage: "generation abandoned during prompt finalization",
				metadata: {
					abandoned: true,
					turnIndex: turn.index,
					durationMs: Date.now() - turn.startedAt,
				},
			});
		}
		turn.span?.end({
			metadata: {
				turnIndex: turn.index,
				durationMs: Date.now() - turn.startedAt,
				abandoned: true,
			},
			statusMessage: "turn ended during cleanup",
		});
	}
	promptState.activeTurns.clear();

	promptState.promptSpan?.end({
		output: promptState.lastAssistantText || undefined,
		metadata: {
			completed: true,
			toolCalls: promptState.toolCalls,
			toolErrors: promptState.toolErrors,
			turns: promptState.turns,
			durationMs: Date.now() - promptState.startedAt,
			compactCount,
		},
	});

	promptState.trace?.update({
		output: promptState.lastAssistantText || undefined,
		userId: getUserId(config),
		sessionId: currentSessionId || undefined,
		tags: buildTraceTags(config, promptState.cwd),
		release: config?.release || undefined,
		environment: config?.environment || undefined,
		metadata: {
			redaction: config ? redactionMetadata(config) : undefined,
			cwd: promptState.cwd,
			systemPrompt: config
				? telemetryText(
						config,
						promptState.systemPrompt,
						config.traceInputMaxChars,
					)
				: truncate(promptState.systemPrompt, 2000),
			model: currentModel,
			provider: currentProvider,
			sessionReason: currentSessionReason,
			runtime: getRuntimeName(),
			sessionRoot: getSessionRoot(),
			sessionFile: currentSessionFile || undefined,
			previousSessionFile: currentPreviousSessionFile || undefined,
			tiaActive: process.env.TIA_ACTIVE === "1",
			tiaCommand: process.env.TIA_COMMAND || undefined,
			completed: true,
			turns: promptState.turns,
			toolCalls: promptState.toolCalls,
			toolErrors: promptState.toolErrors,
			tokensIn: promptState.tokensIn,
			tokensOut: promptState.tokensOut,
			cacheRead: promptState.cacheRead,
			cacheWrite: promptState.cacheWrite,
			compactCount,
			durationMs: Date.now() - promptState.startedAt,
		},
	});

	if (flush) {
		await flushClient();
	}
	promptState = null;
}

export default async function (pi: ExtensionAPI) {
	let settings = getStoredSettingsValues(pi);
	let lastUiContext: LangfuseUiContext | undefined;

	const refreshConfig = async () => {
		settings = getStoredSettingsValues(pi);
		registerSettings(pi, getLiveSettingsView(settings));
		await finalizePrompt(resolveConfig(settings), true);
		await shutdownClient();
		announceConfigState(settings);
		updateLangfuseStatusLine(lastUiContext, resolveConfig(settings));
	};

	pi.events.on("pi-extension-settings:ready", () => {
		registerSettings(pi, getLiveSettingsView(settings));
	});
	registerSettings(pi, getLiveSettingsView(settings));

	pi.events.on(`pi-extension-settings:${EXTENSION_ID}:changed`, () => {
		void refreshConfig();
	});
	pi.events.on(`extension:settings:changed:${EXTENSION_ID}`, () => {
		void refreshConfig();
	});

	pi.registerCommand("langfuse-init", {
		description:
			"Initialize a local self-hosted Langfuse stack for Pi without overwriting existing files",
		handler: runLangfuseInit,
	});

	pi.registerCommand("langfuse:export", {
		description:
			"Create a local redacted export of Pi sessions and pi-langfuse raw traces without uploading anywhere",
		handler: async (args, ctx) => {
			const report = exportRedactedData(resolveConfig(settings), args, ctx);
			ctx.ui?.notify?.(
				`Redacted export: ${report.summary.approved}/${report.summary.files} approved`,
				report.summary.rejected > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("langfuse:toggle", {
		description:
			"Toggle Langfuse tracing or force on/off with /langfuse:toggle [on|off]",
		handler: async (args, ctx) => {
			const current = resolveConfig(settings);
			const nextEnabled =
				args.trim() === "on"
					? true
					: args.trim() === "off"
						? false
						: !current.enabled;

			setSettingsValues({ enabled: nextEnabled });
			await refreshConfig();

			const next = resolveConfig(settings);
			lastUiContext = ctx;
			updateLangfuseStatusLine(ctx, next);
			const status = next.enabled ? `enabled → ${next.host}` : "disabled";
			ctx.ui?.notify?.(`Langfuse tracing ${status}`, "info");
		},
	});

	await shutdownClient();
	announceConfigState(settings);

	pi.on("session_start", async (event, ctx) => {
		lastUiContext = ctx;
		updateLangfuseStatusLine(ctx, resolveConfig(settings));
		const sessionFile = ctx.sessionManager.getSessionFile();
		currentSessionFile = sessionFile || "";
		if (sessionFile) {
			const filename = sessionFile.split("/").pop() || "";
			currentSessionId = filename.replace(".jsonl", "");
		} else {
			currentSessionId = "";
		}
		const data = event as typeof event & {
			reason?: string;
			previousSessionFile?: string;
		};
		currentSessionReason = data.reason || "startup";
		currentPreviousSessionFile = data.previousSessionFile || "";
		compactCount = 0;
		const config = resolveConfig(settings);
		appendRawTrace(config, currentSessionFile, {
			type: "session_start",
			timestamp: new Date().toISOString(),
			sessionId: currentSessionId || undefined,
			sessionFile: currentSessionFile || undefined,
			reason: currentSessionReason,
			previousSessionFile: currentPreviousSessionFile || undefined,
			runtime: getRuntimeName(),
			redaction: redactionMetadata(config),
		});
	});

	pi.on("model_select", async (event, _ctx) => {
		currentModel = event.model?.id || "";
		currentProvider = event.model?.provider || "";
		if (promptState) {
			const config = resolveConfig(settings);
			promptState.trace?.update({
				metadata: {
					model: currentModel,
					provider: currentProvider,
				},
				tags: buildTraceTags(config, promptState.cwd),
			});
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastUiContext = ctx;
		const config = resolveConfig(settings);
		updateLangfuseStatusLine(ctx, config);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (config.skipUnpersistedSessions && !sessionFile) return;
		if (!canTrace(config) && !config.rawTraceEnabled) return;
		currentSessionFile = sessionFile || "";

		await finalizePrompt(config, false);

		const eventData = event as typeof event & {
			systemPromptOptions?: { cwd?: string };
		};
		const cwd = eventData.systemPromptOptions?.cwd || process.cwd();

		if (!currentModel && ctx.model) {
			currentModel = ctx.model.id || "";
			currentProvider = ctx.model.provider || "";
		}

		promptState = {
			userPrompt: event.prompt,
			systemPrompt: event.systemPrompt || "",
			cwd,
			startedAt: Date.now(),
			toolCalls: 0,
			toolErrors: 0,
			turns: 0,
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			lastAssistantText: "",
			activeTurns: new Map(),
			activeTools: new Map(),
		};

		writeRawTrace(config, {
			type: "agent_prompt_start",
			cwd,
			prompt: event.prompt,
			systemPrompt: event.systemPrompt || "",
			sessionReason: currentSessionReason,
			previousSessionFile: currentPreviousSessionFile || undefined,
		});

		try {
			if (!canTrace(config)) return;

			await ensureLocalLangfuseStarted(config);
			const lf = await getClient(config);
			const trace = lf.trace({
				name: "pi-agent",
				input: telemetryText(config, event.prompt, config.traceInputMaxChars),
				sessionId: currentSessionId || undefined,
				userId: getUserId(config),
				tags: buildTraceTags(config, cwd),
				release: config.release || undefined,
				environment: config.environment || undefined,
				metadata: {
					redaction: redactionMetadata(config),
					cwd,
					systemPrompt: telemetryText(
						config,
						event.systemPrompt || "",
						config.traceInputMaxChars,
					),
					model: currentModel,
					provider: currentProvider,
					sessionReason: currentSessionReason,
					runtime: getRuntimeName(),
					sessionRoot: getSessionRoot(),
					sessionFile: currentSessionFile || undefined,
					previousSessionFile: currentPreviousSessionFile || undefined,
					tiaActive: process.env.TIA_ACTIVE === "1",
					tiaCommand: process.env.TIA_COMMAND || undefined,
				},
			});

			promptState.trace = trace;
		} catch (e) {
			console.warn("📊 Langfuse: Failed to create trace", e);
		}
	});

	pi.on("agent_start", async () => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		if (!canTrace(config) || !promptState.trace) return;
		try {
			const lf = await getClient(config);
			promptState.promptSpan = lf.span({
				name: "agent.prompt",
				traceId: promptState.trace.id,
				input: telemetryText(
					config,
					promptState.userPrompt,
					config.traceInputMaxChars,
				),
				metadata: {
					redaction: redactionMetadata(config),
					cwd: promptState.cwd,
					model: currentModel,
					provider: currentProvider,
					sessionReason: currentSessionReason,
				},
			});
		} catch (e) {
			console.warn("📊 Langfuse: Failed to create prompt span", e);
		}
	});

	pi.on("turn_start", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		promptState.turns += 1;
		const turnState: TurnState = {
			index: event.turnIndex,
			startedAt: Date.now(),
		};
		promptState.activeTurns.set(event.turnIndex, turnState);
		if (!canTrace(config) || !promptState.trace) return;
		try {
			const lf = await getClient(config);
			turnState.span = lf.span({
				name: "agent.turn",
				traceId: promptState.trace.id,
				parentObservationId: promptState.promptSpan?.id,
				metadata: {
					redaction: redactionMetadata(config),
					turnIndex: event.turnIndex,
					turnNumber: promptState.turns,
					model: currentModel,
					provider: currentProvider,
				},
			});
		} catch (e) {
			console.warn("📊 Langfuse: Failed to create turn span", e);
		}
	});

	// Capture full messages (system prompt + conversation history + tools) before
	// each LLM call. These are used as the generation input so Langfuse UI shows
	// the complete prompt instead of just the user's text.
	pi.on("context", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		if (!canTrace(config)) return;

		const activeTurns = Array.from(promptState.activeTurns.values());
		const activeTurn =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		if (!activeTurn) return;

		// Keep only bounded message summaries on the live path. Full context belongs
		// to Pi's canonical session and /langfuse:export, not synchronous telemetry.
		promptState.lastMessages = summarizeMessages(
			config,
			event.messages as Array<{ role?: string; content?: unknown }>,
		);
	});

	pi.on("tool_call", async (event) => {
		const tool = promptState?.activeTools.get(event.toolCallId);
		if (!tool) return;
		const config = resolveConfig(settings);
		tool.argsSummary = summarizeToolArgs(config, event.toolName, event.input);
		tool.argsRaw = event.input;
		writeRawTrace(config, {
			type: "tool_call",
			turnIndex: currentTurnIndex(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
		});
		tool.span?.update?.({
			input: tool.argsSummary,
			metadata: {
				tool: event.toolName,
				argsSummary: tool.argsSummary,
			},
		});
	});

	pi.on("tool_execution_start", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);

		promptState.toolCalls += 1;
		const activeTurns = Array.from(promptState.activeTurns.values());
		const activeTurn =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		const toolState: ToolState = {
			toolName: event.toolName,
			startedAt: Date.now(),
			argsSummary: summarizeToolArgs(config, event.toolName, event.args),
			argsRaw: event.args,
		};
		promptState.activeTools.set(event.toolCallId, toolState);
		writeRawTrace(config, {
			type: "tool_execution_start",
			turnIndex: activeTurn?.index,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});

		if (!canTrace(config) || !promptState.trace) return;
		try {
			const lf = await getClient(config);
			toolState.span = lf.span({
				name: `tool:${event.toolName}`,
				traceId: promptState.trace.id,
				parentObservationId: activeTurn?.span?.id || promptState.promptSpan?.id,
				input: toolState.argsSummary,
				metadata: {
					tool: event.toolName,
					toolCallId: event.toolCallId,
					argsSummary: toolState.argsSummary,
					turnIndex: activeTurn?.index,
				},
			});
		} catch (e) {
			console.warn("📊 Langfuse: Failed to create tool span", e);
		}
	});

	pi.on("tool_execution_update", async (event) => {
		const tool = promptState?.activeTools.get(event.toolCallId);
		if (!tool) return;
		const config = resolveConfig(settings);
		if (!config.captureToolProgress) return;
		tool.partialOutput = summarizeToolResult(config, event.partialResult);
		tool.span?.update?.({
			output: tool.partialOutput,
			metadata: {
				partial: true,
				tool: tool.toolName,
			},
		});
	});

	pi.on("tool_result", async (event) => {
		const tool = promptState?.activeTools.get(event.toolCallId);
		if (!tool) return;
		const config = resolveConfig(settings);
		tool.resultOutput = summarizeToolResult(config, { content: event.content });
		tool.isError = event.isError;
		writeRawTrace(config, {
			type: "tool_result_first_seen",
			turnIndex: currentTurnIndex(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			inputSummary: summarizeToolArgs(config, event.toolName, event.input),
			contentSummary: rawTraceSummary(config, { content: event.content }),
			contentTruncated: true,
			isError: event.isError,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		const tool = promptState?.activeTools.get(event.toolCallId);
		if (!tool) return;
		const config = resolveConfig(settings);
		tool.isError = event.isError;
		if (event.isError && promptState) {
			promptState.toolErrors += 1;
		}
		const durationMs = Date.now() - tool.startedAt;
		writeRawTrace(config, {
			type: "tool_execution_end",
			turnIndex: currentTurnIndex(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			argsSummary: tool.argsSummary,
			resultSummary: rawTraceSummary(config, event.result),
			resultTruncated: true,
			isError: event.isError,
			durationMs,
		});
		const output =
			tool.resultOutput ||
			summarizeToolResult(config, event.result) ||
			tool.partialOutput;
		tool.span?.end({
			isError: event.isError,
			output: output || undefined,
			statusMessage: event.isError ? "tool execution failed" : undefined,
			metadata: {
				tool: tool.toolName,
				argsSummary: tool.argsSummary,
				durationMs,
			},
		});
		promptState?.activeTools.delete(event.toolCallId);
	});

	pi.on("message_start", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		if (!canTrace(config) || !promptState.trace) return;

		const message = event.message as { role?: string };
		if (message.role !== "assistant") return;

		const activeTurns = Array.from(promptState.activeTurns.values());
		const turnState =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		if (!turnState) return;

		turnState.streamingText = "";
		turnState.streamingThinking = "";

		// Use the full messages captured from `context` as generation input.
		// Langfuse renders chat message arrays natively in the UI, showing the
		// complete LLM prompt (system prompt, conversation history, tools, etc.),
		// instead of just the raw user text.
		const generationInput = promptState.lastMessages
			? promptState.lastMessages
			: telemetryText(
					config,
					promptState.userPrompt,
					config.traceInputMaxChars,
				);

		try {
			const lf = await getClient(config);
			turnState.generation = lf.generation({
				name: "llm-response",
				traceId: promptState.trace.id,
				parentObservationId: turnState.span?.id || promptState.promptSpan?.id,
				input: generationInput,
				model: currentModel || undefined,
				metadata: {
					redaction: redactionMetadata(config),
					turnIndex: turnState.index,
					model: currentModel,
					provider: currentProvider,
				},
			});
		} catch (e) {
			console.warn("📊 Langfuse: Failed to start generation", e);
		}
	});

	pi.on("message_update", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		if (!canTrace(config)) return;

		const message = event.message as { role?: string };
		if (message.role !== "assistant") return;

		const activeTurns = Array.from(promptState.activeTurns.values());
		const turnState =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		if (!turnState?.generation) return;

		const assistantEvent = event.assistantMessageEvent as {
			type: string;
			delta?: string;
		};
		if (!assistantEvent) return;

		if (assistantEvent.type === "text_delta") {
			turnState.streamingText =
				(turnState.streamingText || "") + (assistantEvent.delta ?? "");
		} else if (assistantEvent.type === "thinking_delta") {
			turnState.streamingThinking =
				(turnState.streamingThinking || "") + (assistantEvent.delta ?? "");
		}

		// Optionally update the generation in real-time if configured
		if (config.captureMessageUpdates) {
			turnState.generation.update?.({
				output: telemetryText(
					config,
					(turnState.streamingThinking || "") + (turnState.streamingText || ""),
					config.traceOutputMaxChars,
				),
				metadata: {
					hasThinking: !!turnState.streamingThinking,
					partial: true,
				},
			});
		}
	});

	pi.on("message_end", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);

		const message = event.message as {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
			model?: string;
			usage?: PiUsage;
		};
		if (message.role !== "assistant") return;

		const activeTurns = Array.from(promptState.activeTurns.values());
		const turnState =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		if (!turnState) return;

		const outputText = extractTextFromContent(message.content).trim();
		const finalOutput =
			outputText ||
			(turnState.streamingThinking || "") + (turnState.streamingText || "");

		const usage = message.usage;
		const standardUsage = standardUsageFromUsage(usage);
		const usageDetails = usageDetailsFromUsage(usage);
		const costDetails = costDetailsFromUsage(usage);

		promptState.lastAssistantText = telemetryText(
			config,
			finalOutput,
			config.traceOutputMaxChars,
		);
		promptState.lastUsage = usage;
		writeRawTrace(config, {
			type: "assistant_output",
			turnIndex: turnState.index,
			text: finalOutput,
			thinking: turnState.streamingThinking || undefined,
			usage,
			messageModel: message.model || undefined,
		});

		if (usage) {
			promptState.tokensIn +=
				(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			promptState.tokensOut += usage.output ?? 0;
			promptState.cacheRead += usage.cacheRead ?? 0;
			promptState.cacheWrite += usage.cacheWrite ?? 0;
		}

		if (!canTrace(config) || !promptState.trace || !turnState.generation)
			return;

		try {
			turnState.generation.end({
				output:
					telemetryText(config, finalOutput, config.traceOutputMaxChars) ||
					undefined,
				usage: standardUsage,
				usageDetails,
				costDetails,
				model: message.model || currentModel || undefined,
				metadata: {
					model: message.model || currentModel,
					provider: currentProvider,
					turnIndex: turnState.index,
					thinking: turnState.streamingThinking || undefined,
				},
			});

			const lf = await getClient(config);
			if (usage?.input) {
				lf.score({
					name: "input_tokens",
					value: usage.input,
					traceId: promptState.trace.id,
					observationId: turnState.generation.id,
				});
			}
			if (usage?.output) {
				lf.score({
					name: "output_tokens",
					value: usage.output,
					traceId: promptState.trace.id,
					observationId: turnState.generation.id,
				});
			}
			if (typeof usage?.cost?.total === "number") {
				lf.score({
					name: "total_cost",
					value: usage.cost.total,
					traceId: promptState.trace.id,
					observationId: turnState.generation.id,
				});
			}
		} catch (e) {
			console.warn("📊 Langfuse: Failed to end generation", e);
		}
	});

	pi.on("turn_end", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);

		const message = event.message as {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
			usage?: PiUsage;
		};
		const turnState = promptState.activeTurns.get(event.turnIndex);
		const outputText = extractTextFromContent(message.content).trim();

		const usage = message.usage;
		const standardUsage = standardUsageFromUsage(usage);
		const usageDetails = usageDetailsFromUsage(usage);
		const costDetails = costDetailsFromUsage(usage);

		if (canTrace(config)) {
			turnState?.span?.end({
				output: outputText
					? telemetryText(config, outputText, config.traceOutputMaxChars)
					: undefined,
				usage: standardUsage,
				usageDetails,
				costDetails,
				metadata: {
					turnIndex: event.turnIndex,
					durationMs: turnState ? Date.now() - turnState.startedAt : undefined,
					toolResults: event.toolResults?.length ?? 0,
				},
			});
		}
		promptState.activeTurns.delete(event.turnIndex);
	});

	pi.on("before_provider_request", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);

		const activeTurns = Array.from(promptState.activeTurns.values());
		const turnState =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		if (!turnState) return;

		try {
			const payloadSummary = summarizeProviderPayload(config, event.payload);
			const payloadSummaryText = safeJson(
				config,
				payloadSummary,
				config.providerPayloadMaxChars,
			);
			writeRawTrace(config, {
				type: "provider_request",
				turnIndex: turnState.index,
				payloadCaptured: config.captureProviderPayload,
				payloadSummary: config.captureProviderPayload
					? payloadSummaryText
					: undefined,
			});
			const payloadSize = payloadSummaryText.length;
			if (!turnState.requests) turnState.requests = [];
			const reqModel =
				typeof (event.payload as Record<string, unknown>)?.model === "string"
					? ((event.payload as Record<string, unknown>).model as string)
					: currentModel;
			turnState.requests.push({
				timestamp: new Date().toISOString(),
				payloadSize,
				model: reqModel,
			});

			// Update turn span metadata with requests info. Full payload capture is
			// intentionally opt-in because provider payloads can contain large context
			// and sensitive data. Enable it with captureProviderPayload=true.
			turnState.span?.update?.({
				metadata: {
					requests: turnState.requests,
					providerPayload: config.captureProviderPayload
						? payloadSummaryText
						: undefined,
				},
			});
		} catch (_e) {
			// ignore
		}
	});

	pi.on("agent_end", async (event) => {
		if (!promptState) return;
		const eventData = event as {
			messages?: Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
			}>;
		};
		const messages = eventData.messages || [];
		const lastAssistant = messages
			.filter((message) => message.role === "assistant")
			.pop();
		if (lastAssistant) {
			const output = extractTextFromContent(lastAssistant.content).trim();
			if (output) {
				const config = resolveConfig(settings);
				promptState.lastAssistantText = telemetryText(
					config,
					output,
					config.traceOutputMaxChars,
				);
			}
		}
		await finalizePrompt(resolveConfig(settings), true);
	});

	pi.on("session_compact", async () => {
		compactCount += 1;
		writeRawTrace(resolveConfig(settings), {
			type: "session_compact",
			compactCount,
		});
		promptState?.trace?.update({
			metadata: {
				compactCount,
				lastCompactedAt: new Date().toISOString(),
			},
		});
	});

	pi.on("session_shutdown", async () => {
		await finalizePrompt(resolveConfig(settings), true);
		await shutdownClient();
	});
}
