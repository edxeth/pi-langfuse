import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAgentLifecycleHandlers } from "./agent-lifecycle.js";
import {
	type Config,
	canTrace,
	getConfigFilePath,
	getConfigSources,
	getConfigWarnings,
	resolveConfig,
} from "./config.js";
import { exportRedactedData } from "./export.js";
import { createGenerationLifecycleHandlers } from "./generation-lifecycle.js";
import {
	flushClient,
	getLastRuntimeError,
	getRuntime,
	reconfigureRuntime,
	recordRuntimeError,
	shutdownClient,
} from "./langfuse-client.js";
import {
	addIndirectUsage,
	type PiUsage,
	type PromptState,
} from "./lifecycle-types.js";
import { ensureLocalLangfuseStarted } from "./local-autostart.js";
import { runLangfuseInit } from "./local-init.js";
import { sendIsolatedTestTrace } from "./operator-telemetry.js";
import { CAPTURE_POLICIES, type CapturePolicy } from "./payload-policy.js";
import { appendRawTrace, drainRawTraceQueue } from "./raw-trace.js";
import { redactionMetadata, redactString } from "./redaction.js";
import { subscribeRuntimeErrors } from "./runtime-diagnostics.js";
import {
	type FinalizedTraceTarget,
	hasActiveSessionLeases,
	type SessionContextLike,
	type SessionState,
	SessionStateOwner,
	sameTraceDestination,
	traceDestination,
} from "./session-state.js";
import {
	EXTENSION_ID,
	getStoredSettingsValues,
	registerSettings,
	type SettingsValues,
	setSettingsValues,
} from "./settings.js";
import { collectSourceMetadata } from "./source-metadata.js";
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
	summarizeRawProviderRequestContents,
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
const LANGFUSE_TEST_TIMEOUT_MS = 3_000;
const FEEDBACK_SCORE_NAME = "user_feedback";
const FEEDBACK_USAGE = "Usage: /langfuse-score <good|bad> [comment]";
/** Stored comment length; Langfuse score comments are short free text. */
const FEEDBACK_COMMENT_MAX_CHARS = 500;
/**
 * Longest raw comment accepted. Longer input is rejected, never sliced:
 * redaction needs the whole original text, and a cut could separate a secret
 * from the rest of its literal.
 */
const FEEDBACK_COMMENT_INPUT_MAX_CHARS = 4_000;

