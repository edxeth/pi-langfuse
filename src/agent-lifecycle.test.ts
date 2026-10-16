import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentLifecycleDependencies,
	createAgentLifecycleHandlers,
} from "./agent-lifecycle.js";
import type { Config } from "./config.js";
import type { PromptState, ToolState, TurnState } from "./lifecycle-types.js";
import { getLastRuntimeError } from "./runtime-diagnostics.js";
import type { SessionState } from "./session-state.js";

/**
 * The agent lifecycle takes every collaborator as a dependency, so these
 * tests drive it with faithful fakes: a runtime that records its traces,
 * spans, and scores, and session state with the fields the lifecycle reads.
 */
const CONFIG = {
	host: "http://localhost:3100/",
	publicKey: "pk-test",
	release: "",
	environment: "",
	skipUnpersistedSessions: false,
	rawTraceEnabled: false,
	traceInputMaxChars: 100,
	traceOutputMaxChars: 100,
} as Config;

function makeState(overrides: Partial<SessionState<PromptState>> = {}) {
	return {
		sessionId: "",
		sessionFile: "",
		previousSessionFile: "",
		sessionReason: "startup",
		model: "",
		provider: "",
		promptState: null,
		compactCount: 0,
		lease: Symbol("test"),
		...overrides,
	} as SessionState<PromptState>;
}

interface SetupOptions {
	state?: SessionState<PromptState> | undefined;
	config?: Partial<Config>;
	canTrace?: boolean;
	getRuntime?: () => Promise<unknown>;
	ensureLocalLangfuseStarted?: () => Promise<void>;
}

function setup(options: SetupOptions = {}) {
	const state = "state" in options ? options.state : makeState();
	const config = { ...CONFIG, ...options.config } as Config;
	const trace = { id: "trace-1", update: vi.fn() };
	const promptSpan = { id: "prompt-span", end: vi.fn() };
	const lf = {
		trace: vi.fn((_body: { input?: string }) => trace),
		span: vi.fn(() => promptSpan),
		score: vi.fn((_score: { name: string; value: number }) => undefined),
	};
	const rawRecords: Array<Record<string, unknown>> = [];
	const deps = {
		getConfig: () => config,
		updateStatus: vi.fn(),
		getSessionState: () => state,
		canTrace: () => options.canTrace ?? true,
		ensureLocalLangfuseStarted:
			options.ensureLocalLangfuseStarted ?? (async () => undefined),
		getRuntime: options.getRuntime ?? (async () => lf),
		flushClient: vi.fn(async () => undefined),
		writeRawTrace: (
			_config: Config,
			_state: unknown,
			record: Record<string, unknown>,
		) => rawRecords.push(record),
		buildTraceTags: () => ["tag"],
		telemetryText: (_config: Config, text: string) => `text:${text}`,
		getUserId: () => "user-1",
		getRuntimeName: () => "runtime-x",
		getSessionRoot: () => "root-1",
		redactionMetadata: () => ({ redaction: "meta" }),
		collectSourceMetadata: () => ({ repo: "meta" }),
		truncate: (text: string, limit: number) => `truncated(${limit}):${text}`,
		extractTextFromContent: (content: Array<{ text?: string }>) =>
			content.map((part) => part.text ?? "").join(""),
		abandonTurnGenerations: vi.fn(async () => undefined),
		abandonTools: vi.fn(async () => undefined),
	} as unknown as AgentLifecycleDependencies;
	const handlers = createAgentLifecycleHandlers(deps);
	return { state, config, trace, promptSpan, lf, rawRecords, deps, handlers };
}

function ctxOf(file: string | undefined, extra: Record<string, unknown> = {}) {
	return {
		sessionManager: { getSessionFile: () => file },
		...extra,
	} as never;
}

const startEvent = (extra: Record<string, unknown> = {}) =>
	({
		prompt: "hello",
		systemPrompt: "SYS",
		systemPromptOptions: { cwd: "/work" },
		...extra,
	}) as never;

async function started(options: SetupOptions = {}) {
	const context = setup(options);
	const ctx = ctxOf("/sessions/--w--/s.jsonl", {
		model: { id: "model-1", provider: "provider-1" },
	});
	await context.handlers.beforeAgentStart(startEvent(), ctx);
	return { ...context, ctx };
}

/** A prompt that already took over the session; it is finalizing, so nothing continues it. */
const SUPERSEDING_PROMPT = {
	startSignature: "other",
	finalizing: true,
	activeTurns: new Map(),
	completedTurnIndexes: new Set(),
} as unknown as PromptState;

function promptOf(state: SessionState<PromptState> | undefined) {
	const prompt = state?.promptState;
	if (!prompt) throw new Error("expected an active prompt");
	return prompt;
}

