import type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Config, canTrace } from "./config.js";
import type { flushClient, getClient } from "./langfuse-client.js";
import {
	getLifecycleFailure,
	hasToolCompletion,
	type PromptState,
	type TurnState,
} from "./lifecycle-types.js";
import type { ensureLocalLangfuseStarted } from "./local-autostart.js";
import type { redactionMetadata } from "./redaction.js";
import type { SessionContextLike, SessionState } from "./session-state.js";
import type {
	buildTraceTags,
	extractTextFromContent,
	getRuntimeName,
	getSessionRoot,
	getUserId,
	telemetryText,
	truncate,
	writeRawTrace,
} from "./telemetry-helpers.js";

function promptStartSignature(
	event: BeforeAgentStartEvent,
	cwd: string,
	sessionFile: string,
) {
	return JSON.stringify({
		sessionFile,
		prompt: event.prompt,
		systemPrompt: event.systemPrompt || "",
		cwd,
	});
}

export interface AgentLifecycleDependencies {
	getConfig: () => Config;
	updateStatus: (ctx: ExtensionContext, config: Config) => void;
	getSessionState: (
		ctx: SessionContextLike | undefined,
		create?: boolean,
	) => SessionState<PromptState> | undefined;
	canTrace: typeof canTrace;
	ensureLocalLangfuseStarted: typeof ensureLocalLangfuseStarted;
	getClient: typeof getClient;
	flushClient: typeof flushClient;
	writeRawTrace: typeof writeRawTrace;
	buildTraceTags: typeof buildTraceTags;
	telemetryText: typeof telemetryText;
	getUserId: typeof getUserId;
	getRuntimeName: typeof getRuntimeName;
	getSessionRoot: typeof getSessionRoot;
	redactionMetadata: typeof redactionMetadata;
	truncate: typeof truncate;
	extractTextFromContent: typeof extractTextFromContent;
	abandonTurnGenerations: (turn: TurnState) => Promise<void>;
	abandonTools: (state: SessionState<PromptState>) => Promise<void>;
}

