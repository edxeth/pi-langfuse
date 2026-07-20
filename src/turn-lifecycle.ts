import type {
	ExtensionContext,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Config, canTrace } from "./config.js";
import type { getRuntime } from "./langfuse-client.js";
import {
	getLifecycleFailure,
	type PiUsage,
	type PromptState,
	type TurnState,
} from "./lifecycle-types.js";
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
	getRuntime: typeof getRuntime;
	telemetryText: typeof telemetryText;
	redactionMetadata: typeof redactionMetadata;
	extractTextFromContent: typeof extractTextFromContent;
	standardUsageFromUsage: typeof standardUsageFromUsage;
	usageDetailsFromUsage: typeof usageDetailsFromUsage;
	costDetailsFromUsage: typeof costDetailsFromUsage;
	abandonTurnGenerations: (turn: TurnState) => Promise<void>;
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
		if (
			!state ||
			!prompt ||
			prompt.finalizing ||
			prompt.completedTurnIndexes.has(event.turnIndex) ||
			prompt.activeTurns.has(event.turnIndex)
		)
			return;
		const config = deps.getConfig();
		prompt.turns += 1;
		const turnState: TurnState = {
			index: event.turnIndex,
			startedAt: Date.now(),
			ended: false,
			generations: new Map(),
			generationOrder: [],
			nextGenerationIndex: 0,
		};
		prompt.activeTurns.set(event.turnIndex, turnState);
		if (!deps.canTrace(config) || !prompt.trace) return;
		const trace = prompt.trace;
		turnState.spanStartPromise = (async () => {
			try {
				const lf = await deps.getRuntime(config);
				if (
					state.promptState !== prompt ||
					prompt.finalizing ||
					prompt.activeTurns.get(event.turnIndex) !== turnState ||
					turnState.ended
				)
					return;
				turnState.span = lf.span({
					name: "agent.turn",
					traceId: trace.id,
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
		})();
		await turnState.spanStartPromise;
	};

	const turnEnd = async (event: TurnEndEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt || prompt.finalizing) return;
		const turnState = prompt.activeTurns.get(event.turnIndex);
		if (!turnState) {
			prompt.completedTurnIndexes.add(event.turnIndex);
			return;
		}
		if (turnState.ended) return;
		turnState.ended = true;
		prompt.completedTurnIndexes.add(event.turnIndex);
		const message = event.message as {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
			usage?: PiUsage;
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		const failure = getLifecycleFailure(message) || turnState.failure;
		if (failure) {
			turnState.failure = failure;
			prompt.failure ??= failure;
		}
		const unfinishedGenerations = Array.from(
			turnState.generations.values(),
		).some((generation) => !generation.ended);
		const needsGenerationAbandonment = Array.from(
			turnState.generations.values(),
		).some((generation) => !generation.ended && !generation.finishPromise);
		if (unfinishedGenerations) {
			if (needsGenerationAbandonment) {
				prompt.abandonmentReason ??= "turn ended before generation completion";
			}
			await deps.abandonTurnGenerations(turnState);
		}
		if (turnState.spanStartPromise) await turnState.spanStartPromise;
		const config = deps.getConfig();
		const outputText = deps.extractTextFromContent(message.content).trim();

		const usage = message.usage;
		const standardUsage = deps.standardUsageFromUsage(usage);
		const usageDetails = deps.usageDetailsFromUsage(usage);
		const costDetails = deps.costDetailsFromUsage(usage);

		if (deps.canTrace(config)) {
			turnState.span?.end({
				output: outputText
					? deps.telemetryText(config, outputText, config.traceOutputMaxChars)
					: undefined,
				usage: standardUsage,
				usageDetails,
				costDetails,
				isError: failure ? true : undefined,
				statusMessage: failure
					? failure.errorMessage || `agent turn ${failure.stopReason}`
					: undefined,
				metadata: {
					turnIndex: event.turnIndex,
					durationMs: Date.now() - turnState.startedAt,
					toolResults: event.toolResults?.length ?? 0,
					stopReason: failure?.stopReason,
					errorMessage: failure?.errorMessage,
				},
			});
		}
		turnState.generations.clear();
		turnState.generationOrder.length = 0;
		if (prompt.activeTurns.get(event.turnIndex) === turnState) {
			prompt.activeTurns.delete(event.turnIndex);
		}
	};

	return { turnStart, turnEnd };
}