describe("starting a prompt", () => {
	it("creates the trace and prompt span and remembers the destination", async () => {
		const { state, lf, rawRecords } = await started({
			state: makeState({ sessionId: "s1", previousSessionFile: "/prev.jsonl" }),
		});

		expect(lf.trace).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "pi-agent",
				input: "text:hello",
				sessionId: "s1",
				userId: "user-1",
				metadata: expect.objectContaining({
					cwd: "/work",
					systemPrompt: "text:SYS",
					sessionFile: "/sessions/--w--/s.jsonl",
					previousSessionFile: "/prev.jsonl",
					runtime: "runtime-x",
				}),
			}),
		);
		expect(lf.span).toHaveBeenCalledWith({
			name: "agent.prompt",
			traceId: "trace-1",
		});
		expect(promptOf(state).destination).toEqual({
			host: "http://localhost:3100",
			publicKey: "pk-test",
		});
		expect(rawRecords[0]).toMatchObject({
			type: "agent_prompt_start",
			cwd: "/work",
			prompt: "hello",
			previousSessionFile: "/prev.jsonl",
		});
	});

	it("uses empty fallbacks for a session with no id, file, system prompt, or cwd option", async () => {
		const context = setup();
		await context.handlers.beforeAgentStart(
			{ prompt: "hello" } as never,
			ctxOf(undefined),
		);

		expect(context.lf.trace).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: undefined,
				metadata: expect.objectContaining({
					cwd: process.cwd(),
					systemPrompt: "text:",
					sessionFile: undefined,
					previousSessionFile: undefined,
				}),
			}),
		);
		expect(context.rawRecords[0]).toMatchObject({
			systemPrompt: "",
			previousSessionFile: undefined,
		});
	});

	it("takes the model and provider from the context only while the session has none", async () => {
		const empty = setup();
		await empty.handlers.beforeAgentStart(
			startEvent(),
			ctxOf("/s.jsonl", { model: { id: "", provider: "" } }),
		);
		expect(empty.state?.model).toBe("");
		expect(empty.state?.provider).toBe("");

		const known = setup({
			state: makeState({ model: "kept", provider: "kept-p" }),
		});
		await known.handlers.beforeAgentStart(
			startEvent(),
			ctxOf("/s.jsonl", { model: { id: "other", provider: "other-p" } }),
		);
		expect(known.state?.model).toBe("kept");

		const filled = await started();
		expect(filled.state?.model).toBe("model-1");
		expect(filled.state?.provider).toBe("provider-1");
	});

	it("ignores events that are not a user prompt for a known session", async () => {
		const noState = setup({ state: undefined });
		await noState.handlers.beforeAgentStart(startEvent(), ctxOf("/s.jsonl"));
		expect(noState.rawRecords).toEqual([]);

		const custom = setup();
		await custom.handlers.beforeAgentStart(
			{ customMessage: {} } as never,
			ctxOf("/s.jsonl"),
		);
		expect(custom.rawRecords).toEqual([]);
		expect(custom.deps.updateStatus).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"tracing off and raw traces off",
			{ canTrace: false, config: {} },
			"/s.jsonl",
			0,
		],
		[
			"an unpersisted session when those are skipped",
			{ config: { skipUnpersistedSessions: true } },
			undefined,
			0,
		],
		[
			"tracing off but raw traces on",
			{ canTrace: false, config: { rawTraceEnabled: true } },
			"/s.jsonl",
			1,
		],
		["an unpersisted session when those are kept", {}, undefined, 1],
		[
			"a persisted session when unpersisted ones are skipped",
			{ config: { skipUnpersistedSessions: true } },
			"/s.jsonl",
			1,
		],
	])("handles %s", async (_name, options, file, rawRecordCount) => {
		const context = setup(options as SetupOptions);

		await context.handlers.beforeAgentStart(startEvent(), ctxOf(file));

		expect(context.rawRecords).toHaveLength(rawRecordCount);
	});

	it("does not trace when tracing is off even though raw traces are written", async () => {
		const { lf, state } = await started({
			canTrace: false,
			config: { rawTraceEnabled: true },
		});

		expect(lf.trace).not.toHaveBeenCalled();
		expect(promptOf(state).trace).toBeUndefined();
	});

	it("keeps the active prompt when the same prompt is announced again", async () => {
		const { state, handlers, ctx, rawRecords } = await started();
		const first = promptOf(state);

		await handlers.beforeAgentStart(startEvent(), ctx);

		expect(promptOf(state)).toBe(first);
		expect(rawRecords).toHaveLength(1);
	});

	it("replaces the prompt when the prompt text changes and finalizes the old one", async () => {
		const { state, handlers, ctx } = await started();
		const first = promptOf(state);

		await handlers.beforeAgentStart(startEvent({ prompt: "second" }), ctx);

		expect(promptOf(state)).not.toBe(first);
		expect(first.finalizing).toBe(true);
		expect(promptOf(state).userPrompt).toBe("second");
	});

	it("replaces the prompt when only the system prompt changes", async () => {
		// A start is the same prompt only when its text, system prompt, working
		// directory, and session all match.
		const { state, handlers, ctx } = await started();
		const first = promptOf(state);

		await handlers.beforeAgentStart(startEvent({ systemPrompt: "OTHER" }), ctx);

		expect(promptOf(state)).not.toBe(first);
		expect(first.finalizing).toBe(true);
		expect(promptOf(state).systemPrompt).toBe("OTHER");
	});

	it("lets a concurrent identical start wait for the pending one", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const context = setup({ ensureLocalLangfuseStarted: () => gate });
		const ctx = ctxOf("/s.jsonl");

		const first = context.handlers.beforeAgentStart(startEvent(), ctx);
		const second = context.handlers.beforeAgentStart(startEvent(), ctx);
		await vi.waitFor(() =>
			expect(context.rawRecords.length).toBeGreaterThan(0),
		);
		release?.();
		await Promise.all([first, second]);

		expect(
			context.rawRecords.filter((r) => r.type === "agent_prompt_start"),
		).toHaveLength(1);
	});

	it("starts a different prompt after the pending one settles, and skips it if that already is the prompt", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const context = setup({ ensureLocalLangfuseStarted: () => gate });
		const ctx = ctxOf("/s.jsonl");

		const first = context.handlers.beforeAgentStart(startEvent(), ctx);
		const other = context.handlers.beforeAgentStart(
			startEvent({ prompt: "other" }),
			ctx,
		);
		await vi.waitFor(() =>
			expect(context.rawRecords.length).toBeGreaterThan(0),
		);
		release?.();
		await Promise.all([first, other]);

		expect(promptOf(context.state).userPrompt).toBe("other");
	});

	it("starts one prompt when identical starts queue behind a different pending start", async () => {
		// Waiters resume together once the pending start settles. The first one to
		// run claims the pending-start slot, so the second must see that claim
		// instead of the prompt the awaited start left behind.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let startupCalls = 0;
		const context = setup({
			ensureLocalLangfuseStarted: async () => {
				startupCalls += 1;
				if (startupCalls === 1) await gate;
			},
		});
		const ctx = ctxOf("/s.jsonl");

		const first = context.handlers.beforeAgentStart(
			startEvent({ prompt: "A" }),
			ctx,
		);
		await vi.waitFor(() => expect(startupCalls).toBe(1));
		const duplicates = ["B", "B"].map((prompt) =>
			context.handlers.beforeAgentStart(startEvent({ prompt }), ctx),
		);
		release?.();
		await Promise.all([first, ...duplicates]);

		expect(
			context.rawRecords
				.filter((record) => record.type === "agent_prompt_start")
				.map((record) => record.prompt),
		).toEqual(["A", "B"]);
		expect(context.lf.trace.mock.calls.map(([body]) => body.input)).toEqual([
			"text:A",
			"text:B",
		]);
		expect(promptOf(context.state).userPrompt).toBe("B");
	});

	it("starts distinct prompts queued behind a pending start one after another", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let startupCalls = 0;
		const context = setup({
			ensureLocalLangfuseStarted: async () => {
				startupCalls += 1;
				if (startupCalls === 1) await gate;
			},
		});
		const ctx = ctxOf("/s.jsonl");

		const first = context.handlers.beforeAgentStart(
			startEvent({ prompt: "A" }),
			ctx,
		);
		await vi.waitFor(() => expect(startupCalls).toBe(1));
		const queued = ["B", "C"].map((prompt) =>
			context.handlers.beforeAgentStart(startEvent({ prompt }), ctx),
		);
		const superseded = promptOf(context.state);
		release?.();
		await Promise.all([first, ...queued]);

		expect(
			context.rawRecords
				.filter((record) => record.type === "agent_prompt_start")
				.map((record) => record.prompt),
		).toEqual(["A", "B", "C"]);
		expect(superseded.userPrompt).toBe("A");
		expect(superseded.finalizing).toBe(true);
		expect(promptOf(context.state).userPrompt).toBe("C");
		expect(context.state?.promptStartPromise).toBeUndefined();
	});

	it("does not trace when the prompt was replaced while the local runtime started", async () => {
		const state = makeState();
		const context = setup({
			state,
			ensureLocalLangfuseStarted: async () => {
				state.promptState = SUPERSEDING_PROMPT;
			},
		});

		await context.handlers.beforeAgentStart(startEvent(), ctxOf("/s.jsonl"));

		expect(context.lf.trace).not.toHaveBeenCalled();
		expect(state.promptState?.startSignature).toBe("other");
	});

	it("does not trace when the prompt was replaced while the runtime started", async () => {
		const state = makeState();
		const context = setup({
			state,
			getRuntime: async () => {
				state.promptState = SUPERSEDING_PROMPT;
				return { trace: vi.fn(), span: vi.fn() };
			},
		});

		await context.handlers.beforeAgentStart(startEvent(), ctxOf("/s.jsonl"));

		expect(state.promptState?.startSignature).toBe("other");
	});

	it("records a runtime failure and keeps the prompt without a trace", async () => {
		const { state } = await started({
			getRuntime: async () => {
				throw new Error("runtime unavailable");
			},
		});

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to create trace: runtime unavailable",
		);
		expect(promptOf(state).trace).toBeUndefined();
	});
});

