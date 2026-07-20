import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAgentLifecycleHandlers } from "./agent-lifecycle.js";
import {
	type Config,
	canTrace,
	getConfigWarnings,
	resolveConfig,
} from "./config.js";
import { exportRedactedData } from "./export.js";
import { createGenerationLifecycleHandlers } from "./generation-lifecycle.js";
import { flushClient, getClient, shutdownClient } from "./langfuse-client.js";
import type { PromptState, ToolState } from "./lifecycle-types.js";
import { ensureLocalLangfuseStarted } from "./local-autostart.js";
import { runLangfuseInit } from "./local-init.js";
import { appendRawTrace, drainRawTraceQueue } from "./raw-trace.js";
import { redactionMetadata } from "./redaction.js";
import {
	hasActiveSessionLeases,
	type SessionContextLike,
	SessionStateOwner,
} from "./session-state.js";
import {
	EXTENSION_ID,
	getStoredSettingsValues,
	registerSettings,
	type SettingsValues,
	setSettingsValues,
} from "./settings.js";
import {
	buildTraceTags,
	costDetailsFromUsage,
	currentTurnIndex,
	estimateJsonBytes,
	extractTextFromContent,
	getRuntimeName,
	getSessionRoot,
	getUserId,
	redactToolContent,
	safeJson,
	standardUsageFromUsage,
	summarizeMessages,
	summarizeProviderPayload,
	summarizeProviderRequestMessages,
	summarizeToolArgs,
	summarizeToolResult,
	telemetryText,
	truncate,
	usageDetailsFromUsage,
	writeRawTrace,
} from "./telemetry-helpers.js";
import { createTurnLifecycleHandlers } from "./turn-lifecycle.js";

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

