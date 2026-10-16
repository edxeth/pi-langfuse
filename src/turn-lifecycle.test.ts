import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type {
	GenerationState,
	PromptState,
	TurnState,
} from "./lifecycle-types.js";
import { getLastRuntimeError } from "./runtime-diagnostics.js";
import type { SessionState } from "./session-state.js";
import {
	createTurnLifecycleHandlers,
	type TurnLifecycleDependencies,
} from "./turn-lifecycle.js";

/**
 * The turn handlers take every collaborator as a dependency, so these tests
 * drive them with small faithful fakes: a runtime whose spans record `end`,
 * and prompt and session state with only the fields the turn code reads.
 */
const CONFIG = { traceOutputMaxChars: 100 } as Config;

function makePrompt(overrides: Partial<PromptState> = {}) {
	return {
		activeTurns: new Map<number, TurnState>(),
		completedTurnIndexes: new Set<number>(),
		turns: 0,
		finalizing: false,
		trace: { id: "trace-1" },
		promptSpan: { id: "prompt-span" },
		...overrides,
	} as unknown as PromptState;
}

function makeSession(prompt: PromptState | undefined) {
	return {
		promptState: prompt,
		model: "model-x",
		provider: "provider-y",
	} as unknown as SessionState<PromptState>;
}

function makeSpan() {
	return { id: "turn-span", end: vi.fn() };
}

function setup(
	options: {
		prompt?: PromptState | undefined;
		canTrace?: boolean;
		span?: ReturnType<typeof makeSpan>;
		getRuntime?: TurnLifecycleDependencies["getRuntime"];
	} = {},
) {
	const prompt = "prompt" in options ? options.prompt : makePrompt();
	const span = options.span ?? makeSpan();
	const lf = { span: vi.fn(() => span) };
	const abandonTurnGenerations = vi.fn(async () => {});
	const getRuntime = vi.fn(async () => lf);
	const deps = {
		getConfig: () => CONFIG,
		getSessionState: () => makeSession(prompt),
		canTrace: () => options.canTrace ?? true,
		getRuntime: options.getRuntime ?? getRuntime,
		telemetryText: (_config: Config, text: string) => `text:${text}`,
		redactionMetadata: () => ({ redaction: "meta" }),
		standardUsageFromUsage: () => ({ standard: true }),
		usageDetailsFromUsage: () => ({ details: true }),
		costDetailsFromUsage: () => ({ cost: true }),
		abandonTurnGenerations,
	} as unknown as TurnLifecycleDependencies;
	const handlers = createTurnLifecycleHandlers(deps);
	const ctx = {} as never;
	return {
		prompt,
		span,
		lf,
		getRuntime,
		abandonTurnGenerations,
		handlers,
		ctx,
	};
}

const start = (index: number) =>
	({ type: "turn_start", turnIndex: index }) as never;
const end = (index: number, extra: Record<string, unknown> = {}) =>
	({
		type: "turn_end",
		turnIndex: index,
		message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
		...extra,
	}) as never;