describe("overlapping starts", () => {
	it("does not open an unannounced prompt beside an announced start in progress", async () => {
		const context = setup();
		const ctx = ctxOf("/s.jsonl");

		const announced = context.handlers.beforeAgentStart(startEvent(), ctx);
		const unannounced = context.handlers.agentStart({} as never, ctx);
		await Promise.all([announced, unannounced]);

		const starts = context.rawRecords.filter(
			(r) => r.type === "agent_prompt_start",
		);
		expect(starts).toHaveLength(1);
		expect(promptOf(context.state).userPrompt).toBe("hello");
	});
});

describe("starting a run nobody announced", () => {
	it("creates a prompt that says no user prompt was captured", async () => {
		const context = setup();
		const ctx = ctxOf("/s.jsonl", { getSystemPrompt: () => "SYSTEM" });

		await context.handlers.agentStart({} as never, ctx);

		const prompt = promptOf(context.state);
		expect(prompt.userPrompt).toBe("");
		expect(prompt.systemPrompt).toBe("SYSTEM");
		expect(context.rawRecords[0]).toMatchObject({
			promptSource: "unannounced-agent-run",
			systemPrompt: "SYSTEM",
		});
		expect(context.lf.trace).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					promptSource: "unannounced-agent-run",
				}),
			}),
		);
		expect(prompt.destination).toEqual({
			host: "http://localhost:3100",
			publicKey: "pk-test",
		});
	});

	it("uses an empty system prompt and session fallbacks when the context offers none", async () => {
		const context = setup({ state: makeState({ sessionFile: "/old.jsonl" }) });

		await context.handlers.agentStart({} as never, ctxOf(undefined));

		expect(promptOf(context.state).systemPrompt).toBe("");
		expect(context.state?.sessionFile).toBe("/old.jsonl");
		expect(context.lf.trace).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: undefined,
				metadata: expect.objectContaining({
					sessionFile: "/old.jsonl",
					previousSessionFile: undefined,
				}),
			}),
		);
	});

	it("leaves the session file out of the metadata when the session has none", async () => {
		const context = setup();

		await context.handlers.agentStart({} as never, ctxOf(undefined));
		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.lf.trace).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ sessionFile: undefined }),
			}),
		);
		expect(context.trace.update.mock.calls.at(-1)?.[0].metadata).toMatchObject({
			sessionFile: undefined,
		});
	});

	it.each([
		["tracing and raw traces off", { canTrace: false }, "/s.jsonl"],
		[
			"an unpersisted session that is skipped",
			{ config: { skipUnpersistedSessions: true } },
			undefined,
		],
	])("creates nothing for %s", async (_name, options, file) => {
		const context = setup(options as SetupOptions);

		await context.handlers.agentStart({} as never, ctxOf(file));

		expect(context.state?.promptState).toBeNull();
		expect(context.rawRecords).toEqual([]);
	});

	it("writes only the raw record when tracing is off but raw traces are on", async () => {
		const context = setup({
			canTrace: false,
			config: { rawTraceEnabled: true },
		});

		await context.handlers.agentStart({} as never, ctxOf("/s.jsonl"));

		expect(context.rawRecords).toHaveLength(1);
		expect(context.lf.trace).not.toHaveBeenCalled();
	});

	it("waits for a start that is in progress and does not open a second prompt", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const context = setup({ ensureLocalLangfuseStarted: () => gate });
		const ctx = ctxOf("/s.jsonl");

		const first = context.handlers.agentStart({} as never, ctx);
		const second = context.handlers.agentStart({} as never, ctx);
		await vi.waitFor(() =>
			expect(context.rawRecords.length).toBeGreaterThan(0),
		);
		release?.();
		await Promise.all([first, second]);

		expect(
			context.rawRecords.filter((r) => r.type === "agent_prompt_start"),
		).toHaveLength(1);
	});

	it("does not trace when the prompt is replaced while the runtime starts", async () => {
		const state = makeState();
		const context = setup({
			state,
			ensureLocalLangfuseStarted: async () => {
				state.promptState = SUPERSEDING_PROMPT;
			},
		});

		await context.handlers.agentStart({} as never, ctxOf("/s.jsonl"));

		expect(context.lf.trace).not.toHaveBeenCalled();
	});

	it("does not trace when the prompt is replaced while the runtime resolves", async () => {
		const state = makeState();
		const context = setup({
			state,
			getRuntime: async () => {
				state.promptState = SUPERSEDING_PROMPT;
				return { trace: vi.fn() };
			},
		});

		await context.handlers.agentStart({} as never, ctxOf("/s.jsonl"));

		expect(state.promptState?.startSignature).toBe("other");
	});

	it("records a runtime failure for the unannounced prompt", async () => {
		const context = setup({
			getRuntime: async () => {
				throw new Error("no runtime");
			},
		});

		await context.handlers.agentStart({} as never, ctxOf("/s.jsonl"));

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to create trace: no runtime",
		);
	});
});

