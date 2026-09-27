import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
	captureProviderRequest,
	extractTextFromContent,
	providerRequestIdentity,
	summarizeMessages,
	summarizeProviderPayload,
	summarizeProviderRequestInput,
	summarizeProviderRequestMessages,
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

describe("telemetry capture fidelity", () => {
	// Word-based filler keeps the redactor out of the way: long unbroken
	// character runs are treated as blobs and replaced.
	const filler = (label: string, chars: number) => {
		const unit = `${label} context line value `;
		return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
	};

	// Guards training/distillation fidelity: every recent message must survive at
	// full per-message capture. A total-context budget would silently drop the
	// (context, response) pairs that make traces useful for distillation.
	it("keeps every recent message even when the total exceeds traceInputMaxChars", () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: filler(`message-${index}`, 500),
		}));

		const summary = summarizeMessages(config, messages);
		const contentChars = summary.reduce(
			(total, message) => total + message.content.length,
			0,
		);

		expect(contentChars).toBeGreaterThan(config.traceInputMaxChars);
		// Full deep equality: a dropped message replaced by a truncation marker
		// keeps the length and the newest entry intact, so weaker assertions pass.
		expect(summary).toEqual(messages);
	});

	it("keeps provider request summaries at full per-message capture", () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			role: "user",
			content: filler(`provider-${index}`, 500),
		}));

		const summary = summarizeProviderRequestMessages(config, messages);
		if (!summary) throw new Error("provider summary was not created");
		const contentChars = summary.reduce(
			(total, message) => total + message.content.length,
			0,
		);

		expect(contentChars).toBeGreaterThan(config.traceInputMaxChars);
		expect(summary).toEqual(messages);
	});

	it("bounds one oversized message by traceInputMaxChars", () => {
		const summary = summarizeMessages(config, [
			{ role: "user", content: filler("oversized", 5_000) },
		]);

		expect(summary).toHaveLength(1);
		expect(summary[0]?.content).toHaveLength(config.traceInputMaxChars + 1);
	});

	it("marks only the messages dropped by the recent-message window", () => {
		const messages = Array.from({ length: 45 }, (_, index) => ({
			role: "user",
			content: `windowed-${index}`,
		}));

		const summary = summarizeMessages(config, messages);

		expect(summary[0]?.content).toBe("[truncated 5 earlier message(s)]");
		expect(summary).toHaveLength(41);
		expect(summary.at(-1)?.content).toBe("windowed-44");
	});
});

