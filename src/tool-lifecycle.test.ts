import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
	hasToolCompletion,
	type PromptState,
	type ToolState,
	type TurnState,
} from "./lifecycle-types.js";
import { getLastRuntimeError } from "./runtime-diagnostics.js";
import type { SessionState } from "./session-state.js";
import {
	createToolLifecycleHandlers,
	type ToolLifecycleDependencies,
} from "./tool-lifecycle.js";

/**
 * The tool handlers take every collaborator as a dependency, so these tests
 * drive them with small faithful fakes: a runtime whose spans record their
 * updates and end, and prompt state with the fields the tool code reads.
 */
const CONFIG = { captureToolProgress: true } as Config;

function makePrompt(overrides: Partial<PromptState> = {}) {
	return {
		activeTools: new Map<string, ToolState>(),
		activeTurns: new Map<number, TurnState>(),
		askFlows: new Map(),
		ambiguousAskFlowIds: new Set<string>(),
		finalizing: false,
		toolCalls: 0,
		toolErrors: 0,
		editWriteCalls: 0,
		indirectTokensIn: 0,
		indirectTokensOut: 0,
		indirectCacheRead: 0,
		indirectCacheWrite: 0,
		indirectCost: 0,
		trace: { id: "trace-1" },
		promptSpan: { id: "prompt-span" },
		...overrides,
	} as unknown as PromptState;
}

function makeSession(prompt: PromptState | undefined) {
	return { promptState: prompt } as unknown as SessionState<PromptState>;
}

function makeSpan(id = "tool-span") {
	return { id, traceId: "tool-trace", update: vi.fn(), end: vi.fn() };
}

interface SetupOptions {
	prompt?: PromptState | undefined;
	config?: Partial<Config>;
	canTrace?: boolean;
	span?: ReturnType<typeof makeSpan>;
	getRuntime?: () => Promise<unknown>;
	score?: () => void;
	redactToolContent?: (config: Config, value: unknown) => unknown;
	summarizeToolResult?: (config: Config, result: unknown) => string;
}

function setup(options: SetupOptions = {}) {
	const prompt = "prompt" in options ? options.prompt : makePrompt();
	const session = makeSession(prompt);
	const span = options.span ?? makeSpan();
	const lf = {
		span: vi.fn(() => span),
		score: vi.fn(options.score ?? (() => undefined)),
	};
	const rawRecords: Array<Record<string, unknown>> = [];
	const deps = {
		getConfig: () => ({ ...CONFIG, ...options.config }),
		getSessionState: () => session,
		listSessionStates: () => [session],
		canTrace: () => options.canTrace ?? true,
		getRuntime: options.getRuntime ?? (async () => lf),
		redactToolContent:
			options.redactToolContent ?? ((_config: Config, value: unknown) => value),
		summarizeToolArgs: (_config: Config, name: string, args: unknown) =>
			`${name}(${JSON.stringify(args)})`,
		summarizeToolResult:
			options.summarizeToolResult ??
			((_config: Config, result: unknown) =>
				result === null ||
				(result as { content?: Array<{ type?: string }> })?.content?.[0]
					?.type === "empty"
					? ""
					: JSON.stringify(result)),
		standardUsageFromUsage: () => undefined,
		usageDetailsFromUsage: () => undefined,
		costDetailsFromUsage: () => undefined,
		writeRawTrace: (
			_config: Config,
			_state: unknown,
			record: Record<string, unknown>,
		) => rawRecords.push(record),
	} as unknown as ToolLifecycleDependencies;
	const handlers = createToolLifecycleHandlers(deps);
	return { prompt, session, span, lf, rawRecords, handlers, ctx: {} as never };
}

const call = (id: string, name = "bash", input: unknown = { cmd: "ls" }) =>
	({ toolCallId: id, toolName: name, input }) as never;
const execStart = (id: string, name = "bash", args: unknown = { cmd: "ls" }) =>
	({ toolCallId: id, toolName: name, args }) as never;
const execEnd = (id: string, isError = false, result: unknown = { ok: true }) =>
	({ toolCallId: id, toolName: "bash", result, isError }) as never;