describe("agent start on an announced prompt", () => {
	it("ignores a missing session and a finalizing prompt", async () => {
		const none = setup({ state: undefined });
		await none.handlers.agentStart({} as never, ctxOf("/s.jsonl"));
		expect(none.lf.span).not.toHaveBeenCalled();

		const context = await started();
		promptOf(context.state).finalizing = true;
		context.lf.span.mockClear();
		await context.handlers.agentStart({} as never, context.ctx);
		expect(context.lf.span).not.toHaveBeenCalled();
	});

	it("restarts the completed-turn guards when no turn is active", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.completedTurnIndexes.add(0);
		await context.handlers.agentStart({} as never, context.ctx);
		expect(prompt.completedTurnIndexes.size).toBe(0);

		prompt.completedTurnIndexes.add(1);
		prompt.activeTurns.set(1, { index: 1 } as TurnState);
		await context.handlers.agentStart({} as never, context.ctx);
		expect(prompt.completedTurnIndexes.has(1)).toBe(true);
	});

	it("opens the prompt span with the prompt text once", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.promptSpan = undefined;
		context.lf.span.mockClear();

		await context.handlers.agentStart({} as never, context.ctx);
		await context.handlers.agentStart({} as never, context.ctx);

		expect(context.lf.span).toHaveBeenCalledTimes(1);
		expect(context.lf.span).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "agent.prompt",
				input: "text:hello",
				metadata: expect.objectContaining({ cwd: "/work" }),
			}),
		);
	});

	it("opens no span without tracing or a trace", async () => {
		const off = await started({
			canTrace: false,
			config: { rawTraceEnabled: true },
		});
		await off.handlers.agentStart({} as never, off.ctx);
		expect(off.lf.span).not.toHaveBeenCalled();

		const untraced = await started({
			getRuntime: async () => {
				throw new Error("down");
			},
		});
		await untraced.handlers.agentStart({} as never, untraced.ctx);
		expect(untraced.lf.span).not.toHaveBeenCalled();
	});

	it("opens no second span when the prompt already has one, or changed while waiting", async () => {
		const has = await started();
		has.lf.span.mockClear();
		await has.handlers.agentStart({} as never, has.ctx);
		expect(has.lf.span).not.toHaveBeenCalled();

		const state = makeState();
		let swap = false;
		const context = setup({
			state,
			getRuntime: async () => {
				if (swap) state.promptState = SUPERSEDING_PROMPT;
				return {
					trace: () => ({ id: "t", update: vi.fn() }),
					span: vi.fn(() => ({ id: "s" })),
				};
			},
		});
		const ctx = ctxOf("/s.jsonl");
		await context.handlers.beforeAgentStart(startEvent(), ctx);
		const prompt = promptOf(state);
		prompt.promptSpan = undefined;
		swap = true;
		await context.handlers.agentStart({} as never, ctx);
		expect(prompt.promptSpan).toBeUndefined();
	});

	it("records a failure to open the prompt span", async () => {
		const state = makeState();
		let fail = false;
		const span = vi.fn(() => ({ id: "s" }));
		const context = setup({
			state,
			getRuntime: async () => {
				if (fail) throw new Error("span runtime down");
				return { trace: () => ({ id: "t", update: vi.fn() }), span };
			},
		});
		const ctx = ctxOf("/s.jsonl");
		await context.handlers.beforeAgentStart(startEvent(), ctx);
		promptOf(state).promptSpan = undefined;
		fail = true;

		await context.handlers.agentStart({} as never, ctx);

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to create prompt span: span runtime down",
		);
	});
});