describe("provider payload summaries", () => {
	// Responses-style payload: request contents live in `input`, not `messages`.
	const responsesPayload = {
		model: "grok-4.7",
		input: [
			{ role: "system", content: "INPUT-system prompt" },
			{
				role: "user",
				content: [{ type: "input_text", text: "INPUT-user turn" }],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "INPUT-assistant answer" }],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "read",
				arguments: '{"path":"/tmp/tool-args-secret"}',
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: "INPUT-tool output",
			},
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "INPUT-reasoning" }],
			},
		],
		stream: true,
		prompt_cache_key: "pck-cache-key-value",
		temperature: 0.7,
		reasoning: { effort: "low" },
	};

	it("summarizes Responses input items instead of chat messages", () => {
		const summary = summarizeProviderPayload(
			config,
			responsesPayload,
			"fallback-model",
		);

		expect(summary.model).toBe("grok-4.7");
		expect(summary.source).toBe("input");
		expect(summary.messageCount).toBe(6);
		const summarized = JSON.stringify(summary.messages);
		expect(summarized).toContain("INPUT-system prompt");
		expect(summarized).toContain("INPUT-user turn");
		expect(summarized).toContain("INPUT-assistant answer");
		// Tool inputs, tool outputs, and reasoning contents are not expanded.
		expect(summarized).not.toContain("/tmp/tool-args-secret");
		expect(summarized).not.toContain("INPUT-tool output");
		expect(summarized).not.toContain("INPUT-reasoning");
		// Cache-key values never leave the payload.
		expect(JSON.stringify(summary)).not.toContain("pck-cache-key-value");
	});

	it("summarizes string-shaped Responses input as one user item", () => {
		const summary = summarizeProviderPayload(
			config,
			{ model: "grok-4.7", input: "INPUT-plain string" },
			"fallback-model",
		);

		expect(summary.source).toBe("input");
		expect(summary.messageCount).toBe(1);
		expect(summary.messages).toEqual([
			{ role: "user", content: "INPUT-plain string" },
		]);
	});

	it("keeps Chat Completions payload summaries in the legacy shape", () => {
		const summary = summarizeProviderPayload(
			config,
			{ model: "m", messages: [{ role: "user", content: "INPUT-chat" }] },
			"fallback-model",
		);

		// Exact equality pins the legacy contract: no source marker, same keys.
		expect(summary).toEqual({
			model: "m",
			messageCount: 1,
			messages: [{ role: "user", content: "INPUT-chat" }],
			keys: ["model", "messages"],
		});
	});

	it("summarizes non-object and unrecognized input items defensively", () => {
		const summary = summarizeProviderPayload(
			config,
			{
				model: "grok-4.7",
				input: [
					"INPUT-bare string",
					null,
					42,
					["INPUT-nested text"],
					{
						role: "user",
						content: [{ type: "input_image", detail: "high" }],
					},
					{ type: "message" },
				],
			},
			"fallback-model",
		);

		expect(summary.source).toBe("input");
		expect(summary.messageCount).toBe(6);
		const summarized = summary.messages?.map((item) => item.content);
		// Bare strings summarize as user text; null and scalars summarize as
		// unknown with stringified content; content arrays without a text part
		// fall back to item counts and are not expanded.
		expect(summarized).toEqual([
			"INPUT-bare string",
			"",
			"42",
			"[1 content item(s)]",
			"[1 content item(s)]",
			"[message item]",
		]);
		expect(summary.messages?.map((item) => item.role)).toEqual([
			"user",
			"unknown",
			"unknown",
			"unknown",
			"user",
			"message",
		]);
		expect(JSON.stringify(summary.messages)).not.toContain("high");
	});

	// Non-object payloads cannot carry request contents: the summary must
	// collapse to a bare type marker, and a payload without a string model
	// must fall back to the session model instead of leaking a raw value.
	it("summarizes non-object payloads and absent model fields defensively", () => {
		expect(
			summarizeProviderPayload(config, "INPUT-raw text", "fallback-model"),
		).toEqual({ type: "string" });
		expect(summarizeProviderPayload(config, 42, "fallback-model")).toEqual({
			type: "number",
		});
		const noModel = summarizeProviderPayload(
			config,
			{ input: [{ role: "user", content: "INPUT-anon" }] },
			"fallback-model",
		);
		expect(noModel.model).toBe("fallback-model");
		expect(noModel.source).toBe("input");
		expect(noModel.messageCount).toBe(1);
	});

	// Wire metrics exist only for recognized contents; anything else must
	// claim neither items nor bytes so records never assert unobserved wires.
	it("claims no contents or wire metrics for unrecognized input shapes", () => {
		expect(summarizeProviderRequestInput(config, 42)).toBeUndefined();
		expect(summarizeProviderRequestInput(config, null)).toBeUndefined();
		expect(captureProviderRequest(undefined)).toEqual({
			contents: undefined,
			captured: undefined,
			messageCount: undefined,
			estimatedBytes: undefined,
		});
		expect(captureProviderRequest({ input: 42 })).toEqual({
			contents: undefined,
			captured: undefined,
			messageCount: undefined,
			estimatedBytes: undefined,
		});
	});

	// Untyped structs, anonymous tool items, and reasoning blobs are
	// summarized by shape and correlation id only; named variants must keep
	// their identity so coalescing diagnostics stay readable.
	it("summarizes untyped structs and anonymous tool items defensively", () => {
		const summary = summarizeProviderPayload(
			config,
			{
				model: "grok-4.7",
				input: [
					{},
					{ type: 42, secret: "LEAK-untyped" },
					{ type: "function_call", arguments: '{"path":"LEAK-args"}' },
					{
						type: "function_call_output",
						output: "LEAK-output",
					},
					{ type: "reasoning", encrypted_content: "LEAK-encrypted" },
					{ type: "function_call", name: "read", arguments: "{}" },
					{ type: "function_call_output", call_id: "call_9" },
				],
			},
			"fallback-model",
		);

		expect(summary.messageCount).toBe(7);
		expect(summary.messages?.map((item) => item.role)).toEqual([
			"unknown",
			"unknown",
			"assistant",
			"tool",
			"assistant",
			"assistant",
			"tool",
		]);
		expect(summary.messages?.map((item) => item.content)).toEqual([
			"[unknown item]",
			"[unknown item]",
			"[function_call: unknown]",
			"[function_call_output: unknown]",
			"[reasoning item]",
			"[function_call: read]",
			"[function_call_output: call_9]",
		]);
		expect(JSON.stringify(summary.messages)).not.toContain("LEAK-");
	});

	// Only text/input_text/output_text parts may be extracted as text. Every
	// other part shape passes through untouched and is counted, never read.
	it("extracts only recognized text parts from Responses content arrays", () => {
		const summary = summarizeProviderPayload(
			config,
			{
				model: "grok-4.7",
				input: [
					{ role: "user", content: [42] },
					{ role: "user", content: ["INPUT-plain part"] },
					{ role: "user", content: [{ type: 42, text: "LEAK-numeric" }] },
					{
						role: "user",
						content: [{ type: "mystery", text: "LEAK-mystery" }],
					},
					{
						role: "user",
						content: [
							"INPUT-plain part",
							{ type: "input_text", text: "INPUT-named part" },
						],
					},
				],
			},
			"fallback-model",
		);

		expect(summary.messages?.map((item) => item.role)).toEqual([
			"user",
			"user",
			"user",
			"user",
			"user",
		]);
		expect(summary.messages?.map((item) => item.content)).toEqual([
			"[1 content item(s)]",
			"[1 content item(s)]",
			"[1 content item(s)]",
			"[1 content item(s)]",
			"INPUT-named part",
		]);
		expect(JSON.stringify(summary.messages)).not.toContain("LEAK-");
	});

	// Regression: a nullish entry inside a content array crashed
	// extractTextFromContent (item.type on null), and the diagnostic catch in
	// beforeProviderRequest then silently dropped the whole request record.
	// Nullish parts must be skipped like any other unexpanded part while
	// recognized text keeps its order.
	it("skips nullish content parts while keeping recognized text in order", () => {
		const content = [
			null,
			{ type: "text", text: "INPUT-first" },
			undefined,
			{ type: "input_text", text: "LEAK-unnormalized" },
			{ type: "text", text: "" },
			{ type: "text", text: "INPUT-last" },
		] as Array<{ type: string; text?: string }>;

		expect(extractTextFromContent(content)).toBe("INPUT-first\nINPUT-last");
	});

	// Role-bearing chat and Responses messages funnel content arrays through
	// extractTextFromContent; a throw inside summarizeProviderPayload would
	// cost the entire request summary, so both wire fields must tolerate
	// nullish parts and stay read-only.
	it("summarizes role messages with nullish content parts without losing the request", () => {
		const chatPayload = {
			model: "grok-4.7",
			messages: [
				{
					role: "user",
					content: [null, { type: "text", text: "INPUT-chat after null" }, 42],
				},
			],
		};
		const responsesPayload = {
			model: "grok-4.7",
			input: [
				{
					role: "user",
					content: [
						undefined,
						{
							type: "input_text",
							text: "INPUT-responses after undefined",
						},
					],
				},
			],
		};
		const chatSnapshot = structuredClone(chatPayload);
		const responsesSnapshot = structuredClone(responsesPayload);

		const chatSummary = summarizeProviderPayload(
			config,
			chatPayload,
			"fallback-model",
		);
		const responsesSummary = summarizeProviderPayload(
			config,
			responsesPayload,
			"fallback-model",
		);

		expect(chatSummary.messageCount).toBe(1);
		expect(responsesSummary.messageCount).toBe(1);
		expect(chatSummary.messages).toEqual([
			{ role: "user", content: "INPUT-chat after null" },
		]);
		expect(responsesSummary.messages).toEqual([
			{ role: "user", content: "INPUT-responses after undefined" },
		]);
		// Summarization is read-only: parts pass through in copies, the
		// caller's payload is never normalized in place.
		expect(chatPayload).toEqual(chatSnapshot);
		expect(responsesPayload).toEqual(responsesSnapshot);
	});

	// The recent-item window keeps exactly the last 40 items: at the boundary
	// nothing is truncated, and one item over produces a single-item marker.
	it("keeps the 40-item window boundary exact", () => {
		const item = (index: number) => ({
			role: "user",
			content: [{ type: "input_text", text: `window-${index}` }],
		});
		const atLimit = summarizeProviderRequestInput(
			config,
			Array.from({ length: 40 }, (_, index) => item(index)),
		);
		expect(atLimit).toHaveLength(40);
		expect(JSON.stringify(atLimit)).not.toContain("truncated");

		const oneOver = summarizeProviderRequestInput(
			config,
			Array.from({ length: 41 }, (_, index) => item(index)),
		);
		expect(oneOver).toHaveLength(41);
		expect(oneOver?.[0]).toEqual({
			role: "system",
			content: "[truncated 1 earlier item(s)]",
		});
		expect(oneOver?.at(-1)).toEqual({
			role: "user",
			content: "window-40",
		});
	});

	it("marks only the input items dropped by the recent-item window", () => {
		const summary = summarizeProviderPayload(
			config,
			{
				model: "grok-4.7",
				input: Array.from({ length: 45 }, (_, index) => ({
					role: "user",
					content: [{ type: "input_text", text: `windowed-${index}` }],
				})),
			},
			"fallback-model",
		);

		expect(summary.messageCount).toBe(45);
		expect(summary.messages).toHaveLength(41);
		expect(summary.messages?.[0]).toEqual({
			role: "system",
			content: "[truncated 5 earlier item(s)]",
		});
		expect(summary.messages?.at(-1)).toEqual({
			role: "user",
			content: "windowed-44",
		});
	});
});