describe("tool span creation", () => {
	function turnWith(index: number, spanId: string | undefined) {
		return {
			index,
			span: spanId ? { id: spanId } : undefined,
		} as unknown as TurnState;
	}

	it("opens a span under the turn span that was current when the tool began", async () => {
		const prompt = makePrompt({
			activeTurns: new Map([[0, turnWith(0, "turn-span")]]),
		});
		const { lf, handlers, ctx } = setup({ prompt });

		await handlers.toolCall(call("a"), ctx);

		expect(lf.span).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "tool:bash",
				traceId: "trace-1",
				parentObservationId: "turn-span",
				metadata: expect.objectContaining({ toolCallId: "a", turnIndex: 0 }),
			}),
		);
		expect(prompt?.toolCalls).toBe(1);
	});

	it("falls back to the prompt span when the turn has no span", async () => {
		const prompt = makePrompt({
			activeTurns: new Map([[0, turnWith(0, undefined)]]),
		});
		const { lf, handlers, ctx } = setup({ prompt });

		await handlers.toolCall(call("a"), ctx);

		expect(lf.span).toHaveBeenCalledWith(
			expect.objectContaining({ parentObservationId: "prompt-span" }),
		);
	});

	it("has no parent when neither a turn span nor a prompt span exists", async () => {
		const prompt = makePrompt({ promptSpan: undefined });
		const { lf, handlers, ctx } = setup({ prompt });

		await handlers.toolCall(call("a"), ctx);

		expect(lf.span).toHaveBeenCalledWith(
			expect.objectContaining({ parentObservationId: undefined }),
		);
	});

	it("uses the turn span that appeared while the runtime was starting", async () => {
		const prompt = makePrompt({ promptSpan: undefined });
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const span = makeSpan();
		const lf = { span: vi.fn(() => span), score: vi.fn() };
		const { handlers, ctx } = setup({
			prompt,
			getRuntime: async () => {
				await gate;
				return lf;
			},
		});

		const starting = handlers.toolCall(call("a"), ctx);
		prompt?.activeTurns.set(0, turnWith(0, "late-turn-span"));
		const tool = prompt?.activeTools.get("a");
		if (tool) tool.turnIndex = 0;
		release?.();
		await starting;

		expect(lf.span).toHaveBeenCalledWith(
			expect.objectContaining({ parentObservationId: "late-turn-span" }),
		);
	});

	it("updates the span with the latest arguments on a repeated call event", async () => {
		const { span, handlers, ctx } = setup();

		await handlers.toolCall(call("a", "bash", { cmd: "one" }), ctx);
		await handlers.toolCall(call("a", "bash", { cmd: "two" }), ctx);

		expect(span.update).toHaveBeenLastCalledWith({
			input: 'bash({"cmd":"two"})',
			metadata: { tool: "bash", argsSummary: 'bash({"cmd":"two"})' },
		});
	});

	it("records a runtime failure and keeps the tool without a span", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({
			prompt,
			getRuntime: async () => {
				throw new Error("runtime down");
			},
		});

		await handlers.toolCall(call("a"), ctx);

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to create tool span: runtime down",
		);
		expect(prompt?.activeTools.get("a")?.span).toBeUndefined();
	});

	it("creates no span when tracing is off, the prompt has no trace, or the prompt is finalizing", async () => {
		const off = setup({ canTrace: false });
		await off.handlers.toolCall(call("a"), off.ctx);
		const untraced = setup({ prompt: makePrompt({ trace: undefined }) });
		await untraced.handlers.toolCall(call("a"), untraced.ctx);
		const finalizing = setup({ prompt: makePrompt({ finalizing: true }) });
		await finalizing.handlers.toolCall(call("a"), finalizing.ctx);

		expect(off.lf.span).not.toHaveBeenCalled();
		expect(untraced.lf.span).not.toHaveBeenCalled();
		expect(finalizing.lf.span).not.toHaveBeenCalled();
		expect(finalizing.rawRecords).toEqual([]);
	});

	it.each([
		["no prompt", undefined],
		["a finalizing prompt", makePrompt({ finalizing: true })],
	])(
		"ignores execution start, progress and result events for %s",
		async (_name, prompt) => {
			const { lf, handlers, rawRecords, ctx } = setup({ prompt });

			await handlers.toolExecutionStart(execStart("a"), ctx);
			await handlers.toolExecutionUpdate(
				{
					toolCallId: "a",
					toolName: "bash",
					args: {},
					partialResult: "half",
				} as never,
				ctx,
			);
			await handlers.toolResult(
				{
					toolCallId: "a",
					toolName: "bash",
					input: {},
					content: [],
					isError: true,
				} as never,
				ctx,
			);

			expect(lf.span).not.toHaveBeenCalled();
			expect(rawRecords).toEqual([]);
			expect(prompt?.activeTools.size ?? 0).toBe(0);
			expect(prompt?.toolErrors ?? 0).toBe(0);
		},
	);

	it("counts edit and write calls once per tool call id", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });

		await handlers.toolCall(call("a", "edit"), ctx);
		await handlers.toolCall(call("a", "edit"), ctx);
		await handlers.toolCall(call("b", "write"), ctx);
		await handlers.toolCall(call("c", "bash"), ctx);

		expect(prompt?.editWriteCalls).toBe(2);
		expect(prompt?.toolCalls).toBe(3);
	});
});