describe("agent end and settle", () => {
	const message = (extra: Record<string, unknown> = {}) => ({
		role: "assistant",
		content: [{ type: "text", text: "final" }],
		...extra,
	});
	const end = (messages: unknown) => ({ messages }) as never;

	it("ignores an end for a missing or finalizing prompt", async () => {
		const none = setup({ state: undefined });
		await none.handlers.agentEnd(end([message()]), ctxOf("/s.jsonl"));

		const context = await started();
		const prompt = promptOf(context.state);
		prompt.finalizing = true;
		await context.handlers.agentEnd(end([message()]), context.ctx);
		expect(prompt.lastAssistantText).toBe("");
	});

	it("keeps the last assistant answer as the prompt output", async () => {
		const context = await started();
		const prompt = promptOf(context.state);

		await context.handlers.agentEnd(
			end([
				message(),
				{ role: "user", content: [] },
				message({ content: [{ text: "later" }] }),
			]),
			context.ctx,
		);

		expect(prompt.lastAssistantText).toBe("text:later");
	});

	it("keeps the earlier output when the last answer has no text, and tolerates no messages", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.lastAssistantText = "earlier";

		await context.handlers.agentEnd(
			end([message({ content: [] })]),
			context.ctx,
		);
		await context.handlers.agentEnd({} as never, context.ctx);

		expect(prompt.lastAssistantText).toBe("earlier");
	});

	it("records a failed run, then treats a healthy later run as a recovery", async () => {
		const context = await started();
		const prompt = promptOf(context.state);

		await context.handlers.agentEnd(
			end([message({ stopReason: "error", errorMessage: "overloaded" })]),
			context.ctx,
		);
		expect(prompt.failure).toEqual({
			stopReason: "error",
			errorMessage: "overloaded",
		});

		await context.handlers.agentEnd(
			end([message({ stopReason: "stop" })]),
			context.ctx,
		);
		expect(prompt.failure).toBeUndefined();
		expect(prompt.recoveredFailure).toEqual({
			stopReason: "error",
			errorMessage: "overloaded",
		});
		expect(prompt.recoveredFailureCount).toBe(1);

		await context.handlers.agentEnd(end([message()]), context.ctx);
		expect(prompt.recoveredFailureCount).toBe(1);
	});

	it("does not call a run without an assistant message a recovery", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.failure = { stopReason: "error" };

		await context.handlers.agentEnd(
			end([{ role: "user", content: [] }]),
			context.ctx,
		);

		expect(prompt.failure).toEqual({ stopReason: "error" });
		expect(prompt.recoveredFailureCount).toBe(0);
	});

	it("finalizes once at settle and flushes once, whatever the abort flag says", async () => {
		const context = await started();
		const prompt = promptOf(context.state);

		await context.handlers.agentSettled(
			{ aborted: true } as never,
			context.ctx,
		);
		await context.handlers.agentSettled(
			{ aborted: true } as never,
			context.ctx,
		);

		expect(prompt.failure).toEqual({ stopReason: "aborted" });
		expect(context.deps.flushClient).toHaveBeenCalledTimes(1);
		expect(context.state?.promptState).toBeNull();
	});

	it("keeps an existing failure when the settle reports an abort, and ignores a false flag", async () => {
		const failed = await started();
		const failedPrompt = promptOf(failed.state);
		failedPrompt.failure = { stopReason: "error", errorMessage: "boom" };
		await failed.handlers.agentSettled({ aborted: true } as never, failed.ctx);
		expect(failedPrompt.failure).toEqual({
			stopReason: "error",
			errorMessage: "boom",
		});

		const calm = await started();
		const calmPrompt = promptOf(calm.state);
		await calm.handlers.agentSettled({ aborted: false } as never, calm.ctx);
		expect(calmPrompt.failure).toBeUndefined();
	});

	it("ignores a settle without a prompt or during finalization", async () => {
		const none = setup({ state: undefined });
		await none.handlers.agentSettled({} as never, ctxOf("/s.jsonl"));
		expect(none.deps.flushClient).not.toHaveBeenCalled();

		const context = await started();
		promptOf(context.state).finalizing = true;
		await context.handlers.agentSettled({} as never, context.ctx);
		expect(context.deps.flushClient).not.toHaveBeenCalled();
	});
});

