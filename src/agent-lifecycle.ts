import type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Config, canTrace } from "./config.js";
import type { flushClient, getClient } from "./langfuse-client.js";
import type { PromptState, TurnState } from "./lifecycle-types.js";
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
	) => {
		const prompt = state.promptState;
		if (!prompt) return;

		if (prompt.activeTools.size > 0) await deps.abandonTools(state);

		for (const [, turn] of prompt.activeTurns) {
			await deps.abandonTurnGenerations(turn);
			turn.span?.end({
				metadata: {
					turnIndex: turn.index,
					durationMs: Date.now() - turn.startedAt,
					abandoned: true,
				},
				statusMessage: "turn ended during cleanup",
			});
		}
		prompt.activeTurns.clear();

		prompt.promptSpan?.end({
			output: prompt.lastAssistantText || undefined,
			metadata: {
				completed: true,
				toolCalls: prompt.toolCalls,
				toolErrors: prompt.toolErrors,
				turns: prompt.turns,
				durationMs: Date.now() - prompt.startedAt,
				compactCount: state.compactCount,
			},
		});

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
				completed: true,
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

		if (flush) {
			await deps.flushClient();
		}
		if (state.promptState === prompt) state.promptState = null;
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

		await finalizePrompt(state, config);

		const cwd = event.systemPromptOptions?.cwd || process.cwd();

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
			activeTurns: new Map(),
			activeTools: new Map(),
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
	};

	const agentStart = async (_event: AgentStartEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt) return;
		const config = deps.getConfig();
		if (!deps.canTrace(config) || !prompt.trace) return;
		try {
			const lf = await deps.getClient(config);
			if (state.promptState !== prompt) return;
			prompt.promptSpan = lf.span({
				name: "agent.prompt",
				traceId: prompt.trace.id,
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
	};

	const agentEnd = async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt) return;
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
		await finalizePrompt(state, config, true);
	};

	return {
		finalizePrompt,
		beforeAgentStart,
		agentStart,
		agentEnd,
	};
}
