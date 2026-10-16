import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
	createGenerationLifecycleHandlers,
	type GenerationLifecycleDependencies,
} from "./generation-lifecycle.js";
import type { PromptState, TurnState } from "./lifecycle-types.js";
import { redactionMetadata } from "./redaction.js";
import { getLastRuntimeError } from "./runtime-diagnostics.js";
import type { SessionState } from "./session-state.js";
import {
	costDetailsFromUsage,
	estimateJsonBytes,
	safeJson,
	standardUsageFromUsage,
	summarizeMessages,
	summarizeProviderPayload,
	summarizeRawProviderRequestContents,
	telemetryText,
	usageDetailsFromUsage,
} from "./telemetry-helpers.js";

const config: Config = {
	enabled: true,
	publicKey: "pk-lf-test",
	secretKey: "sk-lf-test",
	host: "http://localhost:3100",
	userId: "tester",
	defaultTags: [],
	release: "",
	environment: "",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: true,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: [],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

interface RecordedGeneration {
	body: Record<string, unknown>;
	ended: Record<string, unknown> | undefined;
}

/** A promise settled by the test, to hold the runtime at a chosen moment. */
function deferred() {
	let resolve: () => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHarness(
	options: {
		captureMessageUpdates?: boolean;
		hasTrace?: boolean;
		additionalSecrets?: string[];
		traceOutputMaxChars?: number;
		/** Every `getRuntime` call waits for this promise; a rejection fails it. */
		runtimeGate?: Promise<void>;
		/** The Langfuse generation handle throws this from `end`. */
		endError?: Error;
		/**
		 * Like the client facade, ignore updates that arrive after `end`
		 * (see `langfuse-client.ts`).
		 */
		dropUpdatesAfterEnd?: boolean;
		turnSpanId?: string;
		promptSpanId?: string;
		/** The model the Pi session reports; default "session-model". */
		sessionModel?: string;
		/** Whether tracing is on; default true. */
		tracing?: boolean;
	} = {},
) {
	const testConfig: Config = {
		...config,
		captureMessageUpdates:
			options.captureMessageUpdates ?? config.captureMessageUpdates,
		redactionAdditionalSecrets:
			options.additionalSecrets ?? config.redactionAdditionalSecrets,
		traceOutputMaxChars:
			options.traceOutputMaxChars ?? config.traceOutputMaxChars,
	};
	const generations: RecordedGeneration[] = [];
	const endCalls: Array<Record<string, unknown>> = [];
	const scores: Array<Record<string, unknown>> = [];
	const rawRecords: Array<Record<string, unknown>> = [];
	const runtime = {
		generation: (body: Record<string, unknown>) => {
			const record: RecordedGeneration = { body, ended: undefined };
			generations.push(record);
			return {
				id: "gen-1",
				update: (update: Record<string, unknown>) => {
					if (options.dropUpdatesAfterEnd && record.ended) return;
					record.body = { ...record.body, ...update };
				},
				end: (endBody: Record<string, unknown>) => {
					endCalls.push(endBody);
					if (options.endError) throw options.endError;
					record.ended = endBody;
				},
			};
		},
		score: (score: Record<string, unknown>) => {
			scores.push(score);
		},
	};
	const turn: TurnState = {
		index: 0,
		startedAt: Date.now(),
		generations: new Map(),
		generationOrder: [],
		nextGenerationIndex: 0,
		inputMessages: [],
		inputAttached: false,
		span: options.turnSpanId
			? { id: options.turnSpanId, traceId: "trace-1", end: () => undefined }
			: undefined,
	};
	const prompt: PromptState = {
		trace:
			options.hasTrace === false
				? undefined
				: ({ id: "trace-1" } as PromptState["trace"]),
		userPrompt: "PROMPT-original question",
		systemPrompt: "",
		cwd: "/tmp/work",
		startedAt: Date.now(),
		toolCalls: 0,
		toolErrors: 0,
		editWriteCalls: 0,
		askFlows: new Map(),
		ambiguousAskFlowIds: new Set(),
		turns: 1,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		indirectTokensIn: 0,
		indirectTokensOut: 0,
		indirectCacheRead: 0,
		indirectCacheWrite: 0,
		indirectCost: 0,
		countedCompactions: new Set(),
		recoveredFailureCount: 0,
		lastAssistantText: "",
		startSignature: "sig",
		pendingTurnInput: [],
		activeTurns: new Map([[0, turn]]),
		activeTools: new Map(),
		completedTurnIndexes: new Set(),
		promptSpan: options.promptSpanId
			? { id: options.promptSpanId, traceId: "trace-1", end: () => undefined }
			: undefined,
	};
	const state = {
		sessionId: "session-1",
		sessionFile: "/tmp/pi-agent/sessions/--work--/session.jsonl",
		previousSessionFile: "",
		sessionReason: "startup",
		model: options.sessionModel ?? "session-model",
		provider: "session-provider",
		promptState: prompt,
		compactCount: 0,
		lease: Symbol("test"),
	} as unknown as SessionState<PromptState>;
	const handlers = createGenerationLifecycleHandlers({
		getConfig: () => testConfig,
		getSessionState: () => state,
		canTrace: () => options.tracing ?? true,
		getRuntime: (async () => {
			await options.runtimeGate;
			return runtime;
		}) as unknown as GenerationLifecycleDependencies["getRuntime"],
		telemetryText,
		redactionMetadata,
		standardUsageFromUsage,
		usageDetailsFromUsage,
		costDetailsFromUsage,
		summarizeMessages,
		summarizeProviderPayload,
		summarizeRawProviderRequestContents,
		safeJson,
		estimateJsonBytes,
		writeRawTrace: (_config, _state, record) => rawRecords.push(record),
	});
	const ctx = {} as never;
	return {
		handlers,
		generations,
		endCalls,
		scores,
		prompt,
		state,
		turn,
		rawRecords,
		ctx,
	};
}

describe("generation input provenance", () => {
	// The context event is system-free and arrives before request transforms;
	// the generation input must describe the observed provider request instead
	// (audit #2), with the fallback clearly marked as context-derived.
	it("records generation input from the observed provider payload", async () => {
		const { handlers, generations, ctx } = createHarness();
		await handlers.context(
			{
				messages: [{ role: "user", content: "CTX-stale question" }],
			} as never,
			ctx,
		);
		await handlers.beforeProviderRequest(
			{
				payload: {
					model: "gemini-3.2-pro",
					contents: [
						{ role: "user", parts: [{ text: "WIRE-transformed question" }] },
					],
					config: { systemInstruction: "WIRE-system instruction" },
				},
			} as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			} as never,
			ctx,
		);

		expect(generations).toHaveLength(1);
		const input = JSON.stringify(generations[0]?.body.input);
		expect(input).toContain("WIRE-transformed question");
		expect(input).toContain("WIRE-system instruction");
		expect(input).not.toContain("CTX-stale question");
		expect(generations[0]?.body.metadata).toMatchObject({
			requestSource: "payload.contents",
		});
	});

	it("records generation input from observed chat messages", async () => {
		const { handlers, generations, ctx } = createHarness();
		await handlers.context(
			{ messages: [{ role: "user", content: "CTX-stale question" }] } as never,
			ctx,
		);
		await handlers.beforeProviderRequest(
			{
				payload: {
					model: "chat-model",
					messages: [
						{ role: "system", content: "WIRE-system prompt" },
						{ role: "user", content: "WIRE-chat question" },
					],
				},
			} as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		const input = JSON.stringify(generations[0]?.body.input);
		expect(input).toContain("WIRE-system prompt");
		expect(input).toContain("WIRE-chat question");
		expect(input).not.toContain("CTX-stale question");
		expect(generations[0]?.body.metadata).toMatchObject({
			requestSource: "payload.messages",
		});
	});

	it("includes the Anthropic top-level system prompt in generation input", async () => {
		const { handlers, generations, ctx } = createHarness();
		await handlers.context(
			{ messages: [{ role: "user", content: "CTX-stale question" }] } as never,
			ctx,
		);
		await handlers.beforeProviderRequest(
			{
				payload: {
					model: "claude-fable-5",
					system: [{ type: "text", text: "WIRE-Anthropic system prompt" }],
					messages: [{ role: "user", content: "WIRE-Anthropic question" }],
				},
			} as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		const input = JSON.stringify(generations[0]?.body.input);
		expect(input).toContain("WIRE-Anthropic system prompt");
		expect(input).toContain("WIRE-Anthropic question");
		expect(input).not.toContain("CTX-stale question");
		expect(generations[0]?.body.metadata).toMatchObject({
			requestSource: "payload.messages",
		});
	});

	it("renders pi system message sections into generation input", async () => {
		const { handlers, generations, ctx } = createHarness();
		await handlers.context(
			{ messages: [{ role: "user", content: "CTX-stale question" }] } as never,
			ctx,
		);
		await handlers.beforeProviderRequest(
			{
				payload: {
					model: "probe-model",
					context: {
						messages: [
							{
								role: "system",
								content: "",
								sections: { preamble: "WIRE-pi sections preamble" },
							},
							{ role: "user", content: "WIRE-pi question" },
						],
					},
					options: {},
				},
			} as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		const input = JSON.stringify(generations[0]?.body.input);
		expect(input).toContain("WIRE-pi sections preamble");
		expect(input).toContain("WIRE-pi question");
		expect(generations[0]?.body.metadata).toMatchObject({
			requestSource: "payload.context",
		});
	});

	it("marks context-derived input when the payload carries no contents", async () => {
		const { handlers, generations, ctx } = createHarness();
		await handlers.context(
			{
				messages: [{ role: "user", content: "CTX-context question" }],
			} as never,
			ctx,
		);
		await handlers.beforeProviderRequest(
			{ payload: { model: "chat-model", temperature: 0.3 } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		const input = JSON.stringify(generations[0]?.body.input);
		expect(input).toContain("CTX-context question");
		expect(generations[0]?.body.metadata).toMatchObject({
			requestSource: "context",
		});
	});
});

describe("assistant output projection", () => {
	it("uses final answer text or only the streamed text fallback, with separate thinking and tool calls", async () => {
		const { handlers, generations, prompt, rawRecords, ctx } = createHarness();
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageUpdate(
			{
				message: { role: "assistant", content: [] },
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "stream-only private thought",
				},
			},
			ctx,
		);
		await handlers.messageUpdate(
			{
				message: { role: "assistant", content: [] },
				assistantMessageEvent: {
					type: "text_delta",
					delta: "stream-only answer",
				},
			},
			ctx,
		);
		await handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "final visible thought",
							thinkingSignature: "OPAQUE-THINKING-SIGNATURE",
						},
						{
							type: "toolCall",
							id: "call-42",
							name: "bash",
							arguments: { command: "echo safe" },
							thoughtSignature: "OPAQUE-TOOL-SIGNATURE",
						},
					],
					stopReason: "toolUse",
					usage: { input: 3, output: 2, totalTokens: 5 },
				},
			} as never,
			ctx,
		);

		expect(generations[0]?.ended?.output).toEqual({
			text: "stream-only answer",
			tool_calls: [
				{
					id: "call-42",
					name: "bash",
					arguments: { command: "echo safe" },
				},
			],
			thinking: "final visible thought",
		});
		expect(generations[0]?.ended?.metadata).toMatchObject({
			hasThinking: true,
		});
		expect(generations[0]?.ended?.metadata).not.toHaveProperty("thinking");
		expect(prompt.lastAssistantText).toBe("stream-only answer");
		expect(rawRecords.at(-1)).toMatchObject({
			type: "assistant_output",
			text: "stream-only answer",
			thinking: "final visible thought",
			toolCalls: [
				{
					id: "call-42",
					name: "bash",
					arguments: { command: "echo safe" },
				},
			],
			stopReason: "toolUse",
		});
		expect(JSON.stringify(rawRecords.at(-1))).not.toContain(
			"OPAQUE-THINKING-SIGNATURE",
		);
		expect(JSON.stringify(rawRecords.at(-1))).not.toContain(
			"OPAQUE-TOOL-SIGNATURE",
		);
	});

	it("keeps thinking and tool calls without inventing answer text", async () => {
		const { handlers, generations, prompt, rawRecords, ctx } = createHarness();
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "tool-only thought" },
						{
							type: "toolCall",
							id: "call-only",
							name: "read",
							arguments: { path: "/tmp/read-only" },
						},
					],
				},
			} as never,
			ctx,
		);

		expect(generations[0]?.ended?.output).toEqual({
			text: "",
			tool_calls: [
				{
					id: "call-only",
					name: "read",
					arguments: { path: "/tmp/read-only" },
				},
			],
			thinking: "tool-only thought",
		});
		expect(prompt.lastAssistantText).toBe("");
		expect(rawRecords.at(-1)).toMatchObject({
			text: "",
			thinking: "tool-only thought",
			toolCalls: [{ id: "call-only", name: "read" }],
		});
	});

	it("keeps answer, thinking, and tool calls separate when final content has all three", async () => {
		const { handlers, generations, prompt, rawRecords, ctx } = createHarness();
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "distinct plan" },
						{ type: "text", text: "distinct answer" },
						{
							type: "toolCall",
							id: "call-43",
							name: "read",
							arguments: { path: "/tmp/file" },
						},
					],
					usage: { input: 2, output: 2, totalTokens: 4 },
				},
			} as never,
			ctx,
		);

		expect(generations[0]?.ended?.output).toEqual({
			text: "distinct answer",
			tool_calls: [
				{
					id: "call-43",
					name: "read",
					arguments: { path: "/tmp/file" },
				},
			],
			thinking: "distinct plan",
		});
		expect(prompt.lastAssistantText).toBe("distinct answer");
		expect(rawRecords.at(-1)).toMatchObject({
			text: "distinct answer",
			thinking: "distinct plan",
			toolCalls: [{ id: "call-43", name: "read" }],
		});
	});

	it("retains the configured answer-text limit for structured generation output", async () => {
		const { handlers, generations, prompt, rawRecords, ctx } = createHarness({
			traceOutputMaxChars: 8,
		});
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		await handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "123456789012" }],
				},
			} as never,
			ctx,
		);

		expect(generations[0]?.ended?.output).toMatchObject({
			text: "12345678…",
		});
		expect(prompt.lastAssistantText).toBe("12345678…");
		expect(rawRecords.at(-1)?.text).toBe("123456789012");
	});

	it("captures final thinking in raw-only mode without a generation or deltas", async () => {
		const { handlers, generations, prompt, rawRecords, ctx } = createHarness({
			hasTrace: false,
		});
		await handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "raw-only final thought" },
						{ type: "text", text: "raw-only answer" },
					],
				},
			} as never,
			ctx,
		);

		expect(generations).toHaveLength(0);
		expect(prompt.lastAssistantText).toBe("raw-only answer");
		expect(rawRecords.at(-1)).toMatchObject({
			type: "assistant_output",
			text: "raw-only answer",
			thinking: "raw-only final thought",
		});
	});

	it("keeps text-only output structured and emits structured partial output before abandonment", async () => {
		const textOnly = createHarness();
		await textOnly.handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			textOnly.ctx,
		);
		await textOnly.handlers.messageEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ordinary answer" }],
				},
			} as never,
			textOnly.ctx,
		);
		expect(textOnly.generations[0]?.ended?.output).toEqual({
			text: "ordinary answer",
			tool_calls: [],
		});

		const partial = createHarness({ captureMessageUpdates: true });
		await partial.handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			partial.ctx,
		);
		await partial.handlers.messageStart(
			{ message: { role: "assistant" } },
			partial.ctx,
		);
		await partial.handlers.messageUpdate(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "partial plan" },
						{ type: "text", text: "partial answer" },
						{
							type: "toolCall",
							id: "call-partial",
							name: "read",
							arguments: { path: "/tmp/partial" },
						},
					],
				},
				assistantMessageEvent: {
					type: "text_delta",
					delta: "partial answer",
				},
			},
			partial.ctx,
		);
		await partial.handlers.abandonTurn(partial.turn);

		expect(partial.generations[0]?.body.output).toEqual({
			text: "partial answer",
			tool_calls: [
				{
					id: "call-partial",
					name: "read",
					arguments: { path: "/tmp/partial" },
				},
			],
			thinking: "partial plan",
		});
		expect(partial.generations[0]?.ended?.metadata).toMatchObject({
			abandoned: true,
		});
	});

	it("attaches only newly delivered incoming messages to the next request turn", async () => {
		const { handlers, prompt, turn, ctx } = createHarness();
		const firstUpdates: Array<Record<string, unknown>> = [];
		turn.span = {
			update: (body: Record<string, unknown>) => firstUpdates.push(body),
		} as never;
		const originalUser = {
			role: "user",
			content: [{ type: "text", text: "FIRST-user-message" }],
		};
		const originalCustom = {
			role: "custom",
			content: "FIRST-custom-message",
		};
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-before-next-turn",
			content: [{ type: "text", text: "NEXT-prior-tool-result" }],
		};

		await handlers.messageEnd({ message: originalUser }, ctx);
		await handlers.messageEnd({ message: originalCustom }, ctx);
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		await handlers.beforeProviderRequest(
			{ payload: { model: "retry-model" } } as never,
			ctx,
		);
		expect(firstUpdates.find((update) => "input" in update)?.input).toEqual([
			originalUser,
			originalCustom,
		]);
		expect(firstUpdates.filter((update) => "input" in update)).toHaveLength(1);
		expect(originalUser).toEqual({
			role: "user",
			content: [{ type: "text", text: "FIRST-user-message" }],
		});
		expect(originalCustom).toEqual({
			role: "custom",
			content: "FIRST-custom-message",
		});

		await handlers.messageEnd({ message: toolResult }, ctx);
		const secondTurn: TurnState = {
			index: 1,
			startedAt: Date.now(),
			generations: new Map(),
			generationOrder: [],
			nextGenerationIndex: 0,
			inputMessages: [],
			inputAttached: false,
		};
		const secondUpdates: Array<Record<string, unknown>> = [];
		secondTurn.span = {
			update: (body: Record<string, unknown>) => secondUpdates.push(body),
		} as never;
		prompt.activeTurns.clear();
		prompt.activeTurns.set(1, secondTurn);
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);

		const secondInputUpdate = secondUpdates.find((update) => "input" in update);
		expect(secondInputUpdate?.input).toEqual([toolResult]);
		expect(secondInputUpdate?.input).not.toContain(originalUser);
		expect(toolResult).toEqual({
			role: "toolResult",
			toolCallId: "call-before-next-turn",
			content: [{ type: "text", text: "NEXT-prior-tool-result" }],
		});
	});
});