describe("prompt finalization", () => {
	it("ends the trace, sends health scores, and remembers the finalized trace", async () => {
		const context = await started({
			state: makeState({ sessionId: "s1", sessionFile: "/s.jsonl" }),
		});
		const prompt = promptOf(context.state);
		prompt.toolCalls = 4;
		prompt.toolErrors = 1;
		prompt.turns = 2;
		prompt.editWriteCalls = 3;
		prompt.lastToolResult = { toolCallId: "t", isError: true };
		prompt.lastAssistantText = "answer";

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		const scores = Object.fromEntries(
			context.lf.score.mock.calls.map(([score]) => [score.name, score.value]),
		);
		expect(scores).toMatchObject({
			tool_call_count: 4,
			turn_count: 2,
			total_tool_errors: 1,
			tool_success_rate: 0.75,
			session_had_errors: 1,
			edit_write_call_count: 3,
			last_tool_is_error: 1,
		});
		expect(scores).not.toHaveProperty("ask_user_wait_ms");
		expect(context.trace.update.mock.calls.at(-1)?.[0]).toMatchObject({
			output: "answer",
			sessionId: "s1",
			metadata: expect.objectContaining({
				completed: true,
				toolCalls: 4,
				toolErrors: 1,
				sessionFile: "/sessions/--w--/s.jsonl",
			}),
		});
		expect(context.promptSpan.end.mock.calls[0]?.[0]).toMatchObject({
			output: "answer",
		});
		expect(context.state?.lastFinalizedTrace).toEqual({
			traceId: "trace-1",
			destination: { host: "http://localhost:3100", publicKey: "pk-test" },
		});
		expect(context.state?.promptState).toBeNull();
	});

	it("scores a clean prompt with a full tool success rate and no last-tool score", async () => {
		const context = await started();

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		const scores = Object.fromEntries(
			context.lf.score.mock.calls.map(([score]) => [score.name, score.value]),
		);
		expect(scores).toMatchObject({
			tool_success_rate: 1,
			session_had_errors: 0,
			edit_write_call_count: 0,
		});
		expect(scores).not.toHaveProperty("last_tool_is_error");
		expect(context.promptSpan.end.mock.calls[0]?.[0]).toMatchObject({
			isError: undefined,
			statusMessage: undefined,
		});
	});

	it("scores the wait of a fully measured ask flow, and keeps incomplete ones out of the scores", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.askFlows.set("tool:a", {
			flowId: "tool:a",
			toolCallId: "a",
			startedAt: 100,
			completedAt: 350,
		});

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.lf.score).toHaveBeenCalledWith(
			expect.objectContaining({ name: "ask_user_wait_ms", value: 250 }),
		);
		expect(context.trace.update.mock.calls.at(-1)?.[0].metadata).toMatchObject({
			askUserWaitStatus: "measured",
			askUserWaitMs: 250,
		});

		const incomplete = await started();
		promptOf(incomplete.state).askFlows.set("tool:b", {
			flowId: "tool:b",
			toolCallId: "b",
		});
		await incomplete.handlers.finalizePrompt(
			incomplete.state as never,
			incomplete.config,
		);
		expect(
			incomplete.lf.score.mock.calls.some(
				([score]) => score.name === "ask_user_wait_ms",
			),
		).toBe(false);
	});

	it("names a failed prompt and its failure in the span status", async () => {
		const withMessage = await started();
		promptOf(withMessage.state).failure = {
			stopReason: "error",
			errorMessage: "overloaded",
		};
		await withMessage.handlers.finalizePrompt(
			withMessage.state as never,
			withMessage.config,
		);
		expect(withMessage.promptSpan.end.mock.calls[0]?.[0]).toMatchObject({
			isError: true,
			statusMessage: "agent error: overloaded",
			metadata: { failed: true, stopReason: "error" },
		});

		const bare = await started();
		promptOf(bare.state).failure = { stopReason: "aborted" };
		await bare.handlers.finalizePrompt(bare.state as never, bare.config);
		expect(bare.promptSpan.end.mock.calls[0]?.[0]).toMatchObject({
			statusMessage: "agent aborted",
		});
	});

	it("reports a recovered failure and its count", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.recoveredFailure = {
			stopReason: "error",
			errorMessage: "retry worked",
		};
		prompt.recoveredFailureCount = 2;

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.trace.update.mock.calls.at(-1)?.[0].metadata).toMatchObject({
			recoveredFailure: { stopReason: "error", errorMessage: "retry worked" },
			recoveredFailureCount: 2,
			completed: true,
		});
	});

	it.each([
		["an explicit reason", { reason: "config refresh" }, "config refresh"],
		[
			"a recorded reason",
			{ prompt: { abandonmentReason: "turn ended early" } },
			"turn ended early",
		],
		["pending tool work", { tool: true }, "agent finalization"],
		["an unfinished turn", { turn: true }, "agent finalization"],
	])("abandons the prompt for %s", async (_name, scenario, expected) => {
		const context = await started();
		const prompt = promptOf(context.state);
		Object.assign(prompt, (scenario as { prompt?: object }).prompt ?? {});
		if ((scenario as { tool?: boolean }).tool) {
			prompt.activeTools.set("a", {
				toolName: "x",
				startedAt: 0,
				argsSummary: "",
			} as ToolState);
		}
		if ((scenario as { turn?: boolean }).turn) {
			prompt.activeTurns.set(0, {
				index: 0,
				startedAt: Date.now(),
				generations: new Map(),
				generationOrder: [],
			} as unknown as TurnState);
		}

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
			false,
			(scenario as { reason?: string }).reason,
		);

		expect(context.promptSpan.end.mock.calls[0]?.[0]).toMatchObject({
			isError: true,
			statusMessage: `prompt abandoned during ${expected}`,
			metadata: { abandoned: true, abandonmentReason: expected },
		});
	});

	it("closes unfinished turns and abandons running tools", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		const open = {
			index: 0,
			startedAt: Date.now(),
			generations: new Map(),
			generationOrder: [],
			span: { end: vi.fn() },
			spanStartPromise: Promise.resolve(),
		} as unknown as TurnState;
		const closed = {
			index: 1,
			startedAt: Date.now(),
			ended: true,
			generations: new Map(),
			generationOrder: [],
			span: { end: vi.fn() },
		} as unknown as TurnState;
		prompt.activeTurns.set(0, open);
		prompt.activeTurns.set(1, closed);
		prompt.activeTools.set("a", {
			toolName: "x",
			startedAt: 0,
			argsSummary: "",
		} as ToolState);

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.deps.abandonTools).toHaveBeenCalledTimes(1);
		expect(context.deps.abandonTurnGenerations).toHaveBeenCalledTimes(2);
		expect(open.span?.end).toHaveBeenCalledWith(
			expect.objectContaining({ statusMessage: "turn ended during cleanup" }),
		);
		expect(closed.span?.end).not.toHaveBeenCalled();
		expect(prompt.activeTurns.size).toBe(0);
	});

	it("waits for a prompt span that is still starting and ends no span twice", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		let spanStarted = false;
		prompt.promptSpanStartPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				spanStarted = true;
				resolve();
			}, 5);
		});

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(spanStarted).toBe(true);
		expect(context.promptSpan.end).toHaveBeenCalledTimes(1);
	});

	it("does not end a prompt span that already ended, and skips scores without a trace", async () => {
		const context = await started({
			canTrace: false,
			config: { rawTraceEnabled: true },
		});
		const prompt = promptOf(context.state);
		prompt.promptSpanEnded = true;

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.lf.score).not.toHaveBeenCalled();
		expect(context.promptSpan.end).not.toHaveBeenCalled();
		expect(context.state?.lastFinalizedTrace).toBeUndefined();
	});

	it("reports a runtime that cannot send the scores", async () => {
		const state = makeState();
		let fail = false;
		const context = setup({
			state,
			getRuntime: async () => {
				if (fail) throw new Error("score runtime down");
				return {
					trace: () => ({ id: "t", update: vi.fn() }),
					span: () => ({ id: "s", end: vi.fn() }),
					score: vi.fn(),
				};
			},
		});
		await context.handlers.beforeAgentStart(startEvent(), ctxOf("/s.jsonl"));
		fail = true;

		await context.handlers.finalizePrompt(state as never, context.config);

		expect(getLastRuntimeError()?.message).toContain(
			"Failed to send prompt health scores: score runtime down",
		);
	});

	it("finalizes without a configuration: no scores, no redaction metadata, and a plain truncation", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.systemPrompt = "SYSTEM TEXT";

		await context.handlers.finalizePrompt(context.state as never, undefined);

		const update = context.trace.update.mock.calls.at(-1)?.[0];
		expect(update).toMatchObject({
			release: undefined,
			environment: undefined,
			metadata: {
				redaction: undefined,
				systemPrompt: "truncated(2000):SYSTEM TEXT",
			},
		});
		expect(context.lf.score).not.toHaveBeenCalled();
	});

	it("keeps a replacement prompt that took over the session while finalizing", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		const replacement = { startSignature: "other" } as PromptState;
		context.deps.abandonTurnGenerations = vi.fn(async () => {
			if (context.state) context.state.promptState = replacement;
		}) as never;
		prompt.activeTurns.set(0, {
			index: 0,
			startedAt: Date.now(),
			generations: new Map(),
			generationOrder: [],
		} as unknown as TurnState);

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.state?.promptState).toBe(replacement);
		expect(context.state?.lastFinalizedTrace).toBeUndefined();
	});

	it("does nothing for a session without a prompt, and joins a finalization in progress", async () => {
		const none = setup();
		await none.handlers.finalizePrompt(none.state as never, none.config);
		expect(none.promptSpan.end).not.toHaveBeenCalled();

		const context = await started();
		await Promise.all([
			context.handlers.finalizePrompt(
				context.state as never,
				context.config,
				true,
			),
			context.handlers.finalizePrompt(
				context.state as never,
				context.config,
				true,
			),
		]);
		expect(context.promptSpan.end).toHaveBeenCalledTimes(1);
		expect(context.deps.flushClient).toHaveBeenCalledTimes(1);
	});
});