describe("a tool span that is requested while the runtime starts", () => {
	/** Starts a tool call whose runtime answers only after `change` ran. */
	async function callDuring(
		change: (context: ReturnType<typeof setup>) => void,
	) {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const span = makeSpan();
		const lf = { span: vi.fn(() => span), score: vi.fn() };
		const context = setup({
			getRuntime: async () => {
				await gate;
				return lf;
			},
		});
		const starting = context.handlers.toolCall(call("a"), context.ctx);
		change(context);
		release?.();
		await starting;
		return { ...context, spanFactory: lf.span };
	}

	it.each([
		[
			"the prompt was replaced",
			({ session }: ReturnType<typeof setup>) => {
				session.promptState = makePrompt();
			},
		],
		[
			"the tool was dropped",
			({ prompt }: ReturnType<typeof setup>) => {
				prompt?.activeTools.clear();
			},
		],
		[
			"the span was already ended",
			({ prompt }: ReturnType<typeof setup>) => {
				const tool = prompt?.activeTools.get("a");
				if (tool) tool.spanEnded = true;
			},
		],
		[
			"the tool already has a span",
			({ prompt }: ReturnType<typeof setup>) => {
				const tool = prompt?.activeTools.get("a");
				if (tool) tool.span = makeSpan("existing");
			},
		],
	])("opens no span when %s", async (_name, change) => {
		const { spanFactory } = await callDuring(change);

		expect(spanFactory).not.toHaveBeenCalled();
	});

	it("uses the prompt span that appeared while the runtime was starting", async () => {
		const prompt = makePrompt({ promptSpan: undefined });
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lf = { span: vi.fn(() => makeSpan()), score: vi.fn() };
		const { handlers, ctx } = setup({
			prompt,
			getRuntime: async () => {
				await gate;
				return lf;
			},
		});

		const starting = handlers.toolCall(call("a"), ctx);
		Object.assign(prompt, { promptSpan: { id: "late-prompt-span" } });
		release?.();
		await starting;

		expect(lf.span).toHaveBeenCalledWith(
			expect.objectContaining({ parentObservationId: "late-prompt-span" }),
		);
	});
});

