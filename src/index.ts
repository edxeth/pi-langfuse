import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type Config,
	canTrace,
	getConfigWarnings,
	resolveConfig,
} from "./config.js";
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
	trace: LangfuseTrace;
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
	};
}

function announceConfigState(settings: Partial<SettingsValues>) {
	const config = resolveConfig(settings);
	if (!config.enabled) {
		console.log("📊 Langfuse: Tracing disabled in extension settings");
		return;
	}
	if (!config.publicKey || !config.secretKey) {
		console.log(
			"📊 Langfuse: Configure public/secret key in settings, config.json, or LANGFUSE_* env vars to enable",
		);
	}
	for (const warning of getConfigWarnings(config)) {
		console.warn(`📊 Langfuse: ${warning}`);
	}
}

function getLangfuseStatus(config: Config, sessionFile?: string) {
	if (!config.enabled) {
		return { icon: "⚪", label: "OFF", detail: "disabled" };
	}
	if (!config.publicKey || !config.secretKey) {
		return { icon: "⚪", label: "OFF", detail: "missing keys" };
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

function safeJson(value: unknown, max = 1200) {
	try {
		return truncate(JSON.stringify(value, null, 2), max);
	} catch {
		return "[unserializable]";
	}
}

function summarizeToolArgs(config: Config, toolName: string, args: unknown) {
	if (!args || typeof args !== "object")
		return safeJson(args, config.toolArgsMaxChars);
	const data = args as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return truncate(String(data.command ?? ""), config.toolArgsMaxChars);
		case "read":
			return truncate(
				`${String(data.path ?? "")}#${String(data.offset ?? 1)}:${String(data.limit ?? "")}`,
				config.toolArgsMaxChars,
			);
		case "write":
		case "edit":
			return truncate(String(data.path ?? ""), config.toolArgsMaxChars);
		case "web_search":
			return truncate(
				String(
					data.query ??
						(Array.isArray(data.queries) ? data.queries.join(" | ") : ""),
				),
				config.toolArgsMaxChars,
			);
		default:
			return safeJson(args, config.toolArgsMaxChars);
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

function summarizeToolResult(config: Config, result: unknown) {
	if (!result) return "";
	if (typeof result === "string")
		return truncate(result, config.toolOutputMaxChars);
	if (typeof result === "object") {
		const data = result as { content?: Array<{ type: string; text?: string }> };
		const text = extractTextFromContent(data.content);
		if (text) return truncate(text, config.toolOutputMaxChars);
	}
	return safeJson(result, config.toolOutputMaxChars);
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

	promptState.trace.update({
		output: promptState.lastAssistantText || undefined,
		userId: getUserId(config),
		sessionId: currentSessionId || undefined,
		tags: buildTraceTags(config, promptState.cwd),
		release: config?.release || undefined,
		environment: config?.environment || undefined,
		metadata: {
			cwd: promptState.cwd,
			systemPrompt: truncate(
				promptState.systemPrompt,
				config?.traceInputMaxChars ?? 2000,
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
	});

	pi.on("model_select", async (event, _ctx) => {
		currentModel = event.model?.id || "";
		currentProvider = event.model?.provider || "";
		if (promptState) {
			const config = resolveConfig(settings);
			promptState.trace.update({
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
		if (!canTrace(config)) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (config.skipUnpersistedSessions && !sessionFile) return;
		currentSessionFile = sessionFile || "";

		await ensureLocalLangfuseStarted(config);
		await finalizePrompt(config, false);

		try {
			const lf = await getClient(config);
			const eventData = event as typeof event & {
				systemPromptOptions?: { cwd?: string };
			};
			const cwd = eventData.systemPromptOptions?.cwd || process.cwd();

			if (!currentModel && ctx.model) {
				currentModel = ctx.model.id || "";
				currentProvider = ctx.model.provider || "";
			}

			const trace = lf.trace({
				name: "pi-agent",
				input: truncate(event.prompt, config.traceInputMaxChars),
				sessionId: currentSessionId || undefined,
				userId: getUserId(config),
				tags: buildTraceTags(config, cwd),
				release: config.release || undefined,
				environment: config.environment || undefined,
				metadata: {
					cwd,
					systemPrompt: truncate(
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

			promptState = {
				trace,
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
		} catch (e) {
			console.warn("📊 Langfuse: Failed to create trace", e);
		}
	});

	pi.on("agent_start", async () => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		if (!canTrace(config)) return;
		try {
			const lf = await getClient(config);
			promptState.promptSpan = lf.span({
				name: "agent.prompt",
				traceId: promptState.trace.id,
				input: truncate(promptState.userPrompt, config.traceInputMaxChars),
				metadata: {
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
		if (!canTrace(config)) return;
		promptState.turns += 1;
		const turnState: TurnState = {
			index: event.turnIndex,
			startedAt: Date.now(),
		};
		promptState.activeTurns.set(event.turnIndex, turnState);
		try {
			const lf = await getClient(config);
			turnState.span = lf.span({
				name: "agent.turn",
				traceId: promptState.trace.id,
				parentObservationId: promptState.promptSpan?.id,
				metadata: {
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

		// The context event provides a DEEP COPY of messages — safe to store.
		// These are the messages that will be sent to the LLM for this turn.
		promptState.lastMessages = event.messages as Array<{
			role: string;
			content: unknown;
		}>;
	});

	pi.on("tool_call", async (event) => {
		const tool = promptState?.activeTools.get(event.toolCallId);
		if (!tool) return;
		const config = resolveConfig(settings);
		tool.argsSummary = summarizeToolArgs(config, event.toolName, event.input);
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
		if (!canTrace(config)) return;

		promptState.toolCalls += 1;
		const activeTurns = Array.from(promptState.activeTurns.values());
		const activeTurn =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		const toolState: ToolState = {
			toolName: event.toolName,
			startedAt: Date.now(),
			argsSummary: summarizeToolArgs(config, event.toolName, event.args),
		};
		promptState.activeTools.set(event.toolCallId, toolState);

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
		const output =
			summarizeToolResult(config, event.result) ||
			tool.resultOutput ||
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
		if (!canTrace(config)) return;

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
			: truncate(promptState.userPrompt, config.traceInputMaxChars);

		try {
			const lf = await getClient(config);
			turnState.generation = lf.generation({
				name: "llm-response",
				traceId: promptState.trace.id,
				parentObservationId: turnState.span?.id || promptState.promptSpan?.id,
				input: generationInput,
				model: currentModel || undefined,
				metadata: {
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
				output: truncate(
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
		if (!canTrace(config)) return;

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
		if (!turnState?.generation) return;

		const outputText = extractTextFromContent(message.content).trim();
		const finalOutput =
			outputText ||
			(turnState.streamingThinking || "") + (turnState.streamingText || "");

		const usage = message.usage;
		const standardUsage = standardUsageFromUsage(usage);
		const usageDetails = usageDetailsFromUsage(usage);
		const costDetails = costDetailsFromUsage(usage);

		promptState.lastAssistantText = truncate(
			finalOutput,
			config.traceOutputMaxChars,
		);
		promptState.lastUsage = usage;

		if (usage) {
			promptState.tokensIn +=
				(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			promptState.tokensOut += usage.output ?? 0;
			promptState.cacheRead += usage.cacheRead ?? 0;
			promptState.cacheWrite += usage.cacheWrite ?? 0;
		}

		try {
			turnState.generation.end({
				output: truncate(finalOutput, config.traceOutputMaxChars) || undefined,
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
		if (!canTrace(config)) return;

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

		turnState?.span?.end({
			output: outputText
				? truncate(outputText, config.traceOutputMaxChars)
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
		promptState.activeTurns.delete(event.turnIndex);
	});

	pi.on("before_provider_request", async (event) => {
		if (!promptState) return;
		const config = resolveConfig(settings);
		if (!canTrace(config)) return;

		const activeTurns = Array.from(promptState.activeTurns.values());
		const turnState =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		if (!turnState) return;

		try {
			const payloadText = JSON.stringify(event.payload);
			const payloadSize = payloadText.length;
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
			// and sensitive data. For this private TIA setup it can be enabled in
			// config.json with captureProviderPayload=true.
			turnState.span?.update?.({
				metadata: {
					requests: turnState.requests,
					providerPayload: config.captureProviderPayload
						? truncate(payloadText, config.providerPayloadMaxChars)
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
				promptState.lastAssistantText = truncate(
					output,
					config.traceOutputMaxChars,
				);
			}
		}
		await finalizePrompt(resolveConfig(settings), true);
	});

	pi.on("session_compact", async () => {
		compactCount += 1;
		promptState?.trace.update({
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
