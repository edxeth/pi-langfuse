import type {
	LangfuseGeneration,
	LangfuseSpan,
	LangfuseTrace,
} from "./langfuse-client.js";

export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; total?: number };
}

export interface LifecycleFailure {
	stopReason: "error" | "aborted";
	errorMessage?: string;
}

export function getLifecycleFailure(value: {
	stopReason?: unknown;
	errorMessage?: unknown;
}): LifecycleFailure | undefined {
	if (value.stopReason !== "error" && value.stopReason !== "aborted") {
		return undefined;
	}
	return {
		stopReason: value.stopReason,
		errorMessage:
			typeof value.errorMessage === "string" ? value.errorMessage : undefined,
	};
}

/**
 * Accumulate one indirect usage report (nested tool model work or a
 * compaction summary) into the prompt totals. Callers deduplicate per
 * source identity (toolCallId, compaction entry id) before calling.
 */
export function addIndirectUsage(
	prompt: PromptState,
	usage: PiUsage | undefined,
): boolean {
	if (!usage) return false;
	prompt.indirectTokensIn +=
		(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	prompt.indirectTokensOut += usage.output ?? 0;
	prompt.indirectCacheRead += usage.cacheRead ?? 0;
	prompt.indirectCacheWrite += usage.cacheWrite ?? 0;
	prompt.indirectCost += usage.cost?.total ?? 0;
	return true;
}

export interface PromptState {
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
	/** Usage reported by tools and compactions, kept separate from direct model generations. */
	indirectTokensIn: number;
	indirectTokensOut: number;
	indirectCacheRead: number;
	indirectCacheWrite: number;
	indirectCost: number;
	countedCompactions: Set<string>;
	lastAssistantText: string;
	startSignature: string;
	lastUsage?: PiUsage;
	failure?: LifecycleFailure;
	/** Most recent failure that a later agent run of this prompt recovered from. */
	recoveredFailure?: LifecycleFailure;
	recoveredFailureCount: number;
	abandonmentReason?: string;
	activeTurns: Map<number, TurnState>;
	activeTools: Map<string, ToolState>;
	completedTurnIndexes: Set<number>;
	promptSpanStartPromise?: Promise<void>;
	promptSpanEnded?: boolean;
	finalizing?: boolean;
	finalizationPromise?: Promise<void>;
	finalizationFlushPromise?: Promise<void>;
	lastMessages?: Array<{ role: string; content: unknown }>;
	lastContextMessages?: Array<{ role: string; content: unknown }>;
	sourceMetadata?: Record<string, string>;
}

export interface TurnState {
	index: number;
	startedAt: number;
	span?: LangfuseSpan;
	spanStartPromise?: Promise<void>;
	ended?: boolean;
	messageEnded?: boolean;
	failure?: LifecycleFailure;
	generations: Map<string, GenerationState>;
	generationOrder: string[];
	nextGenerationIndex: number;
	requests?: Array<{
		timestamp: string;
		payloadSize: number;
		model: string;
	}>;
}

export interface GenerationState {
	requestKey: string;
	startedAt: number;
	generation?: LangfuseGeneration;
	startPromise?: Promise<void>;
	finishPromise?: Promise<void>;
	messageStarted?: boolean;
	ended: boolean;
	streamingText: string;
	streamingThinking: string;
	metadata: Record<string, unknown>;
	inputSnapshot?: unknown;
	requestModel?: string;
	requestFingerprint?: string;
	modelParameters?: Record<string, string | number>;
	ttftRecorded?: boolean;
}

export interface ToolState {
	toolName: string;
	startedAt: number;
	span?: LangfuseSpan;
	spanStartPromise?: Promise<void>;
	spanEnded?: boolean;
	finishPromise?: Promise<void>;
	completionSeen?: boolean;
	resultSeen?: boolean;
	executionEndSeen?: boolean;
	errorCounted?: boolean;
	usage?: PiUsage;
	usageCounted?: boolean;
	turnIndex?: number;
	parentObservationId?: string;
	argsSummary: string;
	argsRaw?: unknown;
	partialOutput?: string;
	resultOutput?: string;
	isError?: boolean;
}

export function hasToolCompletion(tool: ToolState): boolean {
	return tool.completionSeen === true || tool.resultSeen === true;
}
