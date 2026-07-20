import type {
	ExtensionContext,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Config, canTrace } from "./config.js";
import type { getClient } from "./langfuse-client.js";
import type { PiUsage, PromptState, TurnState } from "./lifecycle-types.js";
import type { redactionMetadata } from "./redaction.js";
import type { SessionContextLike, SessionState } from "./session-state.js";
import type {
	costDetailsFromUsage,
	extractTextFromContent,
	standardUsageFromUsage,
	telemetryText,
	usageDetailsFromUsage,
} from "./telemetry-helpers.js";

export interface TurnLifecycleDependencies {
	getConfig: () => Config;
	getSessionState: (
		ctx: SessionContextLike | undefined,
	) => SessionState<PromptState> | undefined;
	canTrace: typeof canTrace;
	getClient: typeof getClient;
	telemetryText: typeof telemetryText;
	redactionMetadata: typeof redactionMetadata;
	extractTextFromContent: typeof extractTextFromContent;
	standardUsageFromUsage: typeof standardUsageFromUsage;
	usageDetailsFromUsage: typeof usageDetailsFromUsage;
	costDetailsFromUsage: typeof costDetailsFromUsage;
}

export interface TurnLifecycleHandlers {
	turnStart: (event: TurnStartEvent, ctx: ExtensionContext) => Promise<void>;
	turnEnd: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<void>;
}

export function createTurnLifecycleHandlers(
	deps: TurnLifecycleDependencies,
): TurnLifecycleHandlers {
	const turnStart = async (event: TurnStartEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt) return;
		const config = deps.getConfig();
		prompt.turns += 1;
		const turnState: TurnState = {
			index: event.turnIndex,
			startedAt: Date.now(),
		};
		prompt.activeTurns.set(event.turnIndex, turnState);
		if (!deps.canTrace(config) || !prompt.trace) return;
		try {
			const lf = await deps.getClient(config);
			if (
				state.promptState !== prompt ||
				prompt.activeTurns.get(event.turnIndex) !== turnState
			)
				return;
			turnState.span = lf.span({
				name: "agent.turn",
				traceId: prompt.trace.id,
				parentObservationId: prompt.promptSpan?.id,
				metadata: {
					redaction: deps.redactionMetadata(config),
					turnIndex: event.turnIndex,
					turnNumber: prompt.turns,
					model: state.model,
					provider: state.provider,
				},
			});
		} catch (e) {
			console.warn("📊 Langfuse: Failed to create turn span", e);
		}
	};

	const turnEnd = async (event: TurnEndEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt) return;
		const config = deps.getConfig();

		const message = event.message as {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
			usage?: PiUsage;
		};
		const turnState = prompt.activeTurns.get(event.turnIndex);
		const outputText = deps.extractTextFromContent(message.content).trim();

		const usage = message.usage;
		const standardUsage = deps.standardUsageFromUsage(usage);
		const usageDetails = deps.usageDetailsFromUsage(usage);
		const costDetails = deps.costDetailsFromUsage(usage);

		if (deps.canTrace(config)) {
			turnState?.span?.end({
				output: outputText
					? deps.telemetryText(config, outputText, config.traceOutputMaxChars)
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
		prompt.activeTurns.delete(event.turnIndex);
	};

	return { turnStart, turnEnd };
}