describe("tool progress and results", () => {
	const progress = (partialResult: unknown) =>
		({
			toolCallId: "a",
			toolName: "bash",
			args: {},
			partialResult,
		}) as never;

	it("keeps progress off the span and summarizes only the latest partial output when it is needed", async () => {
		// A span is exported once, when it ends, so progress updates cannot
		// reach Langfuse; summarizing each one only burned CPU on every update.
		const summarized: unknown[] = [];
		const { span, handlers, ctx } = setup({
			summarizeToolResult: (_config, result) => {
				summarized.push(result);
				// An empty final result summarizes to nothing, like the default fake.
				return result === null ? "" : JSON.stringify(result);
			},
		});
		for (const partial of ["first", "second", "latest"]) {
			await handlers.toolExecutionUpdate(progress(partial), ctx);
		}
		expect(span.update).not.toHaveBeenCalled();
		expect(summarized).toEqual([]);

		await handlers.toolExecutionEnd(execEnd("a", false, null), ctx);

		expect(summarized).toEqual([null, "latest"]);
		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			output: '"latest"',
			metadata: expect.objectContaining({ partial: true }),
		});
	});

	it("exports a completed tool's final output without a partial marker", async () => {
		const { span, handlers, ctx } = setup();
		await handlers.toolExecutionUpdate(progress("half"), ctx);

		await handlers.toolExecutionEnd(execEnd("a", false, { ok: true }), ctx);

		const body = span.end.mock.calls[0]?.[0];
		expect(body).toMatchObject({ output: JSON.stringify({ ok: true }) });
		expect(body?.metadata).not.toHaveProperty("partial");
	});

	it("ignores progress when capture is off or the span already ended", async () => {
		const off = setup({ config: { captureToolProgress: false } });
		await off.handlers.toolExecutionUpdate(
			{
				toolCallId: "a",
				toolName: "bash",
				args: {},
				partialResult: "x",
			} as never,
			off.ctx,
		);
		expect(off.prompt?.activeTools.size).toBe(0);

		const ended = setup();
		await ended.handlers.toolExecutionStart(execStart("a"), ended.ctx);
		await ended.handlers.toolExecutionEnd(execEnd("a"), ended.ctx);
		ended.span.update.mockClear();
		await ended.handlers.toolExecutionUpdate(
			{
				toolCallId: "a",
				toolName: "bash",
				args: {},
				partialResult: "late",
			} as never,
			ended.ctx,
		);
		expect(ended.span.update).not.toHaveBeenCalled();
	});

	it("writes a tool_result_first_seen record once, with its image count", async () => {
		const { rawRecords, handlers, ctx } = setup();
		const result = (content: unknown[]) =>
			({
				toolCallId: "a",
				toolName: "read",
				input: { path: "x" },
				content,
				isError: false,
			}) as never;

		await handlers.toolResult(
			result([{ type: "text" }, { type: "image" }, { type: "image_url" }]),
			ctx,
		);
		await handlers.toolResult(result([{ type: "text" }]), ctx);

		const first = rawRecords.filter(
			(record) => record.type === "tool_result_first_seen",
		);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ imgBlocks: 2, toolCallId: "a" });
	});

	it("omits the image count when a result has no images or no content list", async () => {
		const { rawRecords, handlers, ctx } = setup();

		await handlers.toolResult(
			{ toolCallId: "a", toolName: "read", input: {}, isError: false } as never,
			ctx,
		);

		expect(rawRecords[0]).toMatchObject({ imgBlocks: undefined });
	});

	it("counts nested model usage of a result once", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });
		const event = {
			toolCallId: "a",
			toolName: "task",
			input: {},
			content: [],
			isError: false,
			usage: { input: 5, output: 2 },
		} as never;

		await handlers.toolResult(event, ctx);
		await handlers.toolResult(event, ctx);

		expect(prompt?.indirectTokensIn).toBe(5);
		expect(prompt?.indirectTokensOut).toBe(2);
	});
});