export interface AgentLifecycleHandlers {
	finalizePrompt: (
		state: SessionState<PromptState>,
		config: Config | undefined,
		flush?: boolean,
		reason?: string,
	) => Promise<void>;
	beforeAgentStart: (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	agentStart: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
}

export function createAgentLifecycleHandlers(
	deps: AgentLifecycleDependencies,
): AgentLifecycleHandlers {
	const finalizePrompt = async (
		state: SessionState<PromptState>,
		config: Config | undefined,
		flush = false,
		reason?: string,
	) => {
		const prompt = state.promptState;
		if (!prompt) return;

		if (!prompt.finalizationPromise) {
			const hadPendingWork =
				Array.from(prompt.activeTools.values()).some(
					(tool) => !hasToolCompletion(tool),
				) ||
				Array.from(prompt.activeTurns.values()).some((turn) => !turn.ended);
			const abandonmentReason =
				reason ||
				prompt.abandonmentReason ||
				(hadPendingWork ? "agent finalization" : undefined);
			const failure = prompt.failure;
			const abandoned = Boolean(abandonmentReason);
			const incomplete = abandoned || Boolean(failure);
			const failureStatus = failure
				? `agent ${failure.stopReason}${
						failure.errorMessage ? `: ${failure.errorMessage}` : ""
					}`
				: undefined;
			prompt.finalizing = true;
			prompt.finalizationPromise = (async () => {
				if (prompt.activeTools.size > 0) await deps.abandonTools(state);

				for (const [, turn] of prompt.activeTurns) {
					await deps.abandonTurnGenerations(turn);
					if (turn.spanStartPromise) await turn.spanStartPromise;
					if (turn.ended) continue;
					turn.ended = true;
					turn.span?.end({
						isError: true,
						metadata: {
							turnIndex: turn.index,
							durationMs: Date.now() - turn.startedAt,
							abandoned: true,
							abandonmentReason,
						},
						statusMessage: "turn ended during cleanup",
					});
					turn.generations.clear();
					turn.generationOrder.length = 0;
				}
				prompt.activeTurns.clear();
				prompt.completedTurnIndexes.clear();

				if (prompt.promptSpanStartPromise) {
					await prompt.promptSpanStartPromise;
				}
				if (!prompt.promptSpanEnded) {
					prompt.promptSpanEnded = true;
					prompt.promptSpan?.end({
						isError: incomplete || undefined,
						statusMessage:
							failureStatus ||
							(abandoned
								? `prompt abandoned during ${abandonmentReason}`
								: undefined),
						output: prompt.lastAssistantText || undefined,
						metadata: {
							completed: !incomplete,
							abandoned: abandoned || undefined,
							failed: Boolean(failure) || undefined,
							stopReason: failure?.stopReason,
							errorMessage: failure?.errorMessage,
							abandonmentReason,
							toolCalls: prompt.toolCalls,
							toolErrors: prompt.toolErrors,
							turns: prompt.turns,
							durationMs: Date.now() - prompt.startedAt,
							compactCount: state.compactCount,
						},
					});
				}

				prompt.trace?.update({
					output: prompt.lastAssistantText || undefined,
					userId: deps.getUserId(config),
					sessionId: state.sessionId || undefined,
					tags: deps.buildTraceTags(config, state, prompt.cwd),
					release: config?.release || undefined,
					environment: config?.environment || undefined,
					metadata: {
						redaction: config ? deps.redactionMetadata(config) : undefined,
						cwd: prompt.cwd,
						systemPrompt: config
							? deps.telemetryText(
									config,
									prompt.systemPrompt,
									config.traceInputMaxChars,
								)
							: deps.truncate(prompt.systemPrompt, 2000),
						model: state.model,
						provider: state.provider,
						sessionReason: state.sessionReason,
						runtime: deps.getRuntimeName(),
						sessionRoot: deps.getSessionRoot(state.sessionFile),
						sessionFile: state.sessionFile || undefined,
						previousSessionFile: state.previousSessionFile || undefined,
						tiaActive: process.env.TIA_ACTIVE === "1",
						tiaCommand: process.env.TIA_COMMAND || undefined,
						completed: !incomplete,
						abandoned: abandoned || undefined,
						failed: Boolean(failure) || undefined,
						stopReason: failure?.stopReason,
						errorMessage: failure?.errorMessage,
						abandonmentReason,
						turns: prompt.turns,
						toolCalls: prompt.toolCalls,
						toolErrors: prompt.toolErrors,
						tokensIn: prompt.tokensIn,
						tokensOut: prompt.tokensOut,
						cacheRead: prompt.cacheRead,
						cacheWrite: prompt.cacheWrite,
						compactCount: state.compactCount,
						durationMs: Date.now() - prompt.startedAt,
					},
				});

				if (state.promptState === prompt) state.promptState = null;
			})();
		}

		await prompt.finalizationPromise;
		if (flush) {
			prompt.finalizationFlushPromise ??= deps.flushClient();
			await prompt.finalizationFlushPromise;
		}
	};

	const beforeAgentStart = async (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => {
		const state = deps.getSessionState(ctx, true);
		if (!state) return;
		const config = deps.getConfig();
		deps.updateStatus(ctx, config);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (config.skipUnpersistedSessions && !sessionFile) return;
		if (!deps.canTrace(config) && !config.rawTraceEnabled) return;
		state.sessionFile = sessionFile || "";
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const signature = promptStartSignature(event, cwd, state.sessionFile);
		const currentPrompt = state.promptState;
		if (
			currentPrompt &&
			!currentPrompt.finalizing &&
			currentPrompt.startSignature === signature
		)
			return;

		const pendingStart = state.promptStartPromise;
		if (pendingStart) {
			if (state.promptStartSignature === signature) {
				await pendingStart;
				return;
			}
			await pendingStart;
			const promptAfterPending = state.promptState;
			if (
				promptAfterPending &&
				!promptAfterPending.finalizing &&
				promptAfterPending.startSignature === signature
			)
				return;
		}

		const promptStart = (async () => {
			await finalizePrompt(state, config, false, "prompt replaced");

			if (!state.model && ctx.model) {
				state.model = ctx.model.id || "";
				state.provider = ctx.model.provider || "";
			}

			const prompt: PromptState = {
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
				startSignature: signature,
				activeTurns: new Map(),
				activeTools: new Map(),
				completedTurnIndexes: new Set(),
			};
			state.promptState = prompt;

			deps.writeRawTrace(config, state, {
				type: "agent_prompt_start",
				cwd,
				prompt: event.prompt,
				systemPrompt: event.systemPrompt || "",
				sessionReason: state.sessionReason,
				previousSessionFile: state.previousSessionFile || undefined,
			});

			try {
				if (!deps.canTrace(config)) return;

				await deps.ensureLocalLangfuseStarted(config);
				if (state.promptState !== prompt) return;
				const lf = await deps.getClient(config);
				if (state.promptState !== prompt) return;
				const trace = lf.trace({
					name: "pi-agent",
					input: deps.telemetryText(
						config,
						event.prompt,
						config.traceInputMaxChars,
					),
					sessionId: state.sessionId || undefined,
					userId: deps.getUserId(config),
					tags: deps.buildTraceTags(config, state, cwd),
					release: config.release || undefined,
					environment: config.environment || undefined,
					metadata: {
						redaction: deps.redactionMetadata(config),
						cwd,
						systemPrompt: deps.telemetryText(
							config,
							event.systemPrompt || "",
							config.traceInputMaxChars,
						),
						model: state.model,
						provider: state.provider,
						sessionReason: state.sessionReason,
						runtime: deps.getRuntimeName(),
						sessionRoot: deps.getSessionRoot(state.sessionFile),
						sessionFile: state.sessionFile || undefined,
						previousSessionFile: state.previousSessionFile || undefined,
						tiaActive: process.env.TIA_ACTIVE === "1",
						tiaCommand: process.env.TIA_COMMAND || undefined,
					},
				});

				if (state.promptState === prompt) prompt.trace = trace;
			} catch (e) {
				console.warn("📊 Langfuse: Failed to create trace", e);
			}
		})();
		state.promptStartPromise = promptStart;
		state.promptStartSignature = signature;
		try {
			await promptStart;
		} finally {
			if (state.promptStartPromise === promptStart) {
				state.promptStartPromise = undefined;
				state.promptStartSignature = undefined;
			}
		}
	};

	const agentStart = async (_event: AgentStartEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt) return;
		const config = deps.getConfig();
		if (
			!deps.canTrace(config) ||
			!prompt.trace ||
			prompt.finalizing ||
			prompt.promptSpanEnded
		)
			return;
		const trace = prompt.trace;
		if (!trace) return;
		if (!prompt.promptSpanStartPromise) {
			prompt.promptSpanStartPromise = (async () => {
				try {
					const lf = await deps.getClient(config);
					if (
						state.promptState !== prompt ||
						prompt.finalizing ||
						prompt.promptSpanEnded ||
						prompt.promptSpan
					)
						return;
					prompt.promptSpan = lf.span({
						name: "agent.prompt",
						traceId: trace.id,
						input: deps.telemetryText(
							config,
							prompt.userPrompt,
							config.traceInputMaxChars,
						),
						metadata: {
							redaction: deps.redactionMetadata(config),
							cwd: prompt.cwd,
							model: state.model,
							provider: state.provider,
							sessionReason: state.sessionReason,
						},
					});
				} catch (e) {
					console.warn("📊 Langfuse: Failed to create prompt span", e);
				}
			})();
		}
		await prompt.promptSpanStartPromise;
	};

	const agentEnd = async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt || prompt.finalizing) return;
		const eventData = event as {
			messages?: Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
				stopReason?: unknown;
				errorMessage?: unknown;
			}>;
		};
		const messages = eventData.messages || [];
		const lastAssistant = messages
			.filter((message) => message.role === "assistant")
			.pop();
		const config = deps.getConfig();
		if (lastAssistant) {
			const output = deps.extractTextFromContent(lastAssistant.content).trim();
			if (output) {
				prompt.lastAssistantText = deps.telemetryText(
					config,
					output,
					config.traceOutputMaxChars,
				);
			}
		}
		const failure = lastAssistant
			? getLifecycleFailure(lastAssistant)
			: undefined;
		if (failure) prompt.failure = failure;
		await finalizePrompt(state, config, true);
	};

	return {
		finalizePrompt,
		beforeAgentStart,
		agentStart,
		agentEnd,
	};
}
