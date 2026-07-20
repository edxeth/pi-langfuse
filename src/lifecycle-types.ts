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
	lastAssistantText: string;
	startSignature: string;
	lastUsage?: PiUsage;
	failure?: LifecycleFailure;
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