describe("tool completion", () => {
	it("ends the span with the final output and counts a failure once", async () => {
		const prompt = makePrompt();
		const { span, lf, handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("a"), ctx);

		await handlers.toolExecutionEnd(execEnd("a", true, { out: "boom" }), ctx);
		await handlers.toolExecutionEnd(execEnd("a", true, { out: "again" }), ctx);

		expect(span.end).toHaveBeenCalledTimes(1);
		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			isError: true,
			output: '{"out":"boom"}',
			statusMessage: "tool execution failed",
		});
		expect(prompt?.toolErrors).toBe(1);
		expect(lf.score).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "tool_is_error",
				observationId: "tool-span",
			}),
		);
	});

	it("falls back to partial output when the final result is empty", async () => {
		const { span, handlers, ctx } = setup();
		await handlers.toolExecutionUpdate(
			{
				toolCallId: "a",
				toolName: "bash",
				args: {},
				partialResult: "partial",
			} as never,
			ctx,
		);

		await handlers.toolExecutionEnd(execEnd("a", false, null), ctx);

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			isError: false,
			output: '"partial"',
			statusMessage: undefined,
		});
	});

	it("ends with no output when there is neither a result nor partial output", async () => {
		const { span, handlers, ctx } = setup();

		await handlers.toolExecutionEnd(execEnd("a", false, null), ctx);

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({ output: undefined });
	});

	it("reports a span that fails to end and still scores the error", async () => {
		const span = makeSpan();
		span.end.mockImplementation(() => {
			throw new Error("end failed");
		});
		const { lf, handlers, ctx } = setup({ span });

		await handlers.toolExecutionEnd(execEnd("a", true), ctx);

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to end tool span: end failed",
		);
		expect(lf.score).toHaveBeenCalledTimes(1);
	});

	it("reports an error score that cannot be sent", async () => {
		const { handlers, ctx } = setup({
			score: () => {
				throw new Error("score rejected");
			},
		});

		await handlers.toolExecutionEnd(execEnd("a", true), ctx);

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to send tool error score: score rejected",
		);
	});

	it("sends no error score for a successful tool or one without a span", async () => {
		const ok = setup();
		await ok.handlers.toolExecutionEnd(execEnd("a", false), ok.ctx);
		const spanless = setup({ canTrace: false });
		await spanless.handlers.toolExecutionEnd(execEnd("a", true), spanless.ctx);

		expect(ok.lf.score).not.toHaveBeenCalled();
		expect(spanless.lf.score).not.toHaveBeenCalled();
	});

	it("takes nested usage from the executed result once", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });

		await handlers.toolExecutionEnd(
			execEnd("a", false, { usage: { input: 3 } }),
			ctx,
		);

		expect(prompt?.indirectTokensIn).toBe(3);
	});

	it("attaches the dialog wait of the flows a tool owns", async () => {
		const prompt = makePrompt({
			askFlows: new Map([
				[
					"tool:a",
					{ flowId: "tool:a", toolCallId: "a", startedAt: 10, completedAt: 40 },
				],
				[
					"tool:b",
					{ flowId: "tool:b", toolCallId: "b", startedAt: 1, completedAt: 2 },
				],
			]),
		});
		const { span, handlers, ctx } = setup({ prompt });

		await handlers.toolExecutionEnd(execEnd("a"), ctx);

		const metadata = span.end.mock.calls[0]?.[0]?.metadata;
		expect(metadata.askUserWait).toMatchObject({
			status: "measured",
			waitMs: 30,
			flowCount: 1,
		});
		expect(metadata.askUserWait.flows).toHaveLength(1);
	});
});

