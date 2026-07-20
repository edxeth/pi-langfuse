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
import type { PromptState } from "./lifecycle-types.js";
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
import { createToolLifecycleHandlers } from "./tool-lifecycle.js";
import { createTurnLifecycleHandlers } from "./turn-lifecycle.js";

const LANGFUSE_STATUS_KEY = "pi-langfuse:status";

interface LangfuseUiContext {
	ui?: {
		setStatus?: (key: string, text: string | undefined) => void;
	};
	sessionManager?: { getSessionFile?: () => string | undefined };
}

function displayPayloadLimit(value: number | undefined) {
	return value === Infinity ? "unlimited" : value;
}

function displayCaptureOverride(value: boolean | undefined) {
	return value === undefined ? "inherit" : value ? "on" : "off";
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
		"capture-policy": config.capturePolicy,
		"capture-prompt": displayCaptureOverride(config.capturePrompt),
		"capture-system-prompt": displayCaptureOverride(config.captureSystemPrompt),
		"capture-provider-input": displayCaptureOverride(
			config.captureProviderInput,
		),
		"capture-assistant-output": displayCaptureOverride(
			config.captureAssistantOutput,
		),
		"capture-tool-input": displayCaptureOverride(config.captureToolInput),
		"capture-tool-output": displayCaptureOverride(config.captureToolOutput),
		"capture-metadata": displayCaptureOverride(config.captureMetadata),
		"payload-max-string-chars": displayPayloadLimit(
			config.payloadMaxStringChars,
		),
		"payload-max-tool-chars": displayPayloadLimit(config.payloadMaxToolChars),
		"payload-max-depth": displayPayloadLimit(config.payloadMaxDepth),
		"payload-max-array-items": displayPayloadLimit(config.payloadMaxArrayItems),
		"payload-max-object-keys": displayPayloadLimit(config.payloadMaxObjectKeys),
		"payload-max-nodes": displayPayloadLimit(config.payloadMaxNodes),
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
			await agentLifecycle.finalizePrompt(
				state,
				config,
				false,
				"config refresh",
			);
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

	const toolLifecycle = createToolLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		getSessionState,
		canTrace,
		getClient,
		redactToolContent,
		summarizeToolArgs,
		summarizeToolResult,
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
		abandonTools: toolLifecycle.abandon,
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
		abandonTurnGenerations: generationLifecycle.abandonTurn,
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
		await agentLifecycle.finalizePrompt(
			state,
			config,
			false,
			"session replacement",
		);

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
		if (prompt && !prompt.finalizing) {
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

	pi.on("tool_call", toolLifecycle.toolCall);
	pi.on("tool_execution_start", toolLifecycle.toolExecutionStart);
	pi.on("tool_execution_update", toolLifecycle.toolExecutionUpdate);
	pi.on("tool_result", toolLifecycle.toolResult);
	pi.on("tool_execution_end", toolLifecycle.toolExecutionEnd);

	pi.on("message_start", generationLifecycle.messageStart);
	pi.on("message_update", generationLifecycle.messageUpdate);
	pi.on("message_end", generationLifecycle.messageEnd);

	pi.on("turn_end", turnLifecycle.turnEnd);

	pi.on("before_provider_request", generationLifecycle.beforeProviderRequest);
	pi.on("after_provider_response", generationLifecycle.afterProviderResponse);

	pi.on("agent_end", agentLifecycle.agentEnd);

	pi.on("session_compact", async (_event, ctx) => {
		const state = getTypedSessionState(ctx);
		if (!state || state.promptState?.finalizing) return;
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
		if (!state.shutdownPromise) {
			state.shutdownPromise = (async () => {
				const config = resolveConfig(settings);
				writeRawTrace(config, state, {
					type: "session_end",
					reason: "shutdown",
				});
				const finalization = agentLifecycle.finalizePrompt(
					state,
					config,
					true,
					"session shutdown",
				);
				drainRawTraceQueue();
				await finalization;
				sessionOwner.deleteState(state);
				if (!hasActiveSessionLeases()) await shutdownClient();
			})();
		}
		await state.shutdownPromise;
	});
}