describe("turn start", () => {
	it("opens a turn span under the prompt span and counts the turn", async () => {
		const { prompt, span, lf, handlers, ctx } = setup();

		await handlers.turnStart(start(0), ctx);

		expect(lf.span).toHaveBeenCalledWith({
			name: "agent.turn",
			traceId: "trace-1",
			parentObservationId: "prompt-span",
			metadata: {
				redaction: { redaction: "meta" },
				turnIndex: 0,
				turnNumber: 1,
				model: "model-x",
				provider: "provider-y",
			},
		});
		expect(prompt?.turns).toBe(1);
		expect(prompt?.activeTurns.get(0)?.span).toBe(span);
	});

	it.each([
		["no prompt", () => undefined],
		["a finalizing prompt", () => makePrompt({ finalizing: true })],
		[
			"a turn that already completed",
			() => makePrompt({ completedTurnIndexes: new Set([0]) }),
		],
		[
			"a turn that is already active",
			() =>
				makePrompt({
					activeTurns: new Map([[0, { index: 0 } as unknown as TurnState]]),
				}),
		],
	])("ignores a start with %s", async (_name, makeOnePrompt) => {
		const prompt = makeOnePrompt();
		const { getRuntime, handlers, ctx } = setup({ prompt });
		const turnsBefore = prompt?.turns;

		await handlers.turnStart(start(0), ctx);

		expect(getRuntime).not.toHaveBeenCalled();
		expect(prompt?.turns).toBe(turnsBefore);
	});

	it("tracks the turn without a span when tracing is off or the prompt has no trace", async () => {
		const off = setup({ canTrace: false });
		await off.handlers.turnStart(start(0), off.ctx);
		expect(off.getRuntime).not.toHaveBeenCalled();
		expect(off.prompt?.activeTurns.get(0)?.span).toBeUndefined();

		const untraced = setup({ prompt: makePrompt({ trace: undefined }) });
		await untraced.handlers.turnStart(start(0), untraced.ctx);
		expect(untraced.getRuntime).not.toHaveBeenCalled();
		expect(untraced.prompt?.activeTurns.get(0)).toBeDefined();
	});

	it("records a runtime failure and keeps the turn without a span", async () => {
		const { prompt, handlers, ctx } = setup({
			getRuntime: async () => {
				throw new Error("runtime unavailable");
			},
		});

		await handlers.turnStart(start(0), ctx);

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to create turn span: runtime unavailable",
		);
		expect(prompt?.activeTurns.get(0)?.span).toBeUndefined();
	});

	it("creates no span when the turn ended while the runtime was starting", async () => {
		let release: (() => void) | undefined;
		const span = makeSpan();
		const lf = { span: vi.fn(() => span) };
		const { prompt, handlers, ctx } = setup({
			getRuntime: (() =>
				new Promise((resolve) => {
					release = () => resolve(lf);
				})) as never,
		});

		const starting = handlers.turnStart(start(0), ctx);
		const turn = prompt?.activeTurns.get(0);
		if (!turn) throw new Error("turn was not tracked synchronously");
		turn.ended = true;
		release?.();
		await starting;

		expect(lf.span).not.toHaveBeenCalled();
		expect(turn.span).toBeUndefined();
	});
});