describe("abandoning tools at finalization", () => {
	it("ends tools that never completed as errors, and keeps a result-only tool's own flag", async () => {
		const prompt = makePrompt();
		const { span, handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("running"), ctx);
		await handlers.toolResult(
			{
				toolCallId: "resulted",
				toolName: "read",
				input: {},
				content: [],
				isError: true,
			} as never,
			ctx,
		);
		const state = makeSession(prompt);

		await handlers.abandon(state);

		const bodies = span.end.mock.calls.map((entry) => entry[0]);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toMatchObject({
			isError: true,
			statusMessage: "tool ended without completion event",
			metadata: { abandoned: true },
		});
		expect(bodies[1]).toMatchObject({ isError: true });
		expect(prompt?.toolErrors).toBe(1);
		expect(prompt?.activeTools.size).toBe(0);
	});

	it("reports the tool error flag when an unfinished tool already failed", async () => {
		const prompt = makePrompt();
		const { span, handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("a"), ctx);
		const tool = prompt?.activeTools.get("a");
		if (tool) tool.isError = true;

		await handlers.abandon(makeSession(prompt));

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			isError: true,
			statusMessage: "tool error",
		});
	});

	it("does not count a successful result-only tool as an error", async () => {
		const prompt = makePrompt();
		const { span, handlers, ctx } = setup({ prompt });
		await handlers.toolResult(
			{
				toolCallId: "ok",
				toolName: "read",
				input: {},
				content: [],
				isError: false,
			} as never,
			ctx,
		);

		await handlers.abandon(makeSession(prompt));

		expect(prompt?.toolErrors).toBe(0);
		expect(span.end.mock.calls[0]?.[0]).toMatchObject({ isError: false });
	});

	it("waits for a tool that is already finishing and skips one that completed", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("done"), ctx);
		await handlers.toolExecutionStart(execStart("finishing"), ctx);
		const done = prompt?.activeTools.get("done");
		const finishing = prompt?.activeTools.get("finishing");
		if (!done || !finishing) throw new Error("tools were not tracked");
		done.completionSeen = true;
		let settled = false;
		finishing.finishPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				settled = true;
				resolve();
			}, 5);
		});

		await handlers.abandon(makeSession(prompt));

		expect(settled).toBe(true);
		expect(done.finishPromise).toBeUndefined();
		expect(prompt?.activeTools.size).toBe(0);
	});

	it("treats a result-only tool whose error flag is unset as successful", async () => {
		const prompt = makePrompt();
		const { span, handlers, ctx } = setup({ prompt });
		await handlers.toolResult(
			{ toolCallId: "r", toolName: "read", input: {}, content: [] } as never,
			ctx,
		);

		await handlers.abandon(makeSession(prompt));

		expect(prompt?.toolErrors).toBe(0);
		expect(span.end.mock.calls[0]?.[0]).toMatchObject({ isError: false });
	});

	it("ends a result-only tool with its partial output when the result text is empty", async () => {
		const prompt = makePrompt();
		const { span, handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionUpdate(
			{
				toolCallId: "p",
				toolName: "bash",
				args: {},
				partialResult: "so far",
			} as never,
			ctx,
		);
		await handlers.toolResult(
			{
				toolCallId: "p",
				toolName: "bash",
				input: {},
				content: [{ type: "empty" }],
				isError: false,
			} as never,
			ctx,
		);

		await handlers.abandon(makeSession(prompt));

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({ output: '"so far"' });
	});

	it("ends an abandoned tool with its partial output", async () => {
		const prompt = makePrompt();
		const { span, handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionUpdate(
			{
				toolCallId: "p",
				toolName: "bash",
				args: {},
				partialResult: "so far",
			} as never,
			ctx,
		);

		await handlers.abandon(makeSession(prompt));

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({ output: '"so far"' });
	});

	it("shares one span end between an abandon and a completion that race", async () => {
		const prompt = makePrompt();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const span = makeSpan();
		const lf = { span: vi.fn(() => span), score: vi.fn() };
		const { handlers, ctx } = setup({
			prompt,
			getRuntime: async () => {
				await gate;
				return lf;
			},
		});
		const starting = handlers.toolExecutionStart(execStart("a"), ctx);
		await vi.waitFor(() => expect(prompt?.activeTools.get("a")).toBeDefined());

		const abandoning = handlers.abandon(makeSession(prompt));
		const ending = handlers.toolExecutionEnd(execEnd("a", false), ctx);
		release?.();
		await Promise.all([starting, abandoning, ending]);

		expect(span.end).toHaveBeenCalledTimes(1);
	});

	it("does nothing without a prompt", async () => {
		const { handlers } = setup();

		await expect(
			handlers.abandon({
				promptState: null,
			} as unknown as SessionState<PromptState>),
		).resolves.toBeUndefined();
	});
});