describe("provider request identity", () => {
	// Identity must cover the complete payload so bounded display summaries
	// that collide cannot merge distinct same-turn requests.
	const windowedInput = (first: string) =>
		Array.from({ length: 45 }, (_, index) =>
			index === 0
				? { role: "user", content: [{ type: "input_text", text: first }] }
				: {
						role: "user",
						content: [{ type: "input_text", text: `shared-${index}` }],
					},
		);

	it("distinguishes requests whose bounded display summaries collide", () => {
		const first = providerRequestIdentity({
			model: "grok-4.7",
			input: windowedInput("INPUT-first"),
		});
		const second = providerRequestIdentity({
			model: "grok-4.7",
			input: windowedInput("INPUT-second"),
		});

		expect(first).not.toBe(second);
	});

	it("distinguishes requests differing only in tool arguments or parameters", () => {
		const build = (args: string, temperature: number) => ({
			model: "grok-4.7",
			temperature,
			input: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "read",
					arguments: args,
				},
			],
		});

		expect(providerRequestIdentity(build('{"path":"/a"}', 0.7))).not.toBe(
			providerRequestIdentity(build('{"path":"/b"}', 0.7)),
		);
		expect(providerRequestIdentity(build('{"path":"/a"}', 0.7))).not.toBe(
			providerRequestIdentity(build('{"path":"/a"}', 0.9)),
		);
	});

	it("coalesces freshly built identical payloads", () => {
		const build = () => ({
			model: "grok-4.7",
			temperature: 0.7,
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "INPUT-same" }],
				},
			],
		});

		expect(providerRequestIdentity(build())).toBe(
			providerRequestIdentity(build()),
		);
	});

	it("returns undefined for unserializable payloads instead of throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(providerRequestIdentity(cyclic)).toBeUndefined();
		expect(providerRequestIdentity({ value: 1n })).toBeUndefined();
	});
});