/** A promise the test settles, to hold an asynchronous collaborator in place. */
function gated() {
	let open: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("trace identity of a prompt", () => {
	const IDENTITY_CONFIG = { release: "1.2.3", environment: "staging" };
	const unannouncedStart = async (options: SetupOptions) => {
		const context = setup(options);
		const ctx = ctxOf("/sessions/--w--/s.jsonl");
		await context.handlers.agentStart({} as never, ctx);
		return { ...context, ctx };
	};

	it.each([
		["an announced prompt", (options: SetupOptions) => started(options)],
		["an unannounced run", unannouncedStart],
	])(
		"labels the trace of %s with release, environment, previous session, and TIA",
		async (_name, start) => {
			vi.stubEnv("TIA_ACTIVE", "1");
			vi.stubEnv("TIA_COMMAND", "tia run");
			const context = await start({
				config: IDENTITY_CONFIG,
				state: makeState({ previousSessionFile: "/prev.jsonl" }),
			});

			const [body] = context.lf.trace.mock.calls[0] as unknown as [
				Record<string, unknown>,
			];
			expect(body).toMatchObject({
				release: "1.2.3",
				environment: "staging",
				metadata: {
					previousSessionFile: "/prev.jsonl",
					tiaActive: true,
					tiaCommand: "tia run",
				},
			});
			await context.handlers.finalizePrompt(
				context.state as never,
				context.config,
			);
			expect(context.trace.update.mock.calls.at(-1)?.[0]).toMatchObject({
				release: "1.2.3",
				environment: "staging",
				metadata: {
					previousSessionFile: "/prev.jsonl",
					tiaActive: true,
					tiaCommand: "tia run",
				},
			});
		},
	);

	it.each([
		["an announced prompt", (options: SetupOptions) => started(options)],
		["an unannounced run", unannouncedStart],
	])(
		"leaves release, environment, and TIA out of the trace of %s when none applies",
		async (_name, start) => {
			vi.stubEnv("TIA_ACTIVE", "0");
			vi.stubEnv("TIA_COMMAND", "");
			const context = await start({});

			const [body] = context.lf.trace.mock.calls[0] as unknown as [
				{ release?: string; environment?: string; metadata: object },
			];
			expect(body.release).toBeUndefined();
			expect(body.environment).toBeUndefined();
			expect(body.metadata).toMatchObject({
				tiaActive: false,
				tiaCommand: undefined,
			});
		},
	);
});

describe("a prompt with no activity", () => {
	const ZERO_USAGE = {
		turns: 0,
		toolCalls: 0,
		toolErrors: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		indirectTokensIn: 0,
		indirectTokensOut: 0,
		indirectCacheRead: 0,
		indirectCacheWrite: 0,
	};

	it.each([
		[
			"announced",
			async () => {
				const context = await started();
				return context;
			},
		],
		[
			"unannounced",
			async () => {
				const context = setup();
				await context.handlers.agentStart(
					{} as never,
					ctxOf("/sessions/--w--/s.jsonl"),
				);
				return context;
			},
		],
	])(
		"reports zero usage, no indirect cost, and no recovered failures for an %s prompt",
		async (_name, start) => {
			const context = await start();

			await context.handlers.finalizePrompt(
				context.state as never,
				context.config,
			);

			const metadata = context.trace.update.mock.calls.at(-1)?.[0].metadata;
			expect(metadata).toMatchObject(ZERO_USAGE);
			expect(metadata.indirectCost).toBeUndefined();
			expect(metadata.recoveredFailureCount).toBeUndefined();
			const spanMetadata = context.promptSpan.end.mock.calls[0]?.[0].metadata;
			expect(spanMetadata).toMatchObject({
				turns: 0,
				toolCalls: 0,
				toolErrors: 0,
			});
			expect(spanMetadata.recoveredFailureCount).toBeUndefined();
		},
	);

	it("clears the pending-start slot once an unannounced start completed", async () => {
		const context = setup();

		await context.handlers.agentStart(
			{} as never,
			ctxOf("/sessions/--w--/s.jsonl"),
		);

		expect(context.state?.promptStartPromise).toBeUndefined();
		expect(context.state?.promptStartSignature).toBeUndefined();
	});
});

describe("finalizing a prompt in detail", () => {
	const openTurn = (extra: Record<string, unknown> = {}) =>
		({
			index: 0,
			startedAt: Date.now(),
			generations: new Map([["request-1", {}]]),
			generationOrder: ["request-1"],
			...extra,
		}) as unknown as TurnState;

	it("flushes the client only when asked to", async () => {
		const plain = await started();
		await plain.handlers.finalizePrompt(plain.state as never, plain.config);
		const flushing = await started();
		await flushing.handlers.finalizePrompt(
			flushing.state as never,
			flushing.config,
			true,
		);

		expect(plain.deps.flushClient).not.toHaveBeenCalled();
		expect(flushing.deps.flushClient).toHaveBeenCalledTimes(1);
	});

	it("abandons tools only when some are active", async () => {
		const context = await started();

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.deps.abandonTools).not.toHaveBeenCalled();
	});

	it("waits for a turn span that is still starting, then ends and clears the turn", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(5_000);
		const context = await started();
		const prompt = promptOf(context.state);
		const end = vi.fn();
		const turn = openTurn({ startedAt: 4_000 });
		turn.spanStartPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				turn.span = { id: "turn-span", traceId: "trace-1", end };
				resolve();
			}, 20);
		});
		prompt.activeTurns.set(0, turn);

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
			false,
			"session shutdown",
		);

		expect(end).toHaveBeenCalledWith(
			expect.objectContaining({
				isError: true,
				metadata: expect.objectContaining({
					turnIndex: 0,
					durationMs: 1_000,
					abandoned: true,
					abandonmentReason: "session shutdown",
				}),
			}),
		);
		expect(turn.ended).toBe(true);
		expect(turn.generations.size).toBe(0);
		expect(turn.generationOrder).toEqual([]);
	});

	it("keeps the announced system prompt for the final trace update", async () => {
		const context = await started();

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.trace.update.mock.calls.at(-1)?.[0].metadata).toMatchObject({
			systemPrompt: "text:SYS",
		});
	});

	it("reports the elapsed time on the trace and the prompt span", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(10_000);
		const context = await started();
		vi.setSystemTime(10_250);

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
		);

		expect(context.trace.update.mock.calls.at(-1)?.[0].metadata).toMatchObject({
			durationMs: 250,
		});
		expect(context.promptSpan.end.mock.calls[0]?.[0].metadata).toMatchObject({
			durationMs: 250,
		});
	});

	it("marks an abandoned prompt on the trace and records that its span ended", async () => {
		const context = await started();
		const prompt = promptOf(context.state);
		prompt.recoveredFailureCount = 3;

		await context.handlers.finalizePrompt(
			context.state as never,
			context.config,
			false,
			"session shutdown",
		);

		expect(context.trace.update.mock.calls.at(-1)?.[0].metadata).toMatchObject({
			abandoned: true,
			completed: false,
			abandonmentReason: "session shutdown",
		});
		expect(context.promptSpan.end.mock.calls[0]?.[0].metadata).toMatchObject({
			recoveredFailureCount: 3,
		});
		expect(prompt.promptSpanEnded).toBe(true);
	});
});

