import type {
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type AskFlowState,
	describeAskFlow,
	parseCancelReason,
	summarizeAskWait,
} from "./ask-wait.js";
import type { Config, canTrace } from "./config.js";
import type { getRuntime, LangfuseSpan } from "./langfuse-client.js";
import {
	addIndirectUsage,
	hasToolCompletion,
	type PiUsage,
	type PromptState,
	type ToolState,
} from "./lifecycle-types.js";
import { recordRuntimeError } from "./runtime-diagnostics.js";
import type { SessionContextLike, SessionState } from "./session-state.js";
import type {
	costDetailsFromUsage,
	redactToolContent,
	standardUsageFromUsage,
	summarizeToolArgs,
	summarizeToolResult,
	usageDetailsFromUsage,
	writeRawTrace,
} from "./telemetry-helpers.js";

export interface ToolLifecycleDependencies {
	getConfig: () => Config;
	getSessionState: (
		ctx: SessionContextLike | undefined,
	) => SessionState<PromptState> | undefined;
	/** Every live session, for pi-ask events that carry no session context. */
	listSessionStates: () => SessionState<PromptState>[];
	canTrace: typeof canTrace;
	getRuntime: typeof getRuntime;
	redactToolContent: typeof redactToolContent;
	summarizeToolArgs: typeof summarizeToolArgs;
	summarizeToolResult: typeof summarizeToolResult;
	standardUsageFromUsage: typeof standardUsageFromUsage;
	usageDetailsFromUsage: typeof usageDetailsFromUsage;
	costDetailsFromUsage: typeof costDetailsFromUsage;
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
	/** Handles `pi-ask:started`; the payload is untrusted event-bus data. */
	askStarted: (event: unknown) => void;
	/** Handles `pi-ask:completed`; the payload is untrusted event-bus data. */
	askCompleted: (event: unknown) => void;
}

/** Tools whose attempted calls count toward `edit_write_call_count`. */
const EDIT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write"]);

type ToolEndBody = Parameters<LangfuseSpan["end"]>[0];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Nested model work inside a tool arrives as `usage` on the executed result. */
function usageFromToolResult(result: unknown): PiUsage | undefined {
	const usage = asRecord(result)?.usage;
	if (!usage || Array.isArray(usage)) return undefined;
	return usage as PiUsage;
}

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
	// One count per toolCallId: this runs only when the id is first seen, so
	// failed or blocked attempts count and repeated events do not.
	if (EDIT_WRITE_TOOL_NAMES.has(toolName)) prompt.editWriteCalls += 1;
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

/**
 * pi-ask events carry no session context, only a flow id and, for tool
 * flows, the owning tool call id. Flow ids are `tool:${toolCallId}`, so they
 * are unique only while one live prompt holds that tool call. Every live
 * prompt that already holds the flow, was already marked ambiguous for it,
 * or has the tool call active is a candidate; the flow belongs to a prompt
 * only when it is the single candidate and no earlier collision was seen.
 * Otherwise the flow is marked ambiguous on each candidate without timing,
 * even if one of them held it uniquely before a colliding call started. It
 * is never assigned to the latest active tool or session.
 */
function resolveAskFlowOwner(
	states: SessionState<PromptState>[],
	flowId: string,
	toolCallId: string | undefined,
): PromptState | undefined {
	const prompts = livePrompts(states);
	const holders = prompts.filter((prompt) => prompt.askFlows.has(flowId));
	const ambiguousBefore = prompts.filter((prompt) =>
		prompt.ambiguousAskFlowIds.has(flowId),
	);
	const byTool = toolCallId
		? prompts.filter((prompt) => prompt.activeTools.has(toolCallId))
		: [];
	const candidates = [...new Set([...holders, ...ambiguousBefore, ...byTool])];
	if (candidates.length === 1 && ambiguousBefore.length === 0) {
		return candidates[0];
	}
	for (const prompt of candidates) prompt.ambiguousAskFlowIds.add(flowId);
	return undefined;
}

