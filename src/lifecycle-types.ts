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
	lastUsage?: PiUsage;
	activeTurns: Map<number, TurnState>;
	activeTools: Map<string, ToolState>;
	lastMessages?: Array<{ role: string; content: unknown }>;
	lastContextMessages?: Array<{ role: string; content: unknown }>;
}

export interface TurnState {
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

export interface ToolState {
	toolName: string;
	startedAt: number;
	span?: LangfuseSpan;
	argsSummary: string;
	argsRaw?: unknown;
	partialOutput?: string;
	resultOutput?: string;
	isError?: boolean;
}