describe("overlapping starts and finalization", () => {
	it("starts no prompt for a waiter whose identical start was finalized meanwhile", async () => {
		let finalizeOnce: () => Promise<void> = async () => undefined;
		const context = setup({
			ensureLocalLangfuseStarted: () => finalizeOnce(),
		});
		const ctx = ctxOf("/s.jsonl");
		let finalized = false;
		finalizeOnce = async () => {
			if (finalized) return;
			finalized = true;
			await context.handlers.finalizePrompt(
				context.state as never,
				context.config,
				false,
				"session shutdown",
			);
		};

		// Both starts are announced before either has a prompt, so the second
		// waits for the first; the first prompt is finalized while it starts.
		const first = context.handlers.beforeAgentStart(startEvent(), ctx);
		const waiter = context.handlers.beforeAgentStart(startEvent(), ctx);
		await Promise.all([first, waiter]);

		expect(
			context.rawRecords.filter(
				(record) => record.type === "agent_prompt_start",
			),
		).toHaveLength(1);
		expect(context.state?.promptState).toBeNull();
	});

	it("does not flush the client when a new prompt replaces the previous one", async () => {
		const context = await started();

		await context.handlers.beforeAgentStart(
			startEvent({ prompt: "second" }),
			context.ctx,
		);

		expect(context.deps.flushClient).not.toHaveBeenCalled();
	});
});

describe("agent start while the runtime resolves", () => {
	it.each([
		["has its span", true],
		["lost its span when the runtime failed at the start", false],
	])(
		"opens no span and ends none twice when agent start overlaps the finalization of a prompt that %s",
		async (_name, spanOpened) => {
			// Finalization is held while it sends the prompt scores, which is after
			// the prompt began finalizing and before its span ends. Agent start then
			// arrives for the same prompt; the span it would open on a live prompt
			// must not appear, and the span the prompt has ends exactly once.
			const state = makeState();
			const gate = gated();
			let hold = false;
			const promptSpan = { id: "s", end: vi.fn() };
			const span = vi.fn(() => {
				if (!spanOpened) throw new Error("span creation failed");
				return promptSpan;
			});
			const context = setup({
				state,
				getRuntime: async () => {
					if (hold) await gate.promise;
					return {
						trace: () => ({ id: "t", update: vi.fn() }),
						span,
						score: vi.fn(),
					};
				},
			});
			const ctx = ctxOf("/s.jsonl");
			await context.handlers.beforeAgentStart(startEvent(), ctx);
			expect(span).toHaveBeenCalledTimes(1);
			hold = true;

			const finalizing = context.handlers.finalizePrompt(
				state as never,
				context.config,
			);
			const starting = context.handlers.agentStart({} as never, ctx);
			gate.open();
			await Promise.all([starting, finalizing]);

			expect(span).toHaveBeenCalledTimes(1);
			expect(promptSpan.end).toHaveBeenCalledTimes(spanOpened ? 1 : 0);
			expect(state.promptState).toBeNull();
		},
	);

	it("opens no span once tracing was switched off after the prompt started", async () => {
		const context = await started();
		promptOf(context.state).promptSpan = undefined;
		context.lf.span.mockClear();
		context.deps.canTrace = () => false;

		await context.handlers.agentStart({} as never, context.ctx);

		expect(context.lf.span).not.toHaveBeenCalled();
	});

	it("opens no span for a prompt that began finalizing while the runtime resolved", async () => {
		const state = makeState();
		const gate = gated();
		let hold = false;
		const span = vi.fn(() => ({ id: "s", end: vi.fn() }));
		const context = setup({
			state,
			getRuntime: async () => {
				if (hold) await gate.promise;
				return { trace: () => ({ id: "t", update: vi.fn() }), span };
			},
		});
		const ctx = ctxOf("/s.jsonl");
		await context.handlers.beforeAgentStart(startEvent(), ctx);
		const prompt = promptOf(state);
		prompt.promptSpan = undefined;
		span.mockClear();
		hold = true;

		const starting = context.handlers.agentStart({} as never, ctx);
		prompt.finalizing = true;
		gate.open();
		await starting;

		expect(span).not.toHaveBeenCalled();
		expect(prompt.promptSpan).toBeUndefined();
	});
});