describe("turn end", () => {
	async function startedTurn(options: Parameters<typeof setup>[0] = {}) {
		const context = setup(options);
		await context.handlers.turnStart(start(0), context.ctx);
		return context;
	}

	it("ends the span with the projected answer, usage, and result count", async () => {
		const { span, handlers, ctx } = await startedTurn();

		await handlers.turnEnd(
			end(0, {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					usage: { input: 1 },
				},
				toolResults: [{ toolCallId: "a" }, { toolCallId: "b", isError: true }],
			}),
			ctx,
		);

		expect(span.end).toHaveBeenCalledTimes(1);
		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			output: { text: "text:answer", tool_calls: [] },
			usage: { standard: true },
			usageDetails: { details: true },
			costDetails: { cost: true },
			isError: undefined,
			statusMessage: undefined,
			metadata: { turnIndex: 0, toolResults: 2 },
		});
	});

	it("counts no tool results when the event carries none", async () => {
		const { span, handlers, ctx } = await startedTurn();

		await handlers.turnEnd(end(0), ctx);

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			metadata: { toolResults: 0 },
		});
	});

	it("does not end the span again for a repeated end", async () => {
		const { span, handlers, ctx } = await startedTurn();

		await handlers.turnEnd(end(0), ctx);
		await handlers.turnEnd(end(0), ctx);

		expect(span.end).toHaveBeenCalledTimes(1);
	});

	it("ignores an end that arrives while the first end is still settling", async () => {
		const { prompt, span, abandonTurnGenerations, handlers, ctx } =
			await startedTurn();
		const turn = prompt?.activeTurns.get(0);
		if (!turn) throw new Error("turn was not tracked");
		turn.generations.set("open", { ended: false } as GenerationState);
		let release: (() => void) | undefined;
		abandonTurnGenerations.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const first = handlers.turnEnd(end(0), ctx);
		await handlers.turnEnd(end(0), ctx);
		expect(span.end).not.toHaveBeenCalled();
		release?.();
		await first;

		expect(span.end).toHaveBeenCalledTimes(1);
	});

	it("reports an errored message as the turn's failure and the prompt's first failure", async () => {
		const { prompt, span, handlers, ctx } = await startedTurn();

		await handlers.turnEnd(
			end(0, {
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "rate limited",
				},
			}),
			ctx,
		);

		expect(prompt?.failure).toEqual({
			stopReason: "error",
			errorMessage: "rate limited",
		});
		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			isError: true,
			statusMessage: "rate limited",
		});
	});

	it("names an aborted turn that carries no message", async () => {
		const { span, handlers, ctx } = await startedTurn();

		await handlers.turnEnd(
			end(0, { message: { role: "assistant", stopReason: "aborted" } }),
			ctx,
		);

		expect(span.end.mock.calls[0]?.[0]).toMatchObject({
			isError: true,
			statusMessage: "agent turn aborted",
		});
	});

	it("keeps the last tool result of the finalized result list", async () => {
		const { prompt, handlers, ctx } = await startedTurn();

		await handlers.turnEnd(
			end(0, {
				toolResults: [
					{ toolCallId: "first", isError: true },
					{ toolCallId: "last" },
				],
			}),
			ctx,
		);

		expect(prompt?.lastToolResult).toEqual({
			toolCallId: "last",
			isError: false,
		});
	});

	it("leaves the earlier tool result when a turn has none", async () => {
		const { prompt, handlers, ctx } = await startedTurn();
		if (prompt)
			prompt.lastToolResult = { toolCallId: "earlier", isError: true };

		await handlers.turnEnd(end(0, { toolResults: [] }), ctx);

		expect(prompt?.lastToolResult).toEqual({
			toolCallId: "earlier",
			isError: true,
		});
	});

	it("counts the tool result of a turn that was never tracked once", async () => {
		const { prompt, handlers, ctx } = setup();

		await handlers.turnEnd(end(4, { toolResults: [{ toolCallId: "x" }] }), ctx);
		await handlers.turnEnd(
			end(4, { toolResults: [{ toolCallId: "y", isError: true }] }),
			ctx,
		);

		expect(prompt?.lastToolResult).toEqual({ toolCallId: "x", isError: false });
		expect(prompt?.completedTurnIndexes.has(4)).toBe(true);
	});

	it("ignores an end without a prompt or during finalization", async () => {
		const noPrompt = setup({ prompt: undefined });
		await noPrompt.handlers.turnEnd(end(0), noPrompt.ctx);

		const finalizing = setup({ prompt: makePrompt({ finalizing: true }) });
		await finalizing.handlers.turnEnd(end(0), finalizing.ctx);

		expect(finalizing.prompt?.completedTurnIndexes.size).toBe(0);
	});

	function addGeneration(
		turn: TurnState,
		key: string,
		generation: Partial<GenerationState>,
	) {
		turn.generations.set(key, generation as GenerationState);
	}

	it("abandons unfinished generations and records why when none is finishing", async () => {
		const { prompt, abandonTurnGenerations, handlers, ctx } =
			await startedTurn();
		const turn = prompt?.activeTurns.get(0);
		if (!turn) throw new Error("turn was not tracked");
		addGeneration(turn, "done", { ended: true });
		addGeneration(turn, "open", { ended: false });

		await handlers.turnEnd(end(0), ctx);

		expect(abandonTurnGenerations).toHaveBeenCalledWith(turn);
		expect(prompt?.abandonmentReason).toBe(
			"turn ended before generation completion",
		);
	});

	it("abandons generations that are already finishing without blaming the turn", async () => {
		const { prompt, abandonTurnGenerations, handlers, ctx } =
			await startedTurn();
		const turn = prompt?.activeTurns.get(0);
		if (!turn) throw new Error("turn was not tracked");
		addGeneration(turn, "finishing", {
			ended: false,
			finishPromise: Promise.resolve(),
		});

		await handlers.turnEnd(end(0), ctx);

		expect(abandonTurnGenerations).toHaveBeenCalledTimes(1);
		expect(prompt?.abandonmentReason).toBeUndefined();
	});

	it("does not abandon anything when every generation ended", async () => {
		const { prompt, abandonTurnGenerations, handlers, ctx } =
			await startedTurn();
		const turn = prompt?.activeTurns.get(0);
		if (!turn) throw new Error("turn was not tracked");
		addGeneration(turn, "done", { ended: true });

		await handlers.turnEnd(end(0), ctx);

		expect(abandonTurnGenerations).not.toHaveBeenCalled();
	});

	it("does not write a span when tracing is off, and still closes the turn", async () => {
		const { prompt, span, handlers, ctx } = await startedTurn({
			canTrace: false,
		});

		await handlers.turnEnd(end(0), ctx);

		expect(span.end).not.toHaveBeenCalled();
		expect(prompt?.activeTurns.has(0)).toBe(false);
		expect(prompt?.completedTurnIndexes.has(0)).toBe(true);
	});
});