export default async function (pi: ExtensionAPI) {
	let settings = getStoredSettingsValues(pi);
	let lastUiContext: LangfuseUiContext | undefined;
	const sessionOwner = new SessionStateOwner<PromptState>();

	const refreshConfig = async () => {
		settings = getStoredSettingsValues(pi);
		registerSettings(pi, getLiveSettingsView(settings));
		const config = resolveConfig(settings);
		for (const state of sessionOwner.values()) {
			await agentLifecycle.finalizePrompt(state, config);
		}
		await flushClient();
		if (!hasActiveSessionLeases()) await shutdownClient();
		announceConfigState(settings);
		updateLangfuseStatusLine(lastUiContext, config);
	};

	const getSessionState = (
		ctx: SessionContextLike | undefined,
		create = false,
	) => (create ? sessionOwner.getOrCreate(ctx) : sessionOwner.get(ctx));

	const getTypedSessionState = (ctx: ExtensionContext | undefined) =>
		getSessionState(ctx);

	const generationLifecycle = createGenerationLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		getSessionState,
		canTrace,
		getClient,
		telemetryText,
		redactionMetadata,
		extractTextFromContent,
		standardUsageFromUsage,
		usageDetailsFromUsage,
		costDetailsFromUsage,
		summarizeMessages,
		summarizeProviderPayload,
		summarizeProviderRequestMessages,
		safeJson,
		estimateJsonBytes,
		writeRawTrace,
	});

	const agentLifecycle = createAgentLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		updateStatus: (ctx, config) => {
			lastUiContext = ctx;
			updateLangfuseStatusLine(ctx, config);
		},
		getSessionState,
		canTrace,
		ensureLocalLangfuseStarted,
		getClient,
		flushClient,
		writeRawTrace,
		buildTraceTags,
		telemetryText,
		getUserId,
		getRuntimeName,
		getSessionRoot,
		redactionMetadata,
		truncate,
		extractTextFromContent,
		abandonTurnGenerations: generationLifecycle.abandonTurn,
	});
	const turnLifecycle = createTurnLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		getSessionState,
		canTrace,
		getClient,
		telemetryText,
		redactionMetadata,
		extractTextFromContent,
		standardUsageFromUsage,
		usageDetailsFromUsage,
		costDetailsFromUsage,
	});

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

	announceConfigState(settings);

	pi.on("session_start", async (event, ctx) => {
		const state = getSessionState(ctx, true);
		if (!state) return;
		lastUiContext = ctx;
		updateLangfuseStatusLine(ctx, resolveConfig(settings));
		const config = resolveConfig(settings);
		await agentLifecycle.finalizePrompt(state, config);

		state.sessionFile = ctx.sessionManager.getSessionFile() || "";
		const data = event as typeof event & {
			reason?: string;
			previousSessionFile?: string;
		};
		state.sessionReason = data.reason || "startup";
		state.previousSessionFile = data.previousSessionFile || "";
		state.compactCount = 0;
		appendRawTrace(config, state.sessionFile, {
			type: "session_start",
			timestamp: new Date().toISOString(),
			sessionId: state.sessionId || undefined,
			sessionFile: state.sessionFile || undefined,
			reason: state.sessionReason,
			previousSessionFile: state.previousSessionFile || undefined,
			runtime: getRuntimeName(),
			redaction: redactionMetadata(config),
		});
	});

	pi.on("model_select", async (event, ctx) => {
		const state = getSessionState(ctx, true);
		if (!state) return;
		state.model = event.model?.id || "";
		state.provider = event.model?.provider || "";
		const prompt = state.promptState;
		if (prompt) {
			const config = resolveConfig(settings);
			prompt.trace?.update({
				metadata: {
					model: state.model,
					provider: state.provider,
				},
				tags: buildTraceTags(config, state, prompt.cwd),
			});
		}
	});

	pi.on("before_agent_start", agentLifecycle.beforeAgentStart);

	pi.on("agent_start", agentLifecycle.agentStart);

	pi.on("turn_start", turnLifecycle.turnStart);

	// Capture context and generation lifecycle through the dedicated generation handler.
	pi.on("context", generationLifecycle.context);

	pi.on("tool_call", async (event, ctx) => {
		const state = getTypedSessionState(ctx);
		const prompt = state?.promptState;
		const tool = prompt?.activeTools.get(event.toolCallId);
		if (!state || !prompt || !tool) return;
		const config = resolveConfig(settings);
		tool.argsSummary = summarizeToolArgs(config, event.toolName, event.input);
		tool.argsRaw = event.input;
		writeRawTrace(config, state, {
			type: "tool_call",
			turnIndex: currentTurnIndex(prompt),
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

	pi.on("tool_execution_start", async (event, ctx) => {
		const state = getTypedSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt) return;
		const config = resolveConfig(settings);

		prompt.toolCalls += 1;
		const activeTurns = Array.from(prompt.activeTurns.values());
		const activeTurn =
			activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : undefined;
		const toolState: ToolState = {
			toolName: event.toolName,
			startedAt: Date.now(),
			argsSummary: summarizeToolArgs(config, event.toolName, event.args),
			argsRaw: event.args,
		};
		prompt.activeTools.set(event.toolCallId, toolState);
		writeRawTrace(config, state, {
			type: "tool_execution_start",
			turnIndex: activeTurn?.index,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});

		if (!canTrace(config) || !prompt.trace) return;
		try {
			const lf = await getClient(config);
			if (
				state.promptState !== prompt ||
				prompt.activeTools.get(event.toolCallId) !== toolState
			)
				return;
			toolState.span = lf.span({
				name: `tool:${event.toolName}`,
				traceId: prompt.trace.id,
				parentObservationId: activeTurn?.span?.id || prompt.promptSpan?.id,
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

	pi.on("tool_execution_update", async (event, ctx) => {
		const state = getTypedSessionState(ctx);
		const tool = state?.promptState?.activeTools.get(event.toolCallId);
		if (!state || !tool) return;
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

	pi.on("tool_result", async (event, ctx) => {
		const state = getTypedSessionState(ctx);
		const prompt = state?.promptState;
		const tool = prompt?.activeTools.get(event.toolCallId);
		if (!state || !prompt || !tool) return;
		const config = resolveConfig(settings);
		tool.resultOutput = summarizeToolResult(config, { content: event.content });
		tool.isError = event.isError;
		const imgCount = (event.content ?? []).filter(
			(c: { type: string }) => c.type === "image" || c.type === "image_url",
		).length;
		writeRawTrace(config, state, {
			type: "tool_result_first_seen",
			turnIndex: currentTurnIndex(prompt),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			inputSummary: summarizeToolArgs(config, event.toolName, event.input),
			contentSummary: redactToolContent(config, { content: event.content }),
			contentTruncated: false,
			imgBlocks: imgCount || undefined,
			isError: event.isError,
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const state = getTypedSessionState(ctx);
		const prompt = state?.promptState;
		const tool = prompt?.activeTools.get(event.toolCallId);
		if (!state || !prompt || !tool) return;
		const config = resolveConfig(settings);
		tool.isError = event.isError;
		if (event.isError) {
			prompt.toolErrors += 1;
		}
		const durationMs = Date.now() - tool.startedAt;
		writeRawTrace(config, state, {
			type: "tool_execution_end",
			turnIndex: currentTurnIndex(prompt),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			argsSummary: tool.argsSummary,
			resultSummary: redactToolContent(config, event.result),
			resultTruncated: false,
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
		prompt.activeTools.delete(event.toolCallId);
	});

	pi.on("message_start", generationLifecycle.messageStart);
	pi.on("message_update", generationLifecycle.messageUpdate);
	pi.on("message_end", generationLifecycle.messageEnd);

	pi.on("turn_end", turnLifecycle.turnEnd);

	pi.on("before_provider_request", generationLifecycle.beforeProviderRequest);
	pi.on("after_provider_response", generationLifecycle.afterProviderResponse);

	pi.on("agent_end", agentLifecycle.agentEnd);

	pi.on("session_compact", async (_event, ctx) => {
		const state = getTypedSessionState(ctx);
		if (!state) return;
		state.compactCount += 1;
		writeRawTrace(resolveConfig(settings), state, {
			type: "session_compact",
			compactCount: state.compactCount,
		});
		state.promptState?.trace?.update({
			metadata: {
				compactCount: state.compactCount,
				lastCompactedAt: new Date().toISOString(),
			},
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = getTypedSessionState(ctx);
		if (!state) {
			if (!hasActiveSessionLeases()) {
				drainRawTraceQueue();
				await shutdownClient();
			}
			return;
		}
		const config = resolveConfig(settings);
		writeRawTrace(config, state, {
			type: "session_end",
			reason: "shutdown",
		});
		drainRawTraceQueue();
		await agentLifecycle.finalizePrompt(state, config, true);
		sessionOwner.deleteState(state);
		if (!hasActiveSessionLeases()) await shutdownClient();
	});
}