describe("raw provider request summary bounds", () => {
	it("compacts 55 long messages within a UTF-8 budget and reports omitted counts", async () => {
		const { handlers, rawRecords, ctx } = createHarness();
		const messages = Array.from({ length: 55 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message-${index}: ${"ordinary context content ".repeat(40)}`,
		}));
		const capturedBytes = estimateJsonBytes(messages);
		await handlers.beforeProviderRequest(
			{
				payload: {
					model: "summary-model",
					messages,
				},
			} as never,
			ctx,
		);

		const record = rawRecords.find(
			(candidate) => candidate.type === "provider_request",
		);
		if (!record) throw new Error("provider request summary was not recorded");
		const summary = record.messagesSummary as Array<{
			role: string;
			content: string;
		}>;
		const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf-8");
		expect(record.estimatedBytes).toBe(capturedBytes);
		expect(summaryBytes).toBeLessThanOrEqual(4096);
		expect(summaryBytes).toBeLessThan(capturedBytes ?? Infinity);
		expect(record.messagesSummaryOmitted).toBeGreaterThan(0);
		expect(summary[0]?.content).toContain("omitted");
		for (const message of summary.slice(1)) {
			expect(message.content.length).toBeLessThanOrEqual(200);
		}
	});

	it("keeps the separate system instruction outside the raw messages summary", async () => {
		const { handlers, rawRecords, ctx } = createHarness();
		await handlers.beforeProviderRequest(
			{
				payload: {
					model: "anthropic-model",
					system: [
						{ type: "text", text: "SEPARATE-ANTHROPIC-SYSTEM-INSTRUCTION" },
					],
					messages: [{ role: "user", content: "request message" }],
				},
			} as never,
			ctx,
		);
		const record = rawRecords.find(
			(candidate) => candidate.type === "provider_request",
		);
		if (!record) throw new Error("provider request summary was not recorded");
		expect(record.systemPrompt).toContain(
			"SEPARATE-ANTHROPIC-SYSTEM-INSTRUCTION",
		);
		expect(JSON.stringify(record.messagesSummary)).not.toContain(
			"SEPARATE-ANTHROPIC-SYSTEM-INSTRUCTION",
		);
	});

	it("bounds Unicode and redaction-expanded summaries across provider and context fallbacks", async () => {
		const unicodeHarness = createHarness();
		const unicodeMessages = Array.from({ length: 55 }, (_, index) => ({
			role: "user",
			content: `unicode-${index}: ${"界🙂".repeat(150)}`,
		}));
		await unicodeHarness.handlers.beforeProviderRequest(
			{
				payload: {
					model: "unicode-model",
					messages: unicodeMessages,
				},
			} as never,
			unicodeHarness.ctx,
		);
		const unicodeRecord = unicodeHarness.rawRecords.find(
			(candidate) => candidate.type === "provider_request",
		);
		if (!unicodeRecord)
			throw new Error("Unicode provider request summary was not recorded");
		const unicodeSummary = unicodeRecord.messagesSummary as Array<{
			content: string;
		}>;
		expect(
			Buffer.byteLength(JSON.stringify(unicodeSummary), "utf-8"),
		).toBeLessThanOrEqual(4096);
		expect(
			unicodeSummary
				.filter((message) => !message.content.includes("omitted"))
				.every((message) => Array.from(message.content).length <= 200),
		).toBe(true);
		expect(
			unicodeSummary.every((message) =>
				Array.from(message.content).every((character) => {
					const codePoint = character.codePointAt(0);
					return (
						codePoint === undefined || codePoint < 0xd800 || codePoint > 0xdfff
					);
				}),
			),
		).toBe(true);

		const fallbackHarness = createHarness({
			additionalSecrets: ["MATCH-RAW-SUMMARY-SECRET"],
		});
		const fallbackMessages = [
			{
				role: "user",
				content: `configured secret MATCH-RAW-SUMMARY-SECRET ${"fallback text ".repeat(60)}`,
			},
		];
		await fallbackHarness.handlers.context(
			{ messages: fallbackMessages } as never,
			fallbackHarness.ctx,
		);
		await fallbackHarness.handlers.beforeProviderRequest(
			{
				payload: {
					model: "fallback-model",
					temperature: 0.1,
				},
			} as never,
			fallbackHarness.ctx,
		);
		const fallbackRecord = fallbackHarness.rawRecords.find(
			(candidate) => candidate.type === "provider_request",
		);
		if (!fallbackRecord)
			throw new Error("context fallback summary was not recorded");
		expect(fallbackRecord.requestSource).toBe("context");
		expect(fallbackRecord.estimatedBytes).toBeUndefined();
		expect(fallbackRecord.messagesSummaryOmitted).toBe(0);
		expect(
			Buffer.byteLength(
				JSON.stringify(fallbackRecord.messagesSummary),
				"utf-8",
			),
		).toBeLessThanOrEqual(4096);
		expect(JSON.stringify(fallbackRecord.messagesSummary)).not.toContain(
			"MATCH-RAW-SUMMARY-SECRET",
		);
	});

	it("bounds each recognized provider contents shape and leaves tiny or empty input intact", async () => {
		const payloads = [
			{
				payload: {
					model: "google-model",
					contents: [{ role: "user", parts: [{ text: "GOOGLE-RAW-SUMMARY" }] }],
				},
				marker: "GOOGLE-RAW-SUMMARY",
			},
			{
				payload: {
					model: "responses-model",
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "RESPONSES-RAW-SUMMARY" }],
						},
					],
				},
				marker: "RESPONSES-RAW-SUMMARY",
			},
			{
				payload: { model: "responses-text-model", input: "TEXT-RAW-SUMMARY" },
				marker: "TEXT-RAW-SUMMARY",
			},
			{
				payload: {
					model: "pi-context-model",
					context: {
						messages: [{ role: "user", content: "PI-CONTEXT-RAW-SUMMARY" }],
					},
				},
				marker: "PI-CONTEXT-RAW-SUMMARY",
			},
		];
		for (const item of payloads) {
			const harness = createHarness();
			await harness.handlers.beforeProviderRequest(
				{ payload: item.payload } as never,
				harness.ctx,
			);
			const record = harness.rawRecords.find(
				(candidate) => candidate.type === "provider_request",
			);
			if (!record)
				throw new Error("recognized provider request summary was not recorded");
			expect(record.requestSource).toMatch(/^payload\./);
			expect(JSON.stringify(record.messagesSummary)).toContain(item.marker);
			expect(
				Buffer.byteLength(JSON.stringify(record.messagesSummary), "utf-8"),
			).toBeLessThanOrEqual(4096);
		}

		const empty = createHarness();
		await empty.handlers.beforeProviderRequest(
			{ payload: { model: "empty-model", messages: [] } } as never,
			empty.ctx,
		);
		const emptyRecord = empty.rawRecords.find(
			(candidate) => candidate.type === "provider_request",
		);
		if (!emptyRecord)
			throw new Error("empty provider summary was not recorded");
		expect(emptyRecord.messagesSummary).toEqual([]);
		expect(emptyRecord.messagesSummaryOmitted).toBe(0);

		const tiny = createHarness();
		await tiny.handlers.beforeProviderRequest(
			{
				payload: {
					model: "tiny-model",
					messages: [{ role: "user", content: "tiny" }],
				},
			} as never,
			tiny.ctx,
		);
		const tinyRecord = tiny.rawRecords.find(
			(candidate) => candidate.type === "provider_request",
		);
		if (!tinyRecord) throw new Error("tiny provider summary was not recorded");
		expect(tinyRecord.messagesSummary).toEqual([
			{ role: "user", content: "tiny" },
		]);
	});
});

describe("generation streaming and failure edges", () => {
	async function openGeneration(
		options: Parameters<typeof createHarness>[0] = {},
	) {
		const harness = createHarness(options);
		await harness.handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			harness.ctx,
		);
		await harness.handlers.messageStart(
			{ message: { role: "assistant" } },
			harness.ctx,
		);
		return harness;
	}

	const update = (assistantMessageEvent: unknown) =>
		({
			message: { role: "assistant", content: [] },
			assistantMessageEvent,
		}) as never;

	it("ends the generation as an error when the provider stream reports one", async () => {
		const { handlers, generations, ctx } = await openGeneration();

		await handlers.messageUpdate(
			update({ type: "error", reason: "overloaded" }),
			ctx,
		);

		expect(generations[0]?.ended).toMatchObject({
			isError: true,
			statusMessage: "overloaded",
			metadata: { providerError: true },
		});
	});

	it("names a provider stream error that gives no reason", async () => {
		const { handlers, generations, ctx } = await openGeneration();

		await handlers.messageUpdate(update({ type: "error" }), ctx);

		expect(generations[0]?.ended).toMatchObject({
			isError: true,
			statusMessage: "provider response failed",
		});
	});

	it.each(["text_delta", "thinking_delta"])(
		"treats a %s without a delta as empty text",
		async (type) => {
			const { handlers, generations, ctx } = await openGeneration();

			await handlers.messageUpdate(update({ type }), ctx);
			await handlers.messageEnd(
				{ message: { role: "assistant", content: [] } } as never,
				ctx,
			);

			expect(generations[0]?.ended?.output).toEqual({
				text: "",
				tool_calls: [],
			});
		},
	);

	it("ignores updates that are not assistant events for a live generation", async () => {
		const { handlers, generations, prompt, ctx } = await openGeneration();

		await handlers.messageUpdate(
			{
				message: { role: "user", content: "hello" },
				assistantMessageEvent: { type: "error", reason: "ignored" },
			} as never,
			ctx,
		);
		await handlers.messageUpdate(
			{ message: { role: "assistant", content: [] } } as never,
			ctx,
		);
		prompt.finalizing = true;
		await handlers.messageUpdate(
			update({ type: "error", reason: "ignored" }),
			ctx,
		);

		expect(generations[0]?.ended).toBeUndefined();
	});

	it("does not trace updates when the prompt has no trace", async () => {
		const { handlers, generations, ctx } = createHarness({ hasTrace: false });

		await handlers.messageUpdate(
			update({ type: "error", reason: "ignored" }),
			ctx,
		);

		expect(generations).toEqual([]);
	});

	it("ignores a provider request that references an unknown turn", async () => {
		const { handlers, generations, rawRecords, ctx } = createHarness();

		await handlers.beforeProviderRequest(
			{ turnIndex: 99, payload: { model: "test-model" } } as never,
			ctx,
		);

		expect(generations).toEqual([]);
		expect(rawRecords).toEqual([]);
	});

	it("ignores an end event that has no message or no live turn", async () => {
		const { handlers, generations, prompt, rawRecords, ctx } =
			await openGeneration();

		await handlers.messageEnd({ message: undefined } as never, ctx);
		await handlers.messageEnd({ message: "text" } as never, ctx);
		await handlers.messageEnd(
			{ turnIndex: 99, message: { role: "assistant", content: [] } } as never,
			ctx,
		);

		expect(generations[0]?.ended).toBeUndefined();
		expect(
			rawRecords.filter((record) => record.type === "assistant_output"),
		).toEqual([]);
		expect(prompt.lastAssistantText).toBe("");
	});

	async function endWith(
		message: Record<string, unknown>,
		providerStatus?: number,
	) {
		const harness = await openGeneration();
		if (providerStatus !== undefined) {
			await harness.handlers.afterProviderResponse(
				{ status: providerStatus } as never,
				harness.ctx,
			);
		}
		await harness.handlers.messageEnd(
			{ message: { role: "assistant", content: [], ...message } } as never,
			harness.ctx,
		);
		return harness;
	}

	it.each([
		[
			"an errored stop with a provider status",
			{ stopReason: "error" },
			503,
			"provider response failed (503)",
		],
		[
			"an errored stop without a provider status",
			{ stopReason: "error" },
			undefined,
			"provider response failed",
		],
		[
			"a failed message flag",
			{ isError: true },
			undefined,
			"provider response failed",
		],
		[
			"an aborted stop",
			{ stopReason: "aborted" },
			undefined,
			"provider response aborted",
		],
		[
			"an error message from the provider",
			{ stopReason: "error", errorMessage: "quota exceeded" },
			429,
			"quota exceeded",
		],
	])("reports %s", async (_name, message, status, statusMessage) => {
		const { generations } = await endWith(message, status);

		expect(generations[0]?.ended).toMatchObject({
			isError: true,
			statusMessage,
		});
	});

	it("reports no status for a normal stop", async () => {
		const { generations } = await endWith({ stopReason: "stop" });

		expect(generations[0]?.ended).toMatchObject({
			isError: false,
			statusMessage: undefined,
		});
	});

	it.each([
		[
			"only input tokens",
			{ input: 7 },
			{ tokensIn: 7, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
		],
		[
			"only output tokens",
			{ output: 4 },
			{ tokensIn: 0, tokensOut: 4, cacheRead: 0, cacheWrite: 0 },
		],
		[
			"only cache tokens",
			{ cacheRead: 5, cacheWrite: 2 },
			{ tokensIn: 7, tokensOut: 0, cacheRead: 5, cacheWrite: 2 },
		],
		[
			"an empty usage report",
			{},
			{ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
		],
	])("adds %s to the prompt totals", async (_name, usage, totals) => {
		const { prompt } = await endWith({ usage });

		expect(prompt).toMatchObject(totals);
	});
});

describe("generation runtime faults and races", () => {
	const assistantMessage = (extra: Record<string, unknown> = {}) =>
		({
			message: { role: "assistant", content: [], ...extra },
		}) as never;

	async function openRequest(options: Parameters<typeof createHarness>[0]) {
		const harness = createHarness(options);
		await harness.handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			harness.ctx,
		);
		return harness;
	}

	it("keeps the prompt accounting and records the cause when the generation cannot start", async () => {
		const gate = deferred();
		const { handlers, generations, prompt, ctx } = await openRequest({
			runtimeGate: gate.promise,
		});

		const starting = handlers.messageStart(
			{ message: { role: "assistant" } },
			ctx,
		);
		gate.reject(new Error("langfuse unreachable"));
		await starting;
		await handlers.afterProviderResponse({ status: 200 } as never, ctx);
		await handlers.messageEnd(
			assistantMessage({
				content: [{ type: "text", text: "still answered" }],
				usage: { input: 3, output: 2 },
			}),
			ctx,
		);

		expect(generations).toEqual([]);
		expect(getLastRuntimeError()?.message).toContain(
			"Failed to start generation",
		);
		expect(getLastRuntimeError()?.message).toContain("langfuse unreachable");
		expect(prompt.lastAssistantText).toBe("still answered");
		expect(prompt).toMatchObject({ tokensIn: 3, tokensOut: 2 });
	});

	it.each([
		[
			"the prompt was replaced",
			({ state }: ReturnType<typeof createHarness>) => {
				state.promptState = null;
			},
		],
		[
			"the turn was replaced",
			({ prompt, turn }: ReturnType<typeof createHarness>) => {
				prompt.activeTurns.delete(turn.index);
			},
		],
	])(
		"creates no generation when %s while the runtime was starting",
		async (_name, supersede) => {
			const gate = deferred();
			const harness = await openRequest({ runtimeGate: gate.promise });

			const starting = harness.handlers.messageStart(
				{ message: { role: "assistant" } },
				harness.ctx,
			);
			supersede(harness);
			gate.resolve();
			await starting;

			expect(harness.generations).toEqual([]);
		},
	);

	it("parents the generation on the turn span, else the prompt span", async () => {
		const withTurnSpan = await openRequest({
			turnSpanId: "turn-span",
			promptSpanId: "prompt-span",
		});
		await withTurnSpan.handlers.messageStart(
			{ message: { role: "assistant" } },
			withTurnSpan.ctx,
		);
		const promptOnly = await openRequest({ promptSpanId: "prompt-span" });
		await promptOnly.handlers.messageStart(
			{ message: { role: "assistant" } },
			promptOnly.ctx,
		);

		expect(withTurnSpan.generations[0]?.body.parentObservationId).toBe(
			"turn-span",
		);
		expect(promptOnly.generations[0]?.body.parentObservationId).toBe(
			"prompt-span",
		);
	});

	it("ends a generation once when the message end follows a provider stream error", async () => {
		const { handlers, endCalls, scores, ctx } = await openRequest({});
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		await handlers.messageUpdate(
			{
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "error", reason: "overloaded" },
			} as never,
			ctx,
		);
		await handlers.messageEnd(
			assistantMessage({ usage: { input: 9, output: 9, cost: { total: 1 } } }),
			ctx,
		);

		expect(endCalls).toHaveLength(1);
		expect(endCalls[0]).toMatchObject({
			isError: true,
			statusMessage: "overloaded",
		});
		expect(scores).toEqual([]);
	});

	it("records an end failure without interrupting the prompt", async () => {
		const { handlers, endCalls, prompt, ctx } = await openRequest({
			endError: new Error("end rejected"),
		});
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		await handlers.messageEnd(
			assistantMessage({
				content: [{ type: "text", text: "final answer" }],
				usage: { input: 4, output: 1 },
			}),
			ctx,
		);

		expect(endCalls).toHaveLength(1);
		expect(getLastRuntimeError()?.message).toContain(
			"Failed to end generation",
		);
		expect(getLastRuntimeError()?.message).toContain("end rejected");
		expect(prompt.lastAssistantText).toBe("final answer");
		expect(prompt).toMatchObject({ tokensIn: 4, tokensOut: 1 });
	});

	it("lets an in-flight finish complete instead of abandoning its generation", async () => {
		const gate = deferred();
		const { handlers, generations, endCalls, turn, ctx } = await openRequest({
			runtimeGate: gate.promise,
		});

		const starting = handlers.messageStart(
			{ message: { role: "assistant" } },
			ctx,
		);
		const finishing = handlers.messageEnd(
			assistantMessage({ content: [{ type: "text", text: "done" }] }),
			ctx,
		);
		const abandoning = handlers.abandonTurn(turn);
		gate.resolve();
		await Promise.all([starting, finishing, abandoning]);

		expect(generations).toHaveLength(1);
		expect(endCalls).toHaveLength(1);
		expect(endCalls[0]).toMatchObject({
			isError: false,
			output: { text: "done" },
		});
		expect(endCalls[0]?.metadata).not.toHaveProperty("abandoned");
	});

	it("records an abandon failure and still finishes the turn cleanup", async () => {
		const { handlers, endCalls, turn, ctx } = await openRequest({
			endError: new Error("abandon rejected"),
		});
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		await handlers.abandonTurn(turn);

		expect(endCalls).toHaveLength(1);
		expect(endCalls[0]).toMatchObject({
			isError: true,
			statusMessage: "generation abandoned during prompt finalization",
		});
		expect(getLastRuntimeError()?.message).toContain(
			"Failed to abandon generation",
		);
		expect(getLastRuntimeError()?.message).toContain("abandon rejected");
	});
});

describe("generation start without a provider request", () => {
	const assistant = { message: { role: "assistant" } } as never;

	it("opens the generation for a provider response that no request announced", async () => {
		const { handlers, generations, ctx } = createHarness();

		await handlers.afterProviderResponse({ status: 503 } as never, ctx);

		expect(generations).toHaveLength(1);
		expect(generations[0]?.body.metadata).toMatchObject({
			providerResponseStatus: 503,
			providerResponseError: true,
		});
	});

	it("adds the provider response to a generation that is already open", async () => {
		const { handlers, generations, ctx } = createHarness();
		await handlers.beforeProviderRequest(
			{ payload: { model: "m" } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		expect(generations[0]?.body.metadata).not.toHaveProperty(
			"providerResponseStatus",
		);

		await handlers.afterProviderResponse({ status: 429 } as never, ctx);

		expect(generations).toHaveLength(1);
		expect(generations[0]?.body.metadata).toMatchObject({
			providerResponseStatus: 429,
			providerResponseError: true,
		});
	});

	it("opens the generation for a message start that no request announced", async () => {
		const { handlers, generations, ctx } = createHarness();

		await handlers.messageStart(assistant, ctx);

		expect(generations).toHaveLength(1);
	});

	it("opens the generation for a stream update that no request announced", async () => {
		const { handlers, generations, ctx } = createHarness();

		await handlers.messageUpdate(
			{
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
			} as never,
			ctx,
		);

		expect(generations).toHaveLength(1);
	});

	it.each([
		[
			"provider response",
			(h: ReturnType<typeof createHarness>) =>
				h.handlers.afterProviderResponse({ status: 200 } as never, h.ctx),
		],
		[
			"message start",
			(h: ReturnType<typeof createHarness>) =>
				h.handlers.messageStart(assistant, h.ctx),
		],
		[
			"stream update",
			(h: ReturnType<typeof createHarness>) =>
				h.handlers.messageUpdate(
					{
						message: { role: "assistant", content: [] },
						assistantMessageEvent: { type: "text_delta", delta: "hi" },
					} as never,
					h.ctx,
				),
		],
	])(
		"opens no generation for a %s while tracing is off",
		async (_name, send) => {
			const harness = createHarness({ tracing: false });

			await send(harness);

			expect(harness.generations).toEqual([]);
		},
	);
});

describe("provider requests that must not open a generation", () => {
	it.each([
		["tracing is off", { tracing: false }],
		["the prompt has no trace", { hasTrace: false }],
	])(
		"tracks no generation for a provider request while %s",
		async (_name, options) => {
			const { handlers, turn, generations, ctx } = createHarness(options);

			await handlers.beforeProviderRequest(
				{ payload: { model: "m" } } as never,
				ctx,
			);

			expect(turn.generationOrder).toEqual([]);
			expect(turn.generations.size).toBe(0);
			expect(generations).toEqual([]);
		},
	);
});

describe("repeated message starts", () => {
	it("keeps the streamed text when the same message is announced twice", async () => {
		const { handlers, endCalls, ctx } = createHarness();
		await handlers.beforeProviderRequest(
			{ payload: { model: "m" } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageUpdate(
			{
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", delta: "streamed" },
			} as never,
			ctx,
		);

		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageEnd(
			{ message: { role: "assistant", content: [] } } as never,
			ctx,
		);

		expect(endCalls).toHaveLength(1);
		expect(endCalls[0]).toMatchObject({ output: { text: "streamed" } });
	});
});

describe("generation model", () => {
	const modelOf = async (
		options: Parameters<typeof createHarness>[0],
		payload: Record<string, unknown>,
	) => {
		const { handlers, generations, ctx } = createHarness(options);
		await handlers.beforeProviderRequest({ payload } as never, ctx);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		return generations[0]?.body.model;
	};
	const endModelOf = async (
		options: Parameters<typeof createHarness>[0],
		payload: Record<string, unknown>,
		message: Record<string, unknown> = {},
	) => {
		const { handlers, endCalls, ctx } = createHarness(options);
		await handlers.beforeProviderRequest({ payload } as never, ctx);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);
		await handlers.messageEnd(
			{ message: { role: "assistant", content: [], ...message } } as never,
			ctx,
		);
		return endCalls[0] as { model?: string; metadata: { model?: string } };
	};

	it("starts on the request's model, else the session's, else none", async () => {
		expect(await modelOf({}, { model: "request-model" })).toBe("request-model");
		expect(await modelOf({}, {})).toBe("session-model");
		expect(await modelOf({ sessionModel: "" }, {})).toBeUndefined();
	});

	it("ends on the response's model, else the session's, else the request's, else none", async () => {
		const withMessage = await endModelOf(
			{},
			{ model: "request-model" },
			{
				model: "response-model",
			},
		);
		expect(withMessage.model).toBe("response-model");
		expect(withMessage.metadata.model).toBe("response-model");
		const withSession = await endModelOf({}, { model: "request-model" });
		expect(withSession.model).toBe("session-model");
		expect(withSession.metadata.model).toBe("session-model");
		const withRequest = await endModelOf(
			{ sessionModel: "" },
			{ model: "request-model" },
		);
		expect(withRequest.model).toBe("request-model");
		const none = await endModelOf({ sessionModel: "" }, {});
		expect(none.model).toBeUndefined();
	});
});

describe("first token timing", () => {
	const delta = (type: string) =>
		({
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type, delta: "x" },
		}) as never;

	async function openAt(time: number) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(time);
		const harness = createHarness();
		await harness.handlers.beforeProviderRequest(
			{ payload: { model: "m" } } as never,
			harness.ctx,
		);
		await harness.handlers.messageStart(
			{ message: { role: "assistant" } },
			harness.ctx,
		);
		return harness;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("records the first text delta's latency once and keeps its start time", async () => {
		const { handlers, generations, ctx } = await openAt(1_000);

		vi.setSystemTime(1_100);
		await handlers.messageUpdate(delta("text_delta"), ctx);
		const first = generations[0]?.body.completionStartTime;
		vi.setSystemTime(1_300);
		await handlers.messageUpdate(delta("thinking_delta"), ctx);

		expect(first).toEqual(new Date(1_100));
		expect(generations[0]?.body.completionStartTime).toBe(first);
		expect(generations[0]?.body.metadata).toMatchObject({
			timeToFirstTokenMs: 100,
		});
	});

	it("reports zero latency for a first delta in the same millisecond as the request", async () => {
		const { handlers, generations, ctx } = await openAt(2_000);

		await handlers.messageUpdate(delta("text_delta"), ctx);

		expect(generations[0]?.body.metadata).toMatchObject({
			timeToFirstTokenMs: 0,
		});
	});

	it("does not mark a first token for an event that carries no text", async () => {
		const { handlers, generations, ctx } = await openAt(3_000);

		await handlers.messageUpdate(delta("text_start"), ctx);

		expect(generations[0]?.body.completionStartTime).toBeUndefined();
		expect(generations[0]?.body.metadata).not.toHaveProperty(
			"timeToFirstTokenMs",
		);
	});

	it("keeps partial output out of the generation unless message updates are captured", async () => {
		const { handlers, generations, ctx } = await openAt(4_000);

		await handlers.messageUpdate(delta("text_delta"), ctx);

		expect(generations[0]?.body.output).toBeUndefined();
	});
});

describe("assistant message accounting", () => {
	const finalMessage = (extra: Record<string, unknown> = {}) =>
		({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				...extra,
			},
		}) as never;

	it("counts one assistant message per turn", async () => {
		const { handlers, prompt, rawRecords, ctx } = createHarness();

		await handlers.messageEnd(
			finalMessage({ usage: { input: 3, output: 1 } }),
			ctx,
		);
		await handlers.messageEnd(
			finalMessage({ usage: { input: 5, output: 2 } }),
			ctx,
		);

		expect(prompt).toMatchObject({ tokensIn: 3, tokensOut: 1 });
		expect(
			rawRecords.filter((record) => record.type === "assistant_output"),
		).toHaveLength(1);
	});

	it.each([
		["an error stop", { stopReason: "error", errorMessage: "upstream failed" }],
		["an aborted stop", { stopReason: "aborted" }],
	])(
		"remembers the failure of %s on the turn and the prompt",
		async (_name, message) => {
			const { handlers, prompt, turn, ctx } = createHarness();

			await handlers.messageEnd(finalMessage(message), ctx);

			expect(turn.failure).toMatchObject({ stopReason: message.stopReason });
			expect(prompt.failure).toMatchObject({ stopReason: message.stopReason });
		},
	);

	it("records no failure for a normal stop", async () => {
		const { handlers, prompt, turn, ctx } = createHarness();

		await handlers.messageEnd(finalMessage({ stopReason: "stop" }), ctx);

		expect(turn.failure).toBeUndefined();
		expect(prompt.failure).toBeUndefined();
	});
});

describe("abandoning a generation while a stream update is in flight", () => {
	it("records the first token and the partial output before the generation ends", async () => {
		const { handlers, generations, turn, ctx } = createHarness({
			captureMessageUpdates: true,
			dropUpdatesAfterEnd: true,
		});
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		await handlers.messageStart({ message: { role: "assistant" } }, ctx);

		// The first text delta is handled while turn cleanup abandons the turn.
		// An update that reaches the generation after its end is dropped, so
		// the delta's data must be recorded first.
		const updating = handlers.messageUpdate(
			{
				message: { role: "assistant", content: [{ type: "text", text: "A" }] },
				assistantMessageEvent: { type: "text_delta", delta: "A" },
			} as never,
			ctx,
		);
		const abandoning = handlers.abandonTurn(turn);
		await Promise.all([updating, abandoning]);

		expect(generations[0]?.ended).toBeDefined();
		expect(generations[0]?.body.completionStartTime).toBeInstanceOf(Date);
		expect(generations[0]?.body.output).toMatchObject({ text: "A" });
	});
});

describe("abandoning a generation that is still starting", () => {
	it("creates no generation after the abandon and waits for the start to settle", async () => {
		const gate = deferred();
		const { handlers, generations, turn, ctx } = createHarness({
			runtimeGate: gate.promise,
		});
		await handlers.beforeProviderRequest(
			{ payload: { model: "test-model" } } as never,
			ctx,
		);
		const starting = handlers.messageStart(
			{ message: { role: "assistant" } },
			ctx,
		);
		let abandoned = false;
		const abandoning = handlers.abandonTurn(turn).then(() => {
			abandoned = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(abandoned).toBe(false);

		gate.resolve();
		await Promise.all([starting, abandoning]);

		expect(generations).toEqual([]);
	});

	it("reports how long an abandoned generation was open", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(8_000);
			const { handlers, endCalls, turn, ctx } = createHarness();
			await handlers.beforeProviderRequest(
				{ payload: { model: "test-model" } } as never,
				ctx,
			);
			await handlers.messageStart({ message: { role: "assistant" } }, ctx);
			vi.setSystemTime(8_400);

			await handlers.abandonTurn(turn);

			expect(endCalls[0]).toMatchObject({
				isError: true,
				metadata: { abandoned: true, durationMs: 400 },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("provider events for a generation that is already finishing", () => {
	it("ignores a late provider response while the finish waits for the runtime", async () => {
		const gate = deferred();
		const { handlers, generations, ctx } = createHarness({
			runtimeGate: gate.promise,
		});
		const key = { requestId: "request-1" };
		await handlers.beforeProviderRequest(
			{ ...key, payload: { model: "m" } } as never,
			ctx,
		);
		const finishing = handlers.messageEnd(
			{ ...key, message: { role: "assistant", content: [] } } as never,
			ctx,
		);

		const late = handlers.afterProviderResponse(
			{ ...key, status: 500 } as never,
			ctx,
		);
		gate.resolve();
		await Promise.all([finishing, late]);

		expect(generations[0]?.body.metadata).not.toHaveProperty(
			"providerResponseStatus",
		);
	});

	it("ignores a late message start while the finish waits for the runtime", async () => {
		const gate = deferred();
		const { handlers, turn, ctx } = createHarness({
			runtimeGate: gate.promise,
		});
		const key = { requestId: "request-1" };
		await handlers.beforeProviderRequest(
			{ ...key, payload: { model: "m" } } as never,
			ctx,
		);
		const finishing = handlers.messageEnd(
			{ ...key, message: { role: "assistant", content: [] } } as never,
			ctx,
		);

		const late = handlers.messageStart(
			{ ...key, message: { role: "assistant" } } as never,
			ctx,
		);
		gate.resolve();
		await Promise.all([finishing, late]);

		expect(turn.generations.get("request-1")?.messageStarted).toBeUndefined();
	});

	it("ignores a late stream update while the finish waits for the runtime", async () => {
		const gate = deferred();
		const { handlers, generations, ctx } = createHarness({
			runtimeGate: gate.promise,
		});
		const key = { requestId: "request-1" };
		await handlers.beforeProviderRequest(
			{ ...key, payload: { model: "m" } } as never,
			ctx,
		);
		const finishing = handlers.messageEnd(
			{ ...key, message: { role: "assistant", content: [] } } as never,
			ctx,
		);

		const late = handlers.messageUpdate(
			{
				...key,
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", delta: "late" },
			} as never,
			ctx,
		);
		gate.resolve();
		await Promise.all([finishing, late]);

		expect(generations[0]?.body.completionStartTime).toBeUndefined();
	});
});