function livePrompts(states: SessionState<PromptState>[]): PromptState[] {
	return states.flatMap(({ promptState }) =>
		promptState && !promptState.finalizing ? [promptState] : [],
	);
}

interface AskEvent {
	flowId: string;
	/** Set only for tool flows. */
	toolCallId: string | undefined;
	raw: Record<string, unknown>;
}

/** A version 1 pi-ask event with a flow id; anything else is not ours to record. */
function parseAskEvent(data: unknown): AskEvent | undefined {
	const event = asRecord(data);
	const flowId = event?.flowId;
	if (event?.version !== 1 || typeof flowId !== "string" || !flowId) {
		return undefined;
	}
	const toolCallId =
		typeof event.toolCallId === "string" && event.toolCallId
			? event.toolCallId
			: undefined;
	return { flowId, toolCallId, raw: event };
}

/**
 * The flow already recorded for the event, or a new one for a tool flow.
 * An owner that does not hold the flow yet was matched through its active
 * tool call, so `toolCallId` is set in that case.
 */
function ownedAskFlow(prompt: PromptState, ask: AskEvent): AskFlowState {
	return (
		prompt.askFlows.get(ask.flowId) ?? {
			flowId: ask.flowId,
			// SAFETY: see above; a prompt without the flow is a candidate only via byTool.
			toolCallId: ask.toolCallId as string,
		}
	);
}

/** An absent or non-finite timestamp stays unknown; receipt time is never substituted. */
function eventTime(value: unknown) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function recordAskSource(flow: AskFlowState, event: Record<string, unknown>) {
	if (typeof event.source === "string") flow.source ??= event.source;
}

// The first valid timestamp of each kind wins, so repeated deliveries and
// reordered started/completed events never change a recorded boundary. A
// flow whose events carry no valid timestamp stays incomplete.
function applyAskStarted(flow: AskFlowState, event: Record<string, unknown>) {
	flow.startedAt ??= eventTime(event.createdAt);
	recordAskSource(flow, event);
}

