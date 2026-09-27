import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
	createGenerationLifecycleHandlers,
	type GenerationLifecycleDependencies,
} from "./generation-lifecycle.js";
import type { PromptState, TurnState } from "./lifecycle-types.js";
import { redactionMetadata } from "./redaction.js";
import type { SessionState } from "./session-state.js";
import {
	costDetailsFromUsage,
	estimateJsonBytes,
	extractTextFromContent,
	safeJson,
	standardUsageFromUsage,
	summarizeMessages,
	summarizeProviderPayload,
	summarizeProviderRequestMessages,
	telemetryText,
	usageDetailsFromUsage,
	writeRawTrace,
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

function createHarness() {
	const generations: RecordedGeneration[] = [];
	const runtime = {
		generation: (body: Record<string, unknown>) => {
			const record: RecordedGeneration = { body, ended: undefined };
			generations.push(record);
			return {
				id: "gen-1",
				update: (update: Record<string, unknown>) => {
					record.body = { ...record.body, ...update };
				},
				end: (endBody: Record<string, unknown>) => {
					record.ended = endBody;
				},
			};
		},
		score: () => undefined,
	};
	const turn: TurnState = {
		index: 0,
		startedAt: Date.now(),
		generations: new Map(),
		generationOrder: [],
		nextGenerationIndex: 0,
	};
	const prompt: PromptState = {
		trace: { id: "trace-1" } as PromptState["trace"],
		userPrompt: "PROMPT-original question",
		systemPrompt: "",
		cwd: "/tmp/work",
		startedAt: Date.now(),
		toolCalls: 0,
		toolErrors: 0,
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
		activeTurns: new Map([[0, turn]]),
		activeTools: new Map(),
		completedTurnIndexes: new Set(),
	};
	const state = {
		sessionId: "session-1",
		sessionFile: "/tmp/pi-agent/sessions/--work--/session.jsonl",
		previousSessionFile: "",
		sessionReason: "startup",
		model: "session-model",
		provider: "session-provider",
		promptState: prompt,
		compactCount: 0,
		lease: Symbol("test"),
	} as unknown as SessionState<PromptState>;
	const handlers = createGenerationLifecycleHandlers({
		getConfig: () => config,
		getSessionState: () => state,
		canTrace: () => true,
		getRuntime: (async () =>
			runtime) as unknown as GenerationLifecycleDependencies["getRuntime"],
		telemetryText,
		redactionMetadata,
		extractTextFromContent,
		standardUsageFromUsage,
		usageDetailsFromUsage,
		costDetailsFromUsage,
		summarizeMessages,
		summarizeProviderPayload,
		summarizeProviderRequestMessages,
		safeJson,
		estimateJsonBytes,
		writeRawTrace,
	});
	const ctx = {} as never;
	return { handlers, generations, prompt, turn, ctx };
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