describe("turn spans while the runtime resolves", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Handlers over one stable session whose runtime answers only when released. */
	function gatedHandlers() {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const span = makeSpan();
		const lf = { span: vi.fn(() => span) };
		const prompt = makePrompt();
		const session = makeSession(prompt);
		const handlers = createTurnLifecycleHandlers({
			getConfig: () => CONFIG,
			getSessionState: () => session,
			canTrace: () => true,
			getRuntime: async () => {
				await gate;
				return lf;
			},
			telemetryText: (_config: Config, text: string) => text,
			redactionMetadata: () => ({ redaction: "meta" }),
			standardUsageFromUsage: () => undefined,
			usageDetailsFromUsage: () => undefined,
			costDetailsFromUsage: () => undefined,
			abandonTurnGenerations: async () => undefined,
		} as unknown as TurnLifecycleDependencies);
		return { handlers, lf, span, prompt, session, release, ctx: {} as never };
	}

	it("creates no span when another prompt took over the session meanwhile", async () => {
		const { handlers, lf, session, release, ctx } = gatedHandlers();

		const starting = handlers.turnStart(start(0), ctx);
		session.promptState = makePrompt();
		release();
		await starting;

		expect(lf.span).not.toHaveBeenCalled();
	});

	it("creates no span when the prompt began finalizing meanwhile", async () => {
		const { handlers, lf, prompt, release, ctx } = gatedHandlers();

		const starting = handlers.turnStart(start(0), ctx);
		prompt.finalizing = true;
		release();
		await starting;

		expect(lf.span).not.toHaveBeenCalled();
	});

	it("settles a turn end only after the span creation it overtook has settled", async () => {
		const { handlers, lf, release, ctx } = gatedHandlers();

		const starting = handlers.turnStart(start(0), ctx);
		let settled = false;
		const ending = handlers.turnEnd(end(0), ctx).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		release();
		await Promise.all([starting, ending]);

		expect(settled).toBe(true);
		// The turn ended first, so no span is opened for it afterwards.
		expect(lf.span).not.toHaveBeenCalled();
	});

	it("reports the turn's duration and clears its generations when it ends", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(30_000);
		const { prompt, span, handlers, ctx } = setup();
		await handlers.turnStart(start(0), ctx);
		const turn = prompt?.activeTurns.get(0);
		if (!turn) throw new Error("turn was not tracked");
		turn.generations.set("request-1", { ended: true } as GenerationState);
		turn.generationOrder.push("request-1");
		vi.setSystemTime(30_250);

		await handlers.turnEnd(end(0), ctx);

		expect(span.end).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ durationMs: 250 }),
			}),
		);
		expect(turn.generations.size).toBe(0);
		expect(turn.generationOrder).toEqual([]);
	});
});