function applyAskCompleted(flow: AskFlowState, event: Record<string, unknown>) {
	flow.completedAt ??= eventTime(event.completedAt);
	recordAskSource(flow, event);
	if (flow.cancelled !== undefined) return;
	const result = asRecord(event.result);
	flow.cancelled = result?.cancelled === true;
	flow.cancelReason = flow.cancelled
		? parseCancelReason(result?.cancelReason)
		: undefined;
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
					const lf = await deps.getRuntime(config);
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
					recordRuntimeError("Failed to create tool span", error);
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
		// Runs once per tool: `completionSeen` gates every caller, so the span
		// cannot have ended before this point.
		await ensureToolSpan(state, prompt, toolCallId, tool, config);
		tool.spanEnded = true;
		try {
			tool.span?.end(body);
		} catch (error) {
			recordRuntimeError("Failed to end tool span", error);
		}
		if (body?.isError && tool.span && prompt.trace?.id) {
			try {
				const lf = await deps.getRuntime(config);
				lf.score({
					name: "tool_is_error",
					value: 1,
					dataType: "BOOLEAN",
					traceId: prompt.trace.id,
					observationId: tool.span.id,
				});
			} catch (error) {
				recordRuntimeError("Failed to send tool error score", error);
			}
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

	/** Dialog timing of the pi-ask flows this tool owns; undefined when none were seen. */
	const askWaitMetadata = (prompt: PromptState, toolCallId: string) => {
		const flows = [...prompt.askFlows.values()].filter(
			(flow) => flow.toolCallId === toolCallId,
		);
		const summary = summarizeAskWait(flows);
		return summary
			? { ...summary, flows: flows.map(describeAskFlow) }
			: undefined;
	};

	/** The latest progress output, summarized once, when it is needed. */
	const partialOutputOf = (config: Config, tool: ToolState) =>
		tool.partialResult
			? deps.summarizeToolResult(config, tool.partialResult.value) || undefined
			: undefined;

	/** The final result, or the latest progress output when there is none. */
	const completedOutput = (config: Config, tool: ToolState) => {
		if (tool.resultOutput) return { output: tool.resultOutput, partial: false };
		const output = partialOutputOf(config, tool);
		return { output, partial: output !== undefined };
	};

	const endBody = (
		prompt: PromptState,
		toolCallId: string,
		tool: ToolState,
		isError: boolean,
		{ output, partial }: { output: string | undefined; partial: boolean },
	): ToolEndBody => ({
		isError,
		output: output || undefined,
		statusMessage: isError ? "tool execution failed" : undefined,
		usage: deps.standardUsageFromUsage(tool.usage),
		usageDetails: deps.usageDetailsFromUsage(tool.usage),
		costDetails: deps.costDetailsFromUsage(tool.usage),
		metadata: {
			tool: tool.toolName,
			argsSummary: tool.argsSummary,
			durationMs: Date.now() - tool.startedAt,
			askUserWait: askWaitMetadata(prompt, toolCallId),
			...(partial ? { partial: true } : {}),
		},
	});

	/** Count a tool's nested-model usage exactly once per toolCallId. */
	const countToolUsage = (prompt: PromptState, tool: ToolState) => {
		if (!tool.usage || tool.usageCounted) return;
		tool.usageCounted = true;
		addIndirectUsage(prompt, tool.usage);
	};

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
		// A span is exported once, when it ends, so a progress update never
		// reaches Langfuse by itself. Keep only the latest result; it becomes
		// the output if the tool ends without a final result.
		if (!tool.spanEnded) tool.partialResult = { value: event.partialResult };
		await ensureToolSpan(state, prompt, event.toolCallId, tool, config);
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
		tool.usage ??= event.usage;
		countToolUsage(prompt, tool);
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
		tool.usage ??= usageFromToolResult(event.result);
		countToolUsage(prompt, tool);
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
			endBody(
				prompt,
				event.toolCallId,
				tool,
				event.isError,
				completedOutput(config, tool),
			),
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
			countToolUsage(prompt, tool);
			tool.completionSeen = true;
			// A tool with a result is handled first, so only partial output exists otherwise.
			const partialOutput = isResultOnly
				? undefined
				: partialOutputOf(config, tool);
			tool.finishPromise = finishTool(
				state,
				prompt,
				toolCallId,
				tool,
				config,
				isResultOnly
					? endBody(
							prompt,
							toolCallId,
							tool,
							isError,
							completedOutput(config, tool),
						)
					: {
							isError,
							output: partialOutput,
							statusMessage: tool.isError
								? "tool error"
								: "tool ended without completion event",
							metadata: {
								tool: tool.toolName,
								argsSummary: tool.argsSummary,
								durationMs: Date.now() - tool.startedAt,
								abandoned: true,
								askUserWait: askWaitMetadata(prompt, toolCallId),
								...(partialOutput !== undefined ? { partial: true } : {}),
							},
						},
			);
			await tool.finishPromise;
		}
		prompt.activeTools.clear();
	};

	const resolveAskOwner = (flowId: string, toolCallId: string | undefined) =>
		resolveAskFlowOwner(deps.listSessionStates(), flowId, toolCallId);

	const recordAskEvent = (
		data: unknown,
		apply: (flow: AskFlowState, event: Record<string, unknown>) => void,
	) => {
		const ask = parseAskEvent(data);
		if (!ask) return;
		const prompt = resolveAskOwner(ask.flowId, ask.toolCallId);
		if (!prompt) return;
		const flow = ownedAskFlow(prompt, ask);
		apply(flow, ask.raw);
		prompt.askFlows.set(ask.flowId, flow);
	};

	const askStarted = (data: unknown) => recordAskEvent(data, applyAskStarted);

	const askCompleted = (data: unknown) =>
		recordAskEvent(data, applyAskCompleted);

	return {
		toolCall,
		toolExecutionStart,
		toolExecutionUpdate,
		toolResult,
		toolExecutionEnd,
		abandon,
		askStarted,
		askCompleted,
	};
}