describe("pi-ask flow ownership", () => {
	const started = (flowId: string, extra: Record<string, unknown> = {}) => ({
		version: 1,
		flowId,
		createdAt: 100,
		...extra,
	});

	it("records a tool flow under the prompt whose tool call is active", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("a"), ctx);

		handlers.askStarted(
			started("tool:a", { toolCallId: "a", source: "pi-ask" }),
		);
		handlers.askCompleted({
			version: 1,
			flowId: "tool:a",
			completedAt: 160,
			result: { cancelled: true, cancelReason: "user" },
		});

		expect(prompt?.askFlows.get("tool:a")).toMatchObject({
			toolCallId: "a",
			startedAt: 100,
			completedAt: 160,
			source: "pi-ask",
			cancelled: true,
		});
	});

	it("keeps the first timestamp, source, and cancel decision of a flow", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("a"), ctx);
		handlers.askStarted(
			started("tool:a", { toolCallId: "a", source: "first" }),
		);

		handlers.askStarted(
			started("tool:a", { toolCallId: "a", createdAt: 900, source: "second" }),
		);
		handlers.askCompleted({
			version: 1,
			flowId: "tool:a",
			completedAt: 200,
			result: {},
		});
		handlers.askCompleted({
			version: 1,
			flowId: "tool:a",
			completedAt: 999,
			result: { cancelled: true },
		});

		expect(prompt?.askFlows.get("tool:a")).toMatchObject({
			startedAt: 100,
			completedAt: 200,
			source: "first",
			cancelled: false,
		});
	});

	it("ignores events it cannot attribute or that are malformed", async () => {
		const prompt = makePrompt();
		const { handlers, ctx } = setup({ prompt });
		await handlers.toolExecutionStart(execStart("a"), ctx);

		handlers.askStarted(null);
		handlers.askStarted({ version: 2, flowId: "tool:a", toolCallId: "a" });
		handlers.askStarted({ version: 1, flowId: "", toolCallId: "a" });
		handlers.askStarted({ version: 1, flowId: 7, toolCallId: "a" });
		handlers.askStarted(started("dialog:1"));
		handlers.askStarted(started("tool:zzz", { toolCallId: "zzz" }));

		expect(prompt?.askFlows.size).toBe(0);
	});

	/** Handlers over several sessions; tracing is off so only ownership matters. */
	function handlersFor(sessions: SessionState<PromptState>[]) {
		return createToolLifecycleHandlers({
			getConfig: () => CONFIG,
			getSessionState: () => sessions[0],
			listSessionStates: () => sessions,
			canTrace: () => false,
			getRuntime: async () => ({}),
			redactToolContent: (_config: Config, value: unknown) => value,
			summarizeToolArgs: () => "",
			summarizeToolResult: () => "",
			standardUsageFromUsage: () => undefined,
			usageDetailsFromUsage: () => undefined,
			costDetailsFromUsage: () => undefined,
			writeRawTrace: () => undefined,
		} as unknown as ToolLifecycleDependencies);
	}

	const activeTool = () => ({ toolName: "x", startedAt: 0, argsSummary: "" });

	it("marks a flow ambiguous instead of guessing when two prompts claim it", () => {
		const first = makePrompt();
		const second = makePrompt();
		const handlers = handlersFor([makeSession(first), makeSession(second)]);
		first.activeTools.set("a", activeTool());
		second.activeTools.set("a", activeTool());

		handlers.askStarted(started("tool:a", { toolCallId: "a" }));
		handlers.askStarted(started("tool:a", { toolCallId: "a" }));

		expect(first.askFlows.size + second.askFlows.size).toBe(0);
		expect(first.ambiguousAskFlowIds.has("tool:a")).toBe(true);
		expect(second.ambiguousAskFlowIds.has("tool:a")).toBe(true);
	});

	it("skips finalizing prompts and sessions without a prompt", () => {
		const live = makePrompt();
		const finalizing = makePrompt({ finalizing: true });
		const handlers = handlersFor([
			makeSession(finalizing),
			makeSession(undefined),
			makeSession(live),
		]);
		live.activeTools.set("a", activeTool());
		finalizing.activeTools.set("a", activeTool());

		handlers.askStarted(started("tool:a", { toolCallId: "a" }));

		expect(live.askFlows.has("tool:a")).toBe(true);
		expect(finalizing.askFlows.size).toBe(0);
	});
});