interface LangfuseUiContext {
	hasUI?: boolean;
	ui?: {
		setStatus?: (key: string, text: string | undefined) => void;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
	sessionManager?: { getSessionFile?: () => string | undefined };
}

function displayPayloadLimit(value: number | undefined) {
	return value === Infinity ? "unlimited" : value;
}

function displayCaptureOverride(value: boolean | undefined) {
	return value === undefined ? "inherit" : value ? "on" : "off";
}

function maskPublicKey(value: string) {
	if (!value) return "not configured";
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function formatConfigSource(settings: Partial<SettingsValues>) {
	return getConfigSources(settings)
		.map((source) =>
			source === "settings"
				? "settings panel"
				: source === "file"
					? "pi-langfuse.json"
					: source,
		)
		.join(", ");
}

function runtimeMode(config: Config) {
	if (!config.enabled) return "disabled";
	return canTrace(config) ? "v5-otel" : "unconfigured";
}

function operatorSafeText(config: Config, value: string) {
	return truncate(
		redactString(
			{
				redactionEnabled: true,
				secretKey: config.secretKey,
				redactionAdditionalSecrets: config.redactionAdditionalSecrets,
			},
			value,
		),
		500,
	);
}

/**
 * Validate `<good|bad> [comment]`; undefined when the verdict is malformed.
 * The comment keeps its original whitespace, because redaction must see the
 * text exactly as typed.
 */
function parseFeedbackArgs(args: string) {
	const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(args);
	const verdict = match?.[1]?.toLowerCase();
	if (verdict !== "good" && verdict !== "bad") return undefined;
	return { verdict, comment: match?.[2] ?? "" };
}

/**
 * Prepare an accepted feedback comment for the score. Redaction is forced on
 * and runs first, on the original text with the full configuration, so exact
 * secrets that contain whitespace or span lines still match. Flattening and
 * the length bound follow, so a cut never leaves a secret fragment.
 */
function feedbackComment(config: Config, raw: string) {
	const redacted = redactString({ ...config, redactionEnabled: true }, raw);
	const text = redacted
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text ? truncate(text, FEEDBACK_COMMENT_MAX_CHARS) : undefined;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

interface FeedbackNotice {
	message: string;
	level: "info" | "warning" | "error";
}

type FeedbackRequest = {
	config: Config;
	feedback: NonNullable<ReturnType<typeof parseFeedbackArgs>>;
	target: FinalizedTraceTarget;
};

function refusal(message: string, level: FeedbackNotice["level"]) {
	return { notice: { message, level } };
}

/**
 * Decide whether `/langfuse-score` may send a score, in the order the
 * checks must run: syntax, input size, tracing configuration, target trace,
 * then destination. A refusal carries the operator notice; nothing is sent.
 */
function planFeedback(
	args: string,
	settings: Partial<SettingsValues>,
	findTarget: () => { lastFinalizedTrace?: FinalizedTraceTarget } | undefined,
): FeedbackRequest | { notice: FeedbackNotice } {
	const feedback = parseFeedbackArgs(args);
	if (!feedback) return refusal(FEEDBACK_USAGE, "warning");
	// Report only the length: echoing the comment could repeat a secret.
	if (feedback.comment.length > FEEDBACK_COMMENT_INPUT_MAX_CHARS) {
		return refusal(
			`Feedback not saved: the comment has ${feedback.comment.length} characters, over the ${FEEDBACK_COMMENT_INPUT_MAX_CHARS} limit. Shorten it or omit it.`,
			"warning",
		);
	}
	const config = resolveConfig(settings);
	if (!canTrace(config)) {
		recordRuntimeError("Langfuse credentials are not configured");
		return refusal(
			"Feedback not saved: Langfuse tracing is disabled or not configured",
			"error",
		);
	}
	// Only this session's last finalized trace is a valid target. A prompt
	// still running in the session is never scored.
	const target = findTarget()?.lastFinalizedTrace;
	if (!target) {
		return refusal(
			"Feedback not saved: this session has no finalized trace to rate",
			"warning",
		);
	}
	if (!sameTraceDestination(target.destination, traceDestination(config))) {
		return refusal(
			"Feedback not saved: the last trace was written to a different Langfuse destination than the current configuration",
			"error",
		);
	}
	return { config, feedback, target };
}

async function sendFeedback({
	config,
	feedback,
	target,
}: FeedbackRequest): Promise<FeedbackNotice> {
	try {
		const lf = await getRuntime(config);
		// The score resolves only after the scores endpoint answered, so
		// success is reported for delivery, not for enqueueing.
		const delivered = await lf.score({
			name: FEEDBACK_SCORE_NAME,
			value: feedback.verdict === "good" ? 1 : 0,
			dataType: "BOOLEAN",
			traceId: target.traceId,
			comment: feedbackComment(config, feedback.comment),
		});
		if (!delivered) {
			return {
				message: "Feedback not saved: Langfuse did not accept the score",
				level: "error",
			};
		}
		return {
			message: `Feedback saved: ${feedback.verdict} for trace ${target.traceId}`,
			level: "info",
		};
	} catch (error) {
		recordRuntimeError(error);
		return {
			message: `Feedback not saved: ${operatorSafeText(config, errorMessage(error))}`,
			level: "error",
		};
	}
}

function safeHost(config: Config) {
	try {
		const url = new URL(config.host);
		url.username = "";
		url.password = "";
		return operatorSafeText(config, url.toString().replace(/\/$/, ""));
	} catch {
		return operatorSafeText(config, config.host);
	}
}

function identityReport(config: Config) {
	if (config.identityError) {
		return `Identity: blocked, telemetry and raw traces are off (${operatorSafeText(config, config.identityError)})`;
	}
	return config.identityMode === "pseudonymous"
		? `Identity: pseudonymous (repository identity ${config.identityKeepRepo ? "kept" : "hashed"}); reduces direct identifiers, not anonymization`
		: "Identity: raw";
}

function privacyReport(config: Config) {
	return [
		`Capture policy: ${config.capturePolicy}`,
		identityReport(config),
		`Overrides: prompt=${displayCaptureOverride(config.capturePrompt)}, system=${displayCaptureOverride(config.captureSystemPrompt)}, provider=${displayCaptureOverride(config.captureProviderInput)}, assistant=${displayCaptureOverride(config.captureAssistantOutput)}, tool-input=${displayCaptureOverride(config.captureToolInput)}, tool-output=${displayCaptureOverride(config.captureToolOutput)}, metadata=${displayCaptureOverride(config.captureMetadata)}`,
		`Budgets: string=${displayPayloadLimit(config.payloadMaxStringChars)}, tool=${displayPayloadLimit(config.payloadMaxToolChars)}, depth=${displayPayloadLimit(config.payloadMaxDepth)}, array=${displayPayloadLimit(config.payloadMaxArrayItems)}, object=${displayPayloadLimit(config.payloadMaxObjectKeys)}, nodes=${displayPayloadLimit(config.payloadMaxNodes)}`,
	].join("\n");
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
		"identity-mode": config.identityMode,
		"identity-keep-repo": config.identityKeepRepo,
		"raw-trace-enabled": config.rawTraceEnabled,
		"raw-trace-dir": config.rawTraceDir,
	};
}

function announceConfigState(settings: Partial<SettingsValues>) {
	const config = resolveConfig(settings);
	// Raw traces can run while tracing is disabled, so report this regardless.
	if (config.identityError) {
		recordRuntimeError(
			`Identity configuration blocks telemetry and raw traces: ${config.identityError}`,
		);
	}
	if (!config.enabled) return;
	if (!config.publicKey || !config.secretKey) {
		recordRuntimeError(
			"Configure Langfuse public/secret key in settings, pi-langfuse.json, or LANGFUSE_* env vars to enable tracing",
		);
	}
	for (const warning of getConfigWarnings(config)) {
		recordRuntimeError(warning);
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

async function runConnectivityTest(config: Config) {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, LANGFUSE_TEST_TIMEOUT_MS);
	try {
		const credentials = Buffer.from(
			`${config.publicKey}:${config.secretKey}`,
		).toString("base64");
		const response = await fetch(
			`${config.host.replace(/\/$/, "")}/api/public/projects?limit=1`,
			{
				headers: {
					Accept: "application/json",
					Authorization: `Basic ${credentials}`,
				},
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(`authenticated API returned HTTP ${response.status}`);
		}
		await response.body?.cancel();
		await sendIsolatedTestTrace(config, controller.signal);
	} catch (error) {
		if (timedOut) {
			throw new Error(
				`authenticated API timed out after ${LANGFUSE_TEST_TIMEOUT_MS}ms`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export default async function (pi: ExtensionAPI) {
	let settings = getStoredSettingsValues(pi);
	let lastUiContext: LangfuseUiContext | undefined;
	let commandSettingsOverrides: Partial<SettingsValues> = {};
	const sessionOwner = new SessionStateOwner<PromptState>();
	const diagnosticContexts = new Map<
		SessionState<PromptState>,
		{
			ctx: LangfuseUiContext;
			config: Config;
		}
	>();
	let detachDiagnostics: (() => void) | undefined;
	const bindDiagnostics = (ctx: LangfuseUiContext, config: Config) => {
		const state = sessionOwner.get(ctx);
		if (state) diagnosticContexts.set(state, { ctx, config });
		detachDiagnostics?.();
		let lastMessage: string | undefined;
		detachDiagnostics = subscribeRuntimeErrors((error) => {
			// Capture configuration here: resolving it inside the callback could
			// recurse if reading that configuration itself produces a diagnostic.
			const safe = operatorSafeText(config, error.message).replace(
				/\p{Cc}/gu,
				" ",
			);
			if (safe === lastMessage) return;
			lastMessage = safe;
			const message = safe.startsWith("Langfuse") ? safe : `Langfuse: ${safe}`;
			if (ctx.hasUI) {
				ctx.ui?.notify?.(message, "warning");
			} else if (ctx.hasUI === false) {
				// Print/JSON mode has no terminal renderer; keep diagnostics off stdout.
				process.stderr.write(`${message}\n`);
			}
		});
	};

	const refreshConfig = async (clearCommandOverrides = false) => {
		if (clearCommandOverrides) commandSettingsOverrides = {};
		settings = {
			...getStoredSettingsValues(pi),
			...commandSettingsOverrides,
		};
		registerSettings(pi, getLiveSettingsView(settings));
		const config = resolveConfig(settings);
		if (lastUiContext) bindDiagnostics(lastUiContext, config);
		for (const state of sessionOwner.values()) {
			await agentLifecycle.finalizePrompt(
				state,
				config,
				false,
				"config refresh",
			);
		}
		await flushClient();
		await reconfigureRuntime();
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
		getRuntime,
		telemetryText,
		redactionMetadata,
		standardUsageFromUsage,
		usageDetailsFromUsage,
		costDetailsFromUsage,
		summarizeMessages,
		summarizeProviderPayload,
		summarizeRawProviderRequestContents,
		safeJson,
		estimateJsonBytes,
		writeRawTrace,
	});

	const toolLifecycle = createToolLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		getSessionState,
		listSessionStates: () => sessionOwner.values(),
		canTrace,
		getRuntime,
		redactToolContent,
		summarizeToolArgs,
		summarizeToolResult,
		standardUsageFromUsage,
		usageDetailsFromUsage,
		costDetailsFromUsage,
		writeRawTrace,
	});

	const agentLifecycle = createAgentLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		updateStatus: (ctx, config) => {
			lastUiContext = ctx;
			bindDiagnostics(ctx, config);
			updateLangfuseStatusLine(ctx, config);
		},
		getSessionState,
		canTrace,
		ensureLocalLangfuseStarted,
		getRuntime,
		flushClient,
		writeRawTrace,
		buildTraceTags,
		telemetryText,
		getUserId,
		getRuntimeName,
		getSessionRoot,
		redactionMetadata,
		collectSourceMetadata,
		truncate,
		extractTextFromContent,
		abandonTurnGenerations: generationLifecycle.abandonTurn,
		abandonTools: toolLifecycle.abandon,
	});
	const turnLifecycle = createTurnLifecycleHandlers({
		getConfig: () => resolveConfig(settings),
		getSessionState,
		canTrace,
		getRuntime,
		telemetryText,
		redactionMetadata,
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
		void refreshConfig(true);
	});
	pi.events.on(`extension:settings:changed:${EXTENSION_ID}`, () => {
		void refreshConfig(true);
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

			commandSettingsOverrides = {
				...commandSettingsOverrides,
				enabled: nextEnabled,
			};
			setSettingsValues({ enabled: nextEnabled });
			await refreshConfig();

			const next = resolveConfig(settings);
			lastUiContext = ctx;
			updateLangfuseStatusLine(ctx, next);
			const status = next.enabled ? `enabled → ${next.host}` : "disabled";
			ctx.ui?.notify?.(`Langfuse tracing ${status}`, "info");
		},
	});

	pi.registerCommand("langfuse-status", {
		description:
			"Show safe Langfuse configuration, capture, runtime, and active-run status",
		handler: async (_args, ctx) => {
			const config = resolveConfig(settings);
			const state = getSessionState(ctx);
			const activeRun =
				Boolean(state?.promptState && !state.promptState.finalizing) ||
				!ctx.isIdle();
			const runtimeError = getLastRuntimeError();
			const lastError = runtimeError
				? `${operatorSafeText(config, runtimeError.message)} (${runtimeError.timestamp})`
				: "none";
			const report = [
				`Langfuse status: ${getLangfuseStatus(config, ctx.sessionManager.getSessionFile()).label}`,
				`config source: ${formatConfigSource(settings)}`,
				`host: ${safeHost(config)}`,
				`public key: ${maskPublicKey(config.publicKey)}`,
				`capture policy: ${config.capturePolicy}`,
				`active run: ${activeRun ? "yes" : "no"}`,
				`config path: ${getConfigFilePath()}`,
				`runtime mode: ${runtimeMode(config)}`,
				`last runtime error: ${lastError}`,
			].join("\n");
			ctx.ui.notify(report, "info");
		},
	});

	pi.registerCommand("langfuse-test", {
		description:
			"Check authenticated Langfuse connectivity and send an isolated test trace",
		handler: async (_args, ctx) => {
			const config = resolveConfig(settings);
			if (!canTrace(config)) {
				recordRuntimeError("Langfuse credentials are not configured");
				ctx.ui.notify(
					"Langfuse connectivity test failed: configure public and secret keys first",
					"error",
				);
				return;
			}
			try {
				await runConnectivityTest(config);
				ctx.ui.notify(
					"Connectivity test passed: authenticated API and isolated test trace",
					"info",
				);
			} catch (error) {
				recordRuntimeError(error);
				const safeError = operatorSafeText(config, errorMessage(error));
				ctx.ui.notify(
					`Langfuse connectivity test failed: ${safeError}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("langfuse-score", {
		description:
			"Rate this session's last finalized trace with /langfuse-score <good|bad> [comment]",
		handler: async (args, ctx) => {
			const plan = planFeedback(args, settings, () => getSessionState(ctx));
			const notice = "notice" in plan ? plan.notice : await sendFeedback(plan);
			ctx.ui.notify(notice.message, notice.level);
		},
	});

	pi.registerCommand("langfuse-privacy", {
		description:
			"Inspect or persist a Langfuse capture policy with /langfuse-privacy [policy]",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested || requested === "show") {
				ctx.ui.notify(privacyReport(resolveConfig(settings)), "info");
				return;
			}
			if (!CAPTURE_POLICIES.includes(requested as CapturePolicy)) {
				ctx.ui.notify(
					`Usage: /langfuse-privacy [${CAPTURE_POLICIES.join("|")}]`,
					"warning",
				);
				return;
			}
			commandSettingsOverrides = {
				...commandSettingsOverrides,
				"capture-policy": requested as CapturePolicy,
			};
			setSettingsValues({
				"capture-policy": requested as CapturePolicy,
			});
			try {
				await refreshConfig();
				ctx.ui.notify(`Capture policy set to ${requested}`, "info");
			} catch (error) {
				recordRuntimeError(error);
				const config = resolveConfig(settings);
				const safeError = operatorSafeText(config, errorMessage(error));
				ctx.ui.notify(`Capture policy refresh failed: ${safeError}`, "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const state = getSessionState(ctx, true);
		if (!state) return;
		lastUiContext = ctx;
		updateLangfuseStatusLine(ctx, resolveConfig(settings));
		const config = resolveConfig(settings);
		bindDiagnostics(ctx, config);
		announceConfigState(settings);
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

	pi.on("agent_settled", agentLifecycle.agentSettled);

	// pi-ask announces each dialog flow on the shared event bus. Only
	// correlation, timing, and cancellation metadata are kept.
	pi.events.on("pi-ask:started", toolLifecycle.askStarted);
	pi.events.on("pi-ask:completed", toolLifecycle.askCompleted);

	pi.on("session_compact", async (event, ctx) => {
		const state = getTypedSessionState(ctx);
		if (!state || state.promptState?.finalizing) return;
		state.compactCount += 1;
		const prompt = state.promptState;
		const compactionEntry = (
			event as { compactionEntry?: { id?: unknown; usage?: PiUsage } }
		).compactionEntry;
		if (prompt && compactionEntry?.usage) {
			// Pi reports each compaction once, but the usage belongs to the entry,
			// not the event: a repeated event for the same entry must not double it.
			const entryId =
				typeof compactionEntry.id === "string" ? compactionEntry.id : undefined;
			if (!entryId || !prompt.countedCompactions.has(entryId)) {
				if (entryId) prompt.countedCompactions.add(entryId);
				addIndirectUsage(prompt, compactionEntry.usage);
			}
		}
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
			if (diagnosticContexts.size === 0) {
				detachDiagnostics?.();
				detachDiagnostics = undefined;
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
		diagnosticContexts.delete(state);
		const surviving = [...diagnosticContexts.values()].at(-1);
		lastUiContext = surviving?.ctx;
		if (surviving) {
			bindDiagnostics(surviving.ctx, surviving.config);
		} else {
			detachDiagnostics?.();
			detachDiagnostics = undefined;
		}
	});
}
