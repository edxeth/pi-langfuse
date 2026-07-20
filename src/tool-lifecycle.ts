import type {
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { Config, canTrace } from "./config.js";
import type { getClient, LangfuseSpan } from "./langfuse-client.js";
import {
	hasToolCompletion,
	type PromptState,
	type ToolState,
} from "./lifecycle-types.js";
import type { SessionContextLike, SessionState } from "./session-state.js";
import type {
	redactToolContent,
	summarizeToolArgs,
	summarizeToolResult,
	writeRawTrace,
} from "./telemetry-helpers.js";

export interface ToolLifecycleDependencies {
	getConfig: () => Config;
	getSessionState: (
		ctx: SessionContextLike | undefined,
	) => SessionState<PromptState> | undefined;
	canTrace: typeof canTrace;
	getClient: typeof getClient;
	redactToolContent: typeof redactToolContent;
	summarizeToolArgs: typeof summarizeToolArgs;
	summarizeToolResult: typeof summarizeToolResult;
	writeRawTrace: typeof writeRawTrace;
}

interface ToolExecutionStartEvent {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface ToolExecutionUpdateEvent {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

interface ToolExecutionEndEvent {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export interface ToolLifecycleHandlers {
	toolCall: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<void>;
	toolExecutionStart: (
		event: ToolExecutionStartEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	toolExecutionUpdate: (
		event: ToolExecutionUpdateEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	toolResult: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>;
	toolExecutionEnd: (
		event: ToolExecutionEndEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	abandon: (state: SessionState<PromptState>) => Promise<void>;
}

type ToolEndBody = Parameters<LangfuseSpan["end"]>[0];

function getLatestTurn(prompt: PromptState) {
	return Array.from(prompt.activeTurns.values()).at(-1);
}

function getToolTurn(prompt: PromptState, tool: ToolState) {
	return tool.turnIndex === undefined
		? getLatestTurn(prompt)
		: prompt.activeTurns.get(tool.turnIndex);
}

function createToolState(
	prompt: PromptState,
	toolCallId: string,
	toolName: string,
	args: unknown,
	config: Config,
	summarizeArgs: typeof summarizeToolArgs,
): ToolState {
	const turn = getLatestTurn(prompt);
	const tool: ToolState = {
		toolName,
		startedAt: Date.now(),
		argsSummary: summarizeArgs(config, toolName, args),
		argsRaw: args,
		turnIndex: turn?.index,
		parentObservationId: turn?.span?.id || prompt.promptSpan?.id,
	};
	prompt.toolCalls += 1;
	prompt.activeTools.set(toolCallId, tool);
	return tool;
}

function getOrCreateToolState(
	prompt: PromptState,
	toolCallId: string,
	toolName: string,
	args: unknown,
	config: Config,
	summarizeArgs: typeof summarizeToolArgs,
) {
	const existing = prompt.activeTools.get(toolCallId);
	if (existing) return existing;
	return createToolState(
		prompt,
		toolCallId,
		toolName,
		args,
		config,
		summarizeArgs,
	);
}

function updateToolArguments(
	tool: ToolState,
	config: Config,
	toolName: string,
	args: unknown,
	summarizeArgs: typeof summarizeToolArgs,
) {
	tool.toolName = toolName;
	tool.argsRaw = args;
	tool.argsSummary = summarizeArgs(config, toolName, args);
}

export function createToolLifecycleHandlers(
	deps: ToolLifecycleDependencies,
): ToolLifecycleHandlers {
	const getSessionPrompt = (ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt || prompt.finalizing) return undefined;
		return { state, prompt };
	};

	const ensureToolSpan = async (
		state: SessionState<PromptState>,
		prompt: PromptState,
		toolCallId: string,
		tool: ToolState,
		config: Config,
	) => {
		const trace = prompt.trace;
		if (!deps.canTrace(config) || !trace || tool.span || tool.spanEnded) return;
		if (!tool.spanStartPromise) {
			tool.spanStartPromise = (async () => {
				try {
					const lf = await deps.getClient(config);
					if (
						state.promptState !== prompt ||
						prompt.activeTools.get(toolCallId) !== tool ||
						tool.spanEnded ||
						tool.span
					)
						return;
					const turn = getToolTurn(prompt, tool);
					tool.span = lf.span({
						name: `tool:${tool.toolName}`,
						traceId: trace.id,
						parentObservationId:
							tool.parentObservationId ||
							turn?.span?.id ||
							prompt.promptSpan?.id,
						input: tool.argsSummary,
						metadata: {
							tool: tool.toolName,
							toolCallId,
							argsSummary: tool.argsSummary,
							turnIndex: tool.turnIndex,
						},
					});
				} catch (error) {
					console.warn("📊 Langfuse: Failed to create tool span", error);
				}
			})();
		}
		await tool.spanStartPromise;
	};

	const finishTool = async (
		state: SessionState<PromptState>,
		prompt: PromptState,
		toolCallId: string,
		tool: ToolState,
		config: Config,
		body: ToolEndBody,
	) => {
		if (tool.spanEnded) return;
		await ensureToolSpan(state, prompt, toolCallId, tool, config);
		if (tool.spanEnded) return;
		tool.spanEnded = true;
		try {
			tool.span?.end(body);
		} catch (error) {
			console.warn("📊 Langfuse: Failed to end tool span", error);
		}
	};

	const completeTool = (
		state: SessionState<PromptState>,
		prompt: PromptState,
		toolCallId: string,
		tool: ToolState,
		config: Config,
		body: ToolEndBody,
	) => {
		if (tool.completionSeen) return tool.finishPromise;
		tool.completionSeen = true;
		tool.finishPromise = finishTool(
			state,
			prompt,
			toolCallId,
			tool,
			config,
			body,
		);
		return tool.finishPromise;
	};

	const endBody = (
		tool: ToolState,
		isError: boolean,
		output: string | undefined,
	): ToolEndBody => ({
		isError,
		output: output || undefined,
		statusMessage: isError ? "tool execution failed" : undefined,
		metadata: {
			tool: tool.toolName,
			argsSummary: tool.argsSummary,
			durationMs: Date.now() - tool.startedAt,
		},
	});

	const toolCall = async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const resolved = getSessionPrompt(ctx);
		if (!resolved) return;
		const { state, prompt } = resolved;
		const config = deps.getConfig();
		const tool = getOrCreateToolState(
			prompt,
			event.toolCallId,
			event.toolName,
			event.input,
			config,
			deps.summarizeToolArgs,
		);
		updateToolArguments(
			tool,
			config,
			event.toolName,
			event.input,
			deps.summarizeToolArgs,
		);
		deps.writeRawTrace(config, state, {
			type: "tool_call",
			turnIndex: tool.turnIndex,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
		});
		await ensureToolSpan(state, prompt, event.toolCallId, tool, config);
		if (tool.span && !tool.spanEnded) {
			tool.span.update?.({
				input: tool.argsSummary,
				metadata: {
					tool: event.toolName,
					argsSummary: tool.argsSummary,
				},
			});
		}
	};

	const toolExecutionStart = async (
		event: ToolExecutionStartEvent,
		ctx: ExtensionContext,
	) => {
		const resolved = getSessionPrompt(ctx);
		if (!resolved) return;
		const { state, prompt } = resolved;
		const config = deps.getConfig();
		const tool = getOrCreateToolState(
			prompt,
			event.toolCallId,
			event.toolName,
			event.args,
			config,
			deps.summarizeToolArgs,
		);
		updateToolArguments(
			tool,
			config,
			event.toolName,
			event.args,
			deps.summarizeToolArgs,
		);
		deps.writeRawTrace(config, state, {
			type: "tool_execution_start",
			turnIndex: tool.turnIndex,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
		await ensureToolSpan(state, prompt, event.toolCallId, tool, config);
	};

	const toolExecutionUpdate = async (
		event: ToolExecutionUpdateEvent,
		ctx: ExtensionContext,
	) => {
		const resolved = getSessionPrompt(ctx);
		if (!resolved) return;
		const { state, prompt } = resolved;
		const config = deps.getConfig();
		if (!config.captureToolProgress) return;
		const tool = getOrCreateToolState(
			prompt,
			event.toolCallId,
			event.toolName,
			event.args,
			config,
			deps.summarizeToolArgs,
		);
		tool.partialOutput = deps.summarizeToolResult(config, event.partialResult);
		await ensureToolSpan(state, prompt, event.toolCallId, tool, config);
		if (!tool.span || tool.spanEnded) return;
		tool.span.update?.({
			output: tool.partialOutput,
			metadata: {
				partial: true,
				tool: tool.toolName,
			},
		});
	};

	const toolResult = async (event: ToolResultEvent, ctx: ExtensionContext) => {
		const resolved = getSessionPrompt(ctx);
		if (!resolved) return;
		const { state, prompt } = resolved;
		const config = deps.getConfig();
		const tool = getOrCreateToolState(
			prompt,
			event.toolCallId,
			event.toolName,
			event.input,
			config,
			deps.summarizeToolArgs,
		);
		tool.resultOutput = deps.summarizeToolResult(config, {
			content: event.content,
		});
		tool.isError = event.isError;
		if (!tool.resultSeen) {
			tool.resultSeen = true;
			const imgCount = (event.content ?? []).filter(
				(content: { type: string }) =>
					content.type === "image" || content.type === "image_url",
			).length;
			deps.writeRawTrace(config, state, {
				type: "tool_result_first_seen",
				turnIndex: tool.turnIndex,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputSummary: deps.summarizeToolArgs(
					config,
					event.toolName,
					event.input,
				),
				contentSummary: deps.redactToolContent(config, {
					content: event.content,
				}),
				contentTruncated: false,
				imgBlocks: imgCount || undefined,
				isError: event.isError,
			});
		}
	};

	const toolExecutionEnd = async (
		event: ToolExecutionEndEvent,
		ctx: ExtensionContext,
	) => {
		const resolved = getSessionPrompt(ctx);
		if (!resolved) return;
		const { state, prompt } = resolved;
		const config = deps.getConfig();
		const tool = getOrCreateToolState(
			prompt,
			event.toolCallId,
			event.toolName,
			undefined,
			config,
			deps.summarizeToolArgs,
		);
		if (tool.executionEndSeen) return;
		tool.executionEndSeen = true;
		tool.isError = event.isError;
		if (event.isError && !tool.errorCounted) {
			tool.errorCounted = true;
			prompt.toolErrors += 1;
		}
		const durationMs = Date.now() - tool.startedAt;
		deps.writeRawTrace(config, state, {
			type: "tool_execution_end",
			turnIndex: tool.turnIndex,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			argsSummary: tool.argsSummary,
			resultSummary: deps.redactToolContent(config, event.result),
			resultTruncated: false,
			isError: event.isError,
			durationMs,
		});
		const finalOutput = deps.summarizeToolResult(config, event.result);
		if (finalOutput) tool.resultOutput = finalOutput;
		await completeTool(
			state,
			prompt,
			event.toolCallId,
			tool,
			config,
			endBody(tool, event.isError, tool.resultOutput || tool.partialOutput),
		);
	};

	const abandon = async (state: SessionState<PromptState>) => {
		const prompt = state.promptState;
		if (!prompt) return;
		for (const [toolCallId, tool] of prompt.activeTools) {
			if (tool.finishPromise) {
				await tool.finishPromise;
				continue;
			}
			if (tool.completionSeen) continue;
			const config = deps.getConfig();
			const isResultOnly = hasToolCompletion(tool);
			const isError = isResultOnly
				? (tool.isError ?? false)
				: (tool.isError ?? true);
			if (isResultOnly && isError && !tool.errorCounted) {
				tool.errorCounted = true;
				prompt.toolErrors += 1;
			}
			tool.completionSeen = true;
			tool.finishPromise = finishTool(
				state,
				prompt,
				toolCallId,
				tool,
				config,
				isResultOnly
					? endBody(tool, isError, tool.resultOutput || tool.partialOutput)
					: {
							isError,
							output: tool.resultOutput || tool.partialOutput,
							statusMessage: tool.isError
								? "tool error"
								: "tool ended without completion event",
							metadata: {
								tool: tool.toolName,
								argsSummary: tool.argsSummary,
								durationMs: Date.now() - tool.startedAt,
								abandoned: true,
							},
						},
			);
			await tool.finishPromise;
		}
		prompt.activeTools.clear();
	};

	return {
		toolCall,
		toolExecutionStart,
		toolExecutionUpdate,
		toolResult,
		toolExecutionEnd,
		abandon,
	};
}