describe("tool completion bookkeeping", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const toolResultEvent = (id: string, isError: boolean) =>
		({
			toolCallId: id,
			toolName: "bash",
			input: { cmd: "ls" },
			content: [],
			isError,
		}) as never;

	it("requests no runtime for a tool whose span ended before one was opened", async () => {
		const runtimeRequests = vi.fn();
		const { prompt, handlers, ctx } = setup({
			getRuntime: async () => {
				runtimeRequests();
				return { span: vi.fn(), score: vi.fn() };
			},
		});
		await handlers.toolCall(call("a"), ctx);
		runtimeRequests.mockClear();
		const tool = prompt?.activeTools.get("a");
		if (!tool) throw new Error("expected the tool to be tracked");
		tool.span = undefined;
		tool.spanStartPromise = undefined;
		tool.spanEnded = true;

		await handlers.toolExecutionStart(execStart("a"), ctx);

		expect(runtimeRequests).not.toHaveBeenCalled();
	});

	it("treats a tool as complete once its execution ended, even without a result event", async () => {
		const { prompt, handlers, ctx } = setup();
		await handlers.toolExecutionStart(execStart("a"), ctx);
		const tool = prompt?.activeTools.get("a");
		if (!tool) throw new Error("expected the tool to be tracked");
		expect(hasToolCompletion(tool)).toBe(false);

		await handlers.toolExecutionEnd(execEnd("a"), ctx);

		expect(hasToolCompletion(tool)).toBe(true);
	});

	it("records one execution end per tool call", async () => {
		const { prompt, handlers, rawRecords, ctx } = setup();
		await handlers.toolExecutionStart(execStart("a"), ctx);

		await handlers.toolExecutionEnd(execEnd("a", true), ctx);
		await handlers.toolExecutionEnd(execEnd("a", true), ctx);

		expect(
			rawRecords.filter((record) => record.type === "tool_execution_end"),
		).toHaveLength(1);
		expect(prompt?.toolErrors).toBe(1);
	});

	it("counts a failed tool once when an abandon races its execution end", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const span = makeSpan();
		const { prompt, session, handlers, ctx } = setup({
			span,
			getRuntime: async () => {
				await gate;
				return { span: vi.fn(() => span), score: vi.fn() };
			},
		});
		await handlers.toolResult(toolResultEvent("a", true), ctx);

		const abandoning = handlers.abandon(session);
		const ending = handlers.toolExecutionEnd(execEnd("a", true), ctx);
		release();
		await Promise.all([abandoning, ending]);

		expect(prompt?.toolErrors).toBe(1);
	});

	it("does not count a failed tool again when its execution end broke after counting it", async () => {
		const { prompt, session, handlers, ctx } = setup({
			redactToolContent: (_config, value) => {
				// Only the execution-end result carries `ok`.
				if ((value as { ok?: boolean } | undefined)?.ok) {
					throw new Error("result cannot be redacted");
				}
				return value;
			},
		});
		await handlers.toolResult(toolResultEvent("a", true), ctx);

		await expect(
			handlers.toolExecutionEnd(execEnd("a", true), ctx),
		).rejects.toThrow("result cannot be redacted");
		await handlers.abandon(session);

		expect(prompt?.toolErrors).toBe(1);
	});

	it("reports how long a tool ran when it ends and when it is abandoned", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(20_000);
		const ended = setup();
		await ended.handlers.toolExecutionStart(execStart("a"), ended.ctx);
		const abandoned = setup();
		await abandoned.handlers.toolExecutionStart(execStart("b"), abandoned.ctx);
		vi.setSystemTime(20_300);

		await ended.handlers.toolExecutionEnd(execEnd("a"), ended.ctx);
		await abandoned.handlers.abandon(abandoned.session);

		expect(ended.span.end).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ durationMs: 300 }),
			}),
		);
		expect(
			ended.rawRecords.find((record) => record.type === "tool_execution_end"),
		).toMatchObject({ durationMs: 300 });
		expect(abandoned.span.end).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ durationMs: 300, abandoned: true }),
			}),
		);
	});
});
