import { describe, expect, it } from "vitest";
import {
	type PayloadPolicyConfig,
	shapeRawTraceRecord,
} from "./payload-policy.js";
import { captureProviderRequest } from "./telemetry-helpers.js";
import {
	convertRawTrace,
	TRAINING_REVIEW_NOTICE,
	type TrainingFormat,
} from "./training-export.js";

/**
 * Records are produced by the real raw-trace shaping boundary
 * (`shapeRawTraceRecord`), so their capture provenance is measured, not
 * hand-written. Expected outputs come from the documented target schemas:
 * OpenAI Chat Completions (`tool_calls[].function.arguments` is a JSON
 * string, tool messages carry `tool_call_id`) and Anthropic Messages (`system`
 * is top-level, `tool_use.input` is an object, `tool_result` blocks sit in the
 * user message right after their `tool_use`).
 */
const FULL: PayloadPolicyConfig = {
	redactionEnabled: true,
	secretKey: "sk-lf-test-secret-1234567890",
	redactionAdditionalSecrets: [],
};

const SOURCE = "raw-traces/session.jsonl";
const DECLARATION = { consent: "unknown", license: "" } as const;

function emit(
	record: Record<string, unknown>,
	config: PayloadPolicyConfig = FULL,
) {
	return JSON.parse(
		JSON.stringify(shapeRawTraceRecord(config, record)),
	) as Record<string, unknown>;
}

function request(
	turnIndex: number,
	messages: unknown,
	extra: Record<string, unknown> = {},
	config?: PayloadPolicyConfig,
) {
	return emit(
		{
			type: "provider_request",
			turnIndex,
			captureMode: "full",
			requestSource: "payload.context",
			messageCount: Array.isArray(messages) ? messages.length : 1,
			messages,
			...extra,
		},
		config,
	);
}

function answer(
	turnIndex: number,
	text: string,
	extra: Record<string, unknown> = {},
	config?: PayloadPolicyConfig,
) {
	return emit(
		{
			type: "assistant_output",
			turnIndex,
			text,
			toolCalls: [],
			stopReason: "stop",
			...extra,
		},
		config,
	);
}

function messagesOf(
	sample: { example: Record<string, unknown> } | undefined,
): Array<Record<string, unknown>> {
	if (!sample) throw new Error("expected a converted sample");
	return sample.example.messages as Array<Record<string, unknown>>;
}

function jsonl(...records: unknown[]) {
	return `${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`;
}

function convert(
	records: unknown[],
	format: TrainingFormat = "openai-chat",
	declaration: {
		consent: "unknown" | "granted";
		license: string;
	} = DECLARATION,
) {
	return convertRawTrace(jsonl(...records), {
		format,
		source: SOURCE,
		declaration,
	});
}

function reasons(records: unknown[], format?: TrainingFormat) {
	return convert(records, format).rejections.map(
		(rejection) => rejection.reason,
	);
}

/** A Pi-native context with one completed tool exchange in its history. */
const piContext = [
	{
		role: "system",
		content: "",
		sections: { preamble: "SYS-A", rules: "SYS-B", removed: null },
		toolsAdded: [{ name: "probe", description: "tool definition" }],
	},
	{ role: "user", content: [{ type: "text", text: "Please probe" }] },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "calling" },
			{
				type: "toolCall",
				id: "call-1",
				name: "probe",
				arguments: { q: "hello", n: 2, nested: { a: [1, 2] } },
			},
		],
		stopReason: "toolUse",
	},
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "probe",
		content: [{ type: "text", text: "TOOL-OUT" }],
		isError: false,
	},
];

const ARGS = { q: "hello", n: 2, nested: { a: [1, 2] } };

describe("complete text and tool context", () => {
	it("converts a Pi-native context with tool history to OpenAI chat messages", () => {
		const { examples, rejections } = convert([
			request(1, piContext),
			answer(1, "final answer"),
		]);

		expect(rejections).toEqual([]);
		expect(examples).toHaveLength(1);
		expect(examples[0]?.example).toEqual({
			messages: [
				{ role: "system", content: "SYS-A\n\nSYS-B" },
				{ role: "user", content: "Please probe" },
				{
					role: "assistant",
					content: "calling",
					tool_calls: [
						{
							id: "call-1",
							type: "function",
							function: { name: "probe", arguments: JSON.stringify(ARGS) },
						},
					],
				},
				{ role: "tool", tool_call_id: "call-1", content: "TOOL-OUT" },
				{ role: "assistant", content: "final answer" },
			],
		});
		expect(examples[0]).toMatchObject({
			schema: "pi-langfuse.training-example/v1",
			format: "openai-chat",
			consent: "unknown",
			license: "",
			notice: TRAINING_REVIEW_NOTICE,
			omitted: ["tool-definitions"],
			source: {
				path: SOURCE,
				requestLine: 1,
				responseLine: 2,
				turnIndex: 1,
			},
		});
	});

	it("converts the same context to Anthropic messages with top-level system and adjacent tool_result", () => {
		const { examples, rejections } = convert(
			[request(1, piContext), answer(1, "final answer")],
			"anthropic-messages",
		);

		expect(rejections).toEqual([]);
		expect(examples[0]?.example).toEqual({
			system: "SYS-A\n\nSYS-B",
			messages: [
				{ role: "user", content: "Please probe" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "calling" },
						{ type: "tool_use", id: "call-1", name: "probe", input: ARGS },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call-1", content: "TOOL-OUT" },
					],
				},
				{ role: "assistant", content: "final answer" },
			],
		});
	});

	it("keeps parallel tool results together in one Anthropic user message", () => {
		const context = [
			{ role: "user", content: "two things" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "t", arguments: {} },
					{ type: "toolCall", id: "b", name: "t", arguments: {} },
				],
			},
			{ role: "toolResult", toolCallId: "b", content: "B" },
			{ role: "toolResult", toolCallId: "a", content: "A" },
		];
		const { examples } = convert(
			[request(0, context), answer(0, "done")],
			"anthropic-messages",
		);
		const messages = messagesOf(examples[0]);
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "b", content: "B" },
				{ type: "tool_result", tool_use_id: "a", content: "A" },
			],
		});
	});

	it("writes a text-only conversation as ShareGPT human/gpt turns", () => {
		const context = [
			{ role: "system", content: "SYS" },
			{ role: "user", content: "Q1" },
			{ role: "assistant", content: [{ type: "text", text: "A1" }] },
			{ role: "user", content: "Q2" },
		];
		const { examples, rejections } = convert(
			[request(0, context), answer(0, "A2")],
			"sharegpt",
		);

		expect(rejections).toEqual([]);
		expect(examples[0]?.example).toEqual({
			system: "SYS",
			conversations: [
				{ from: "human", value: "Q1" },
				{ from: "gpt", value: "A1" },
				{ from: "human", value: "Q2" },
				{ from: "gpt", value: "A2" },
			],
		});
	});

	it("rejects a tool-containing example for ShareGPT instead of flattening it", () => {
		expect(
			reasons([request(1, piContext), answer(1, "final")], "sharegpt"),
		).toEqual(["sharegpt-tools-unsupported"]);
	});

	it("rejects ShareGPT contexts that do not alternate human and gpt", () => {
		const twoUsers = [
			{ role: "user", content: "one" },
			{ role: "user", content: "two" },
		];
		expect(reasons([request(0, twoUsers), answer(0, "x")], "sharegpt")).toEqual(
			["sharegpt-not-alternating"],
		);
	});

	it("joins multiple text blocks with a newline", () => {
		const context = [
			{
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		];
		const { examples } = convert([request(0, context), answer(0, "ok")]);
		expect(messagesOf(examples[0])[0]).toEqual({
			role: "user",
			content: "first\nsecond",
		});
	});
});

describe("request shapes", () => {
	it("converts a Responses input with developer role, function calls, and reasoning", () => {
		const input = [
			{ role: "developer", content: "RESP-SYSTEM" },
			{ role: "user", content: [{ type: "input_text", text: "run it" }] },
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "SUMMARY-NEVER-ANSWER" }],
			},
			{
				type: "function_call",
				call_id: "call_9",
				name: "bash",
				arguments: '{"command":"ls"}',
			},
			{ type: "function_call_output", call_id: "call_9", output: "a.txt" },
		];
		const { examples, rejections } = convert(
			[
				request(0, input, { requestSource: "payload.input" }),
				answer(0, "listed"),
			],
			"openai-chat",
		);

		expect(rejections).toEqual([]);
		const record = examples[0];
		expect(record?.example).toEqual({
			messages: [
				{ role: "system", content: "RESP-SYSTEM" },
				{ role: "user", content: "run it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_9",
							type: "function",
							function: { name: "bash", arguments: '{"command":"ls"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_9", content: "a.txt" },
				{ role: "assistant", content: "listed" },
			],
		});
		// Reasoning is reported as omitted, never converted into answer text.
		expect(record?.omitted).toEqual(["reasoning"]);
		expect(JSON.stringify(record?.example)).not.toContain(
			"SUMMARY-NEVER-ANSWER",
		);
	});

	it("uses the Responses top-level instructions as the system prompt", () => {
		const { examples } = convert(
			[
				request(0, [{ role: "user", content: "hi" }], {
					requestSource: "payload.input",
					systemPrompt: "INSTRUCTIONS-TEXT",
				}),
				answer(0, "hello"),
			],
			"anthropic-messages",
		);
		expect(examples[0]?.example).toMatchObject({
			system: "INSTRUCTIONS-TEXT",
		});
	});

	it("converts a plain-string Responses input as one user turn", () => {
		const { examples } = convert([
			request(0, "just a string", { requestSource: "payload.input" }),
			answer(0, "reply"),
		]);
		expect(examples[0]?.example).toEqual({
			messages: [
				{ role: "user", content: "just a string" },
				{ role: "assistant", content: "reply" },
			],
		});
	});

	it("converts OpenAI chat wire messages and re-serializes arguments strings", () => {
		const wireArguments =
			'{ "path" : "a b.txt",\n "opts": {"deep": [1, {"x": null}]} }';
		const context = [
			{ role: "system", content: "SYS" },
			{ role: "user", content: "read it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_w",
						type: "function",
						function: { name: "read", arguments: wireArguments },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_w", content: "file text" },
		];
		const { examples } = convert([
			request(0, context, { requestSource: "payload.messages" }),
			answer(0, "read ok"),
		]);
		const messages = messagesOf(examples[0]);
		const calls = messages[2]?.tool_calls as Array<{
			function: { arguments: string };
		}>;
		const call = calls[0];
		// Normalized spacing, identical data: the string round-trips through JSON.
		expect(call?.function.arguments).toBe(
			JSON.stringify(JSON.parse(wireArguments)),
		);
		expect(JSON.parse(call?.function.arguments ?? "")).toEqual(
			JSON.parse(wireArguments),
		);
	});

	it("converts Anthropic wire messages with tool_use and tool_result blocks", () => {
		const context = [
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "bash",
						input: { cmd: "ls" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: [{ type: "text", text: "boom" }],
						is_error: true,
					},
				],
			},
		];
		const { examples, rejections } = convert(
			[
				request(0, context, {
					requestSource: "payload.messages",
					systemPrompt: "ANTHROPIC-SYSTEM",
				}),
				answer(0, "it failed"),
			],
			"anthropic-messages",
		);
		expect(rejections).toEqual([]);
		expect(examples[0]?.example).toEqual({
			system: "ANTHROPIC-SYSTEM",
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_1",
							name: "bash",
							input: { cmd: "ls" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							content: "boom",
							is_error: true,
						},
					],
				},
				{ role: "assistant", content: "it failed" },
			],
		});
	});

	it("does not copy visible or encrypted reasoning into any format", () => {
		const context = [
			{ role: "user", content: "think" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "VISIBLE-THOUGHT",
						thinkingSignature: "SIG-123",
					},
					{ type: "redacted_thinking", data: "ENCRYPTED-BLOB" },
					{ type: "text", text: "visible answer" },
				],
			},
			{ role: "user", content: "again" },
		];
		for (const format of [
			"openai-chat",
			"anthropic-messages",
			"sharegpt",
		] as const) {
			const { examples } = convert(
				[
					request(0, context),
					answer(0, "final", { thinking: "FINAL-THOUGHT" }),
				],
				format,
			);
			const text = JSON.stringify(examples[0]);
			expect(examples[0]?.omitted).toEqual(["reasoning"]);
			for (const leaked of [
				"VISIBLE-THOUGHT",
				"SIG-123",
				"ENCRYPTED-BLOB",
				"FINAL-THOUGHT",
			]) {
				expect(text).not.toContain(leaked);
			}
		}
	});

	it.each([
		[
			"image block",
			[
				{
					role: "user",
					content: [{ type: "image", data: "x", mimeType: "image/png" }],
				},
			],
		],
		[
			"image_url part",
			[
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "u" } }],
				},
			],
		],
		["unknown role", [{ role: "critic", content: "x" }]],
		[
			"custom tool call",
			[
				{ role: "user", content: "x" },
				{ type: "custom_tool_call", call_id: "c", name: "n", input: "raw" },
			],
		],
		[
			"mid-conversation system",
			[
				{ role: "user", content: "x" },
				{ role: "system", content: "late" },
			],
		],
		["non-object message", [{ role: "user", content: "x" }, 42]],
		["missing content", [{ role: "user" }]],
	])("rejects unsupported input: %s", (_name, context) => {
		const found = reasons([request(0, context), answer(0, "x")]);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/^(unsupported-|malformed-)/);
	});

	it("rejects Google contents requests as an unsupported source", () => {
		expect(
			reasons([
				request(0, [{ role: "user", parts: [{ text: "x" }] }], {
					requestSource: "payload.contents",
				}),
				answer(0, "x"),
			]),
		).toEqual(["unsupported-request-source-payload-contents"]);
	});
});

describe("tool-call pairing", () => {
	const user = { role: "user", content: "go" };
	const call = (id: string, name = "t") => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
	});
	const result = (
		id: string,
		text = "r",
		extra: Record<string, unknown> = {},
	) => ({
		role: "toolResult",
		toolCallId: id,
		content: text,
		...extra,
	});

	it.each([
		[
			"a call without a result",
			[user, call("a"), { role: "user", content: "next" }],
			"unanswered-tool-call",
		],
		[
			"a context that ends on an unanswered call",
			[user, call("a")],
			"unanswered-tool-call",
		],
		["a result without a call", [user, result("ghost")], "orphan-tool-result"],
		[
			"a result before its call",
			[user, result("a"), call("a")],
			"orphan-tool-result",
		],
		[
			"a duplicated result",
			[user, call("a"), result("a"), result("a")],
			"duplicate-tool-result",
		],
		[
			"a reused call id",
			[user, call("a"), result("a"), call("a"), result("a")],
			"duplicate-tool-call-id",
		],
		[
			"a result naming another tool",
			[user, call("a", "bash"), result("a", "r", { toolName: "read" })],
			"tool-name-mismatch",
		],
		[
			"a context ending on an assistant turn",
			[user, { role: "assistant", content: "prefill" }],
			"context-ends-with-assistant",
		],
		[
			"a context with no user turn",
			[{ role: "system", content: "s" }],
			"no-turns",
		],
		[
			"an empty assistant turn",
			[user, { role: "assistant", content: [] }, user],
			"empty-assistant-turn",
		],
		[
			"unparseable arguments",
			[
				user,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "a",
							type: "function",
							function: { name: "t", arguments: "{not json" },
						},
					],
				},
				result("a"),
			],
			"invalid-tool-arguments",
		],
		[
			"non-object arguments",
			[
				user,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "a",
							type: "function",
							function: { name: "t", arguments: "[1]" },
						},
					],
				},
				result("a"),
			],
			"invalid-tool-arguments",
		],
		[
			"a failed earlier generation in the history",
			[user, { role: "assistant", content: "cut", stopReason: "length" }, user],
			"incomplete-history-turn",
		],
	])("rejects %s", (_name, context, reason) => {
		expect(reasons([request(0, context), answer(0, "x")])).toEqual([reason]);
	});

	it("accepts results in any order and keeps earlier tool calls in the context", () => {
		const context = [
			user,
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "t", arguments: { n: 1 } },
					{ type: "toolCall", id: "b", name: "t", arguments: { n: 2 } },
				],
			},
			result("b", "B"),
			result("a", "A"),
			call("c"),
			result("c", "C"),
		];
		const { examples, rejections } = convert([
			request(0, context),
			answer(0, "ok"),
		]);
		expect(rejections).toEqual([]);
		const messages = messagesOf(examples[0]);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
			"assistant",
			"tool",
			"assistant",
		]);
	});

	it("preserves an error result's flag where the target has one and reports where it does not", () => {
		const context = [user, call("a"), result("a", "exit 1", { isError: true })];
		const records = [request(0, context), answer(0, "failed")];

		const anthropic = convert(records, "anthropic-messages").examples[0];
		expect(messagesOf(anthropic)[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "a",
					content: "exit 1",
					is_error: true,
				},
			],
		});
		expect(anthropic?.omitted).toEqual([]);

		const openai = convert(records, "openai-chat").examples[0];
		expect(openai?.omitted).toEqual(["tool-error-flag"]);
		expect(JSON.stringify(openai?.example)).toContain('"content":"exit 1"');

		// A successful result never carries an error marker.
		const ok = convert(
			[request(0, [user, call("a"), result("a", "fine")]), answer(0, "ok")],
			"anthropic-messages",
		).examples[0];
		expect(JSON.stringify(ok?.example)).not.toContain("is_error");
	});
});

/**
 * Responses items carry `status` (`in_progress | completed | incomplete`) on
 * messages, function calls, function outputs, and reasoning items; the
 * installed OpenAI SDK types (`ResponseOutputMessage`, `ResponseFunctionToolCall`,
 * `ResponseInputItem.FunctionCallOutput`) mark it optional and nullable on the
 * input side, so absence is not evidence of anything.
 */
describe("Responses item completion status", () => {
	const user = { role: "user", content: [{ type: "input_text", text: "go" }] };
	const message = (status?: unknown) => ({
		type: "message",
		role: "assistant",
		...(status === undefined ? {} : { status }),
		content: [{ type: "output_text", text: "earlier answer" }],
	});
	const call = (status?: unknown) => ({
		type: "function_call",
		call_id: "c1",
		name: "bash",
		arguments: "{}",
		...(status === undefined ? {} : { status }),
	});
	const output = (status?: unknown) => ({
		type: "function_call_output",
		call_id: "c1",
		output: "ok",
		...(status === undefined ? {} : { status }),
	});
	const responses = (items: unknown[]) => [
		request(0, items, { requestSource: "payload.input" }),
		answer(0, "final"),
	];
	const followUp = { role: "user", content: "next" };

	it.each([
		[
			"an incomplete assistant message",
			[user, message("incomplete"), followUp],
			"incomplete-history-item-incomplete",
		],
		[
			"an in_progress assistant message",
			[user, message("in_progress"), followUp],
			"incomplete-history-item-in_progress",
		],
		[
			"an incomplete function call",
			[user, call("incomplete"), output("completed")],
			"incomplete-history-item-incomplete",
		],
		[
			"an in_progress function call",
			[user, call("in_progress"), output()],
			"incomplete-history-item-in_progress",
		],
		[
			"an incomplete function output",
			[user, call("completed"), output("incomplete")],
			"incomplete-history-item-incomplete",
		],
		[
			"an in_progress function output",
			[user, call(), output("in_progress")],
			"incomplete-history-item-in_progress",
		],
		[
			"an incomplete reasoning item",
			[
				user,
				{ type: "reasoning", id: "r", status: "incomplete", summary: [] },
				followUp,
			],
			"incomplete-history-item-incomplete",
		],
		[
			"an incomplete user message",
			[{ ...user, status: "incomplete" }],
			"incomplete-history-item-incomplete",
		],
		[
			"an unknown status word",
			[user, message("failed"), followUp],
			"incomplete-history-item-failed",
		],
		[
			"a non-string status",
			[user, message(3), followUp],
			"malformed-item-status",
		],
	])("rejects %s", (_name, items, reason) => {
		expect(reasons(responses(items))).toEqual([reason]);
	});

	it("accepts completed, absent, and null statuses on every supported item", () => {
		const items = [
			user,
			message("completed"),
			followUp,
			call(null),
			output("completed"),
			{ type: "reasoning", id: "r", status: "completed", summary: [] },
			{ role: "user", content: "again" },
		];
		const { examples, rejections } = convert(responses(items));
		expect(rejections).toEqual([]);
		expect(examples).toHaveLength(1);
		// Absence of status is not a reason to reject.
		expect(convert(responses([user, call(), output()])).rejections).toEqual([]);
	});

	it("leaves chat messages that carry no status unaffected", () => {
		expect(
			convert([request(0, [{ role: "user", content: "x" }]), answer(0, "y")])
				.rejections,
		).toEqual([]);
	});
});

describe("requests that depend on stored provider context", () => {
	const input = [
		{ role: "user", content: [{ type: "input_text", text: "continue" }] },
	];

	it.each([
		["previous_response_id", { previous_response_id: "resp_1" }],
		["conversation", { conversation: "conv_1" }],
		["a conversation object", { conversation: { id: "conv_2" } }],
	])(
		"rejects a self-contained-looking request that sets %s",
		(_name, payloadExtra) => {
			// Produced by the real provider-boundary capture, not hand-written.
			const capture = captureProviderRequest({
				model: "m",
				input,
				...payloadExtra,
			});
			const record = request(0, input, {
				requestSource: "payload.input",
				serverSideContext: capture.serverSideContext,
			});
			expect(Object.keys(payloadExtra)).toContain(
				(record.serverSideContext as string[])[0],
			);
			expect(reasons([record, answer(0, "x")])).toEqual([
				"request-server-side-context",
			]);
			// Names only: the ids are never copied into the record.
			expect(JSON.stringify(record)).not.toMatch(/resp_1|conv_1|conv_2/);
		},
	);

	it("rejects the reference even when the capture policy drops metadata", () => {
		const record = request(
			0,
			input,
			{
				requestSource: "payload.input",
				serverSideContext: ["previous_response_id"],
			},
			{ ...FULL, capturePolicy: "conversations", captureMetadata: false },
		);
		expect(record.serverSideContext).toEqual(["previous_response_id"]);
		expect(reasons([record, answer(0, "x")])).toEqual([
			"request-server-side-context",
		]);
	});

	it("does not reject requests without references or with null or empty ones", () => {
		for (const extra of [
			{},
			{ previous_response_id: null, conversation: null },
			{ previous_response_id: "" },
		]) {
			const capture = captureProviderRequest({ model: "m", input, ...extra });
			expect(capture.serverSideContext).toBeUndefined();
		}
		expect(
			convert([
				request(0, input, { requestSource: "payload.input" }),
				answer(0, "x"),
			]).rejections,
		).toEqual([]);
	});
});

describe("response boundaries and retries", () => {
	const context = [{ role: "user", content: "hi" }];

	it.each([
		["aborted", "stop-reason-aborted"],
		["error", "stop-reason-error"],
		["length", "stop-reason-length"],
		["toolUse", "stop-reason-tooluse"],
		[undefined, "stop-reason-unknown"],
	])("rejects a generation that ended with %s", (stopReason, reason) => {
		expect(
			reasons([request(0, context), answer(0, "partial", { stopReason })]),
		).toEqual([reason]);
	});

	it("rejects a stop answer that also carries tool calls or no text", () => {
		expect(
			reasons([
				request(0, context),
				answer(0, "x", { toolCalls: [{ id: "c", name: "t", arguments: {} }] }),
			]),
		).toEqual(["final-response-has-tool-calls"]);
		expect(reasons([request(0, context), answer(0, "  ")])).toEqual([
			"empty-final-response",
		]);
	});

	it("rejects every request and answer of a turn index that repeats in one prompt", () => {
		const found = convert([
			request(0, context),
			answer(0, "failed attempt", { stopReason: "error" }),
			request(0, context),
			answer(0, "retry answer"),
			request(1, [
				...context,
				{ role: "assistant", content: "retry answer" },
				{ role: "user", content: "more" },
			]),
			answer(1, "next"),
		]);
		expect(found.rejections.map((entry) => entry.reason)).toEqual([
			"ambiguous-turn",
			"ambiguous-turn",
		]);
		// Only the unambiguous turn survives.
		expect(found.examples.map((entry) => entry.source.turnIndex)).toEqual([1]);
	});

	it("rejects a request answered twice instead of picking one answer", () => {
		expect(
			reasons([request(0, context), answer(0, "one"), answer(0, "two")]),
		).toEqual(["ambiguous-turn"]);
	});

	it("pairs equal turn indexes across prompts because turnIndex resets", () => {
		const found = convert([
			{ type: "agent_prompt_start", prompt: "first" },
			request(0, context),
			answer(0, "first answer"),
			{ type: "agent_prompt_start", prompt: "second" },
			request(0, [{ role: "user", content: "second" }]),
			answer(0, "second answer"),
		]);
		expect(found.rejections).toEqual([]);
		expect(found.examples.map((entry) => entry.source.requestLine)).toEqual([
			2, 5,
		]);
	});

	it("rejects an unanswered request and an unrequested answer", () => {
		expect(
			reasons([
				request(0, context),
				{ type: "agent_prompt_start" },
				answer(0, "belongs to nothing"),
			]),
		).toEqual(["no-matching-response", "orphan-response"]);
		expect(
			reasons([request(0, context), request(1, context), answer(1, "x")]),
		).toEqual(["no-matching-response"]);
	});

	it("rejects a request whose next record answers a different turn", () => {
		expect(reasons([request(0, context), answer(1, "x")])).toEqual([
			"no-matching-response",
			"orphan-response",
		]);
	});

	it("rejects a pair whose trace ids disagree or exist on one side only", () => {
		expect(
			reasons([
				request(0, context, { traceId: "trace-a" }),
				answer(0, "x", { traceId: "trace-b" }),
			]),
		).toEqual(["trace-mismatch"]);
		expect(
			reasons([request(0, context, { traceId: "trace-a" }), answer(0, "x")]),
		).toEqual(["trace-mismatch"]);
	});

	it("pairs raw-only records that have no trace id on either side", () => {
		expect(
			convert([request(0, context), answer(0, "x")]).examples,
		).toHaveLength(1);
	});

	it("treats an unreadable line as a segment boundary and reports it", () => {
		const found = convertRawTrace(
			jsonl(request(0, context), "{truncated", answer(0, "x")),
			{ format: "openai-chat", source: SOURCE, declaration: DECLARATION },
		);
		expect(found.examples).toEqual([]);
		expect(found.rejections).toEqual([
			{ reason: "malformed-record", line: 2 },
			{ reason: "no-matching-response", line: 1 },
			{ reason: "orphan-response", line: 3 },
		]);
	});

	it("rejects a request without an integer turn index", () => {
		expect(
			reasons([request(0, context, { turnIndex: undefined }), answer(0, "x")]),
		).toEqual(["missing-turn-index", "orphan-response"]);
	});
});

describe("capture bounds", () => {
	const context = [
		{ role: "system", content: "SYS" },
		{ role: "user", content: "a fairly long user prompt for truncation" },
	];

	it("rejects legacy records that have no capture provenance", () => {
		const legacyRequest = request(0, context);
		delete legacyRequest.captureProvenance;
		expect(reasons([legacyRequest, answer(0, "x")])).toEqual([
			"request-capture-provenance-missing",
		]);
		const legacyAnswer = answer(0, "x");
		delete legacyAnswer.captureProvenance;
		expect(reasons([request(0, context), legacyAnswer])).toEqual([
			"response-capture-provenance-missing",
		]);
	});

	it("does not accept a provenance claim that omits a required field", () => {
		const claimless = request(0, context);
		claimless.captureProvenance = { schema: 1, verified: [], degraded: {} };
		expect(reasons([claimless, answer(0, "x")])).toEqual([
			"request-capture-provenance-missing",
		]);
	});

	it("rejects diagnostic summary records as lossy", () => {
		const summary = emit({
			type: "provider_request",
			turnIndex: 0,
			captureMode: "summary",
			requestSource: "payload.context",
			messageCount: 2,
			messagesSummary: [{ role: "user", content: "a fairly lo…" }],
			messagesSummaryOmitted: 0,
			fullMessagesOmitted: true,
		});
		expect(reasons([summary, answer(0, "x")])).toEqual([
			"request-not-full-capture",
		]);
	});

	it("rejects full records whose contents were never observed", () => {
		const unobserved = emit({
			type: "provider_request",
			turnIndex: 0,
			captureMode: "full",
		});
		expect(reasons([unobserved, answer(0, "x")])).toEqual([
			"unsupported-request-source-unknown",
		]);
		const noContents = emit({
			type: "provider_request",
			turnIndex: 0,
			captureMode: "full",
			requestSource: "payload.context",
		});
		expect(reasons([noContents, answer(0, "x")])).toEqual([
			"request-messages-missing",
		]);
	});

	it("rejects records the budget truncated, in the request or the answer", () => {
		const limited = { ...FULL, payloadMaxStringChars: 25 };
		expect(reasons([request(0, context, {}, limited), answer(0, "x")])).toEqual(
			["request-capture-budget-truncated"],
		);
		expect(
			reasons([
				request(0, context),
				answer(0, "an answer longer than the limit of 25", {}, limited),
			]),
		).toEqual(["response-capture-budget-truncated"]);
		expect(
			reasons([
				request(0, context, {}, { ...FULL, payloadMaxArrayItems: 1 }),
				answer(0, "x"),
			]),
		).toEqual(["request-capture-budget-truncated"]);
	});

	it("rejects records the capture policy removed content from", () => {
		const withToolResult = [
			{ role: "user", content: "run" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "a", name: "t", arguments: {} }],
			},
			{
				role: "toolResult",
				toolCallId: "a",
				content: [{ type: "text", text: "SECRET-OUT" }],
			},
		];
		expect(
			reasons([
				request(0, withToolResult, {}, { ...FULL, captureToolOutput: false }),
				answer(0, "x"),
			]),
		).toEqual(["request-capture-policy-omitted"]);
		expect(
			reasons([
				request(
					0,
					context,
					{},
					{
						...FULL,
						captureProviderInput: false,
						capturePrompt: false,
						captureSystemPrompt: false,
						captureAssistantOutput: false,
						captureToolOutput: false,
					},
				),
				answer(0, "x"),
			]),
		).toEqual(["request-capture-policy-omitted"]);
		expect(
			reasons([
				request(0, context),
				answer(0, "x", {}, { ...FULL, captureAssistantOutput: false }),
			]),
		).toEqual(["response-capture-policy-omitted"]);
		// With tool-call capture off the empty call list cannot be proven.
		expect(
			reasons([
				request(0, context),
				answer(0, "x", {}, { ...FULL, captureToolInput: false }),
			]),
		).toEqual(["response-capture-policy-omitted"]);
	});

	it("rejects a request whose recorded item count no longer matches the items", () => {
		const shortened = request(0, context);
		shortened.messageCount = 5;
		expect(reasons([shortened, answer(0, "x")])).toEqual([
			"request-cardinality-mismatch",
		]);
	});
});

describe("malformed history shapes", () => {
	const user = { role: "user", content: "go" };
	const assistantWith = (extra: Record<string, unknown>) => ({
		role: "assistant",
		...extra,
	});
	const wireCall = (call: unknown) =>
		assistantWith({ content: null, tool_calls: [call] });
	const functionCall = (fn: unknown, extra: Record<string, unknown> = {}) => ({
		id: "a",
		type: "function",
		function: fn,
		...extra,
	});

	it.each([
		["a non-record block in user content", [{ role: "user", content: ["x"] }]],
		[
			"a text block without string text",
			[{ role: "user", content: [{ type: "text", text: 5 }] }],
		],
		[
			"a block in user content that has no type",
			[{ role: "user", content: [{ text: "x" }] }],
		],
		[
			"assistant content that is a number",
			[user, assistantWith({ content: 5 })],
		],
		["a non-record assistant block", [user, assistantWith({ content: ["x"] })]],
		["a null assistant block", [user, assistantWith({ content: [null] })]],
		[
			"an assistant block that has no type",
			[user, assistantWith({ content: [{ text: "x" }] })],
		],
		[
			"an assistant block whose type is not text",
			[user, assistantWith({ content: [{ type: 5, text: "x" }] })],
		],
		[
			"an assistant text block without string text",
			[user, assistantWith({ content: [{ type: "text" }] })],
		],
		[
			"a system section that is not text",
			[{ role: "system", sections: { a: 5 } }, user],
		],
		[
			"system sections that are not a record",
			[{ role: "system", sections: "all" }, user],
		],
		[
			"a system message with non-text content",
			[{ role: "system", content: 5 }, user],
		],
	])("rejects %s as malformed content", (_name, context) => {
		expect(reasons([request(0, context), answer(0, "x")])).toEqual([
			"malformed-content",
		]);
	});

	it.each([
		[
			"an unsupported user block type",
			[{ role: "user", content: [{ type: "image" }] }],
			"unsupported-content-image",
		],
		[
			"an unsupported assistant block type",
			[user, assistantWith({ content: [{ type: "image" }] }), user],
			"unsupported-content-image",
		],
		[
			"an empty block type, slugged as empty",
			[{ role: "user", content: [{ type: "" }] }],
			"unsupported-content-empty",
		],
		[
			"a symbol-only role, slugged by its letters",
			[{ role: "Wei rd!" }],
			"unsupported-role-wei-rd-",
		],
		[
			"tool_calls that are not a list",
			[user, assistantWith({ content: "x", tool_calls: "none" }), user],
			"malformed-tool-call",
		],
		[
			"a tool call that is not a record",
			[user, wireCall("call"), user],
			"unsupported-tool-call-type",
		],
		[
			"a tool call of another type",
			[user, wireCall(functionCall({}, { type: "custom" })), user],
			"unsupported-tool-call-type",
		],
		[
			"a tool call without a function record",
			[user, wireCall(functionCall("fn")), user],
			"malformed-tool-call",
		],
		[
			"a tool call with an empty id",
			[
				user,
				wireCall(functionCall({ name: "t", arguments: {} }, { id: "" })),
				user,
			],
			"malformed-tool-call",
		],
		[
			"a tool call with a numeric id",
			[
				user,
				wireCall(functionCall({ name: "t", arguments: {} }, { id: 7 })),
				user,
			],
			"malformed-tool-call",
		],
		[
			"a tool call with numeric arguments",
			[user, wireCall(functionCall({ name: "t", arguments: 5 })), user],
			"invalid-tool-arguments",
		],
		[
			"a message that is neither text nor a record",
			[user, 5],
			"malformed-message",
		],
		[
			"a tool message without a call id",
			[user, { role: "tool", content: "r" }],
			"malformed-tool-result",
		],
		[
			"a system message after the first message",
			[user, { role: "system", content: "s" }],
			"unsupported-midconversation-system",
		],
		[
			"a context with no user turn after a tool exchange",
			[
				wireCall(functionCall({ name: "t", arguments: {} })),
				{ role: "tool", tool_call_id: "a", content: "r" },
			],
			"no-user-turn",
		],
	])("rejects %s", (_name, context, reason) => {
		expect(reasons([request(0, context), answer(0, "x")])).toEqual([reason]);
	});

	it("rejects an Anthropic example whose context opens with an assistant message", () => {
		const context = [{ role: "assistant", content: "prefill" }, user];

		expect(
			reasons([request(0, context), answer(0, "x")], "anthropic-messages"),
		).toEqual(["anthropic-first-message-not-user"]);
		// The same context is a valid OpenAI chat example.
		expect(
			convert([request(0, context), answer(0, "x")]).examples,
		).toHaveLength(1);
	});

	it("rejects a top-level system prompt combined with a system message", () => {
		expect(
			reasons([
				request(0, [{ role: "system", content: "inner" }, user], {
					systemPrompt: "outer",
				}),
				answer(0, "x"),
			]),
		).toEqual(["multiple-system-sources"]);
	});

	it("rejects request messages that are neither text nor a list", () => {
		expect(reasons([request(0, { not: "a list" }), answer(0, "x")])).toEqual([
			"malformed-request-messages",
		]);
	});

	it("rejects a top-level system prompt that is not text", () => {
		expect(
			reasons([request(0, [user], { systemPrompt: 5 }), answer(0, "x")]),
		).toEqual(["malformed-content"]);
	});

	it("rejects a final answer whose tool-call list is not a list", () => {
		expect(
			reasons([request(0, [user]), answer(0, "x", { toolCalls: "none" })]),
		).toEqual(["malformed-response"]);
	});

	it("keeps a Responses function call on the assistant step before it", () => {
		const { examples } = convert([
			request(0, [
				user,
				{ role: "assistant", content: "calling" },
				{ type: "function_call", call_id: "c", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c", output: "done" },
			]),
			answer(0, "ok"),
		]);
		const messages = messagesOf(examples[0]);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(messages[1]).toMatchObject({
			content: "calling",
			tool_calls: [{ id: "c", function: { name: "t", arguments: "{}" } }],
		});
	});

	it("treats an Anthropic tool_result without content as an empty result", () => {
		const { examples } = convert([
			request(0, [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "a", name: "t", input: {} }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "a" }],
				},
			]),
			answer(0, "ok"),
		]);
		expect(messagesOf(examples[0])[2]).toEqual({
			role: "tool",
			tool_call_id: "a",
			content: "",
		});
	});

	it("does not turn an unexpected failure into a rejection", () => {
		const declaration = {
			consent: "unknown",
			get license(): string {
				throw new Error("declaration unavailable");
			},
		} as const;
		expect(() =>
			convert([request(0, [user]), answer(0, "x")], "openai-chat", declaration),
		).toThrow("declaration unavailable");
	});
});

describe("system text, provenance claims, and example identity", () => {
	const user = { role: "user", content: "go" };

	it("renders a system message from its present content and non-null sections only", () => {
		const system = (extra: Record<string, unknown>) => ({
			role: "system",
			...extra,
		});
		const systemOf = (message: Record<string, unknown>) => {
			const { examples, rejections } = convert([
				request(0, [message, user]),
				answer(0, "x"),
			]);
			expect(rejections).toEqual([]);
			return messagesOf(examples[0])[0];
		};

		expect(systemOf(system({ content: null, sections: { a: "SEC" } }))).toEqual(
			{
				role: "system",
				content: "SEC",
			},
		);
		expect(systemOf(system({ sections: { a: "SEC" } }))).toEqual({
			role: "system",
			content: "SEC",
		});
		expect(
			systemOf(system({ content: "A", sections: { s: "B", t: "" } })),
		).toEqual({ role: "system", content: "A\n\nB" });
		expect(systemOf(system({ content: "", sections: { s: "B" } }))).toEqual({
			role: "system",
			content: "B",
		});
	});

	it("rejects a call that stays unanswered into the next turn even if a result follows later", () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "a", name: "t", arguments: {} }],
		};
		const result = { role: "toolResult", toolCallId: "a", content: "r" };

		expect(
			reasons([
				request(0, [user, call, { role: "user", content: "next" }, result]),
				answer(0, "x"),
			]),
		).toEqual(["unanswered-tool-call"]);
	});

	it.each([
		[
			"a different schema version",
			{ schema: 2, verified: ["messages"], degraded: {} },
		],
		[
			"a verified list that is not a list",
			{
				schema: 1,
				verified: "messages systemPrompt",
				degraded: {},
			},
		],
		[
			"a degraded map that is not a record",
			{
				schema: 1,
				verified: ["messages", "systemPrompt"],
				degraded: [],
			},
		],
	])("rejects a request whose provenance claims %s", (_name, claim) => {
		const tampered = request(0, [{ role: "system", content: "S" }, user]);
		tampered.captureProvenance = claim;

		expect(reasons([tampered, answer(0, "x")])).toEqual([
			"request-capture-provenance-missing",
		]);
	});

	it("records one-character reasoning as omitted, and empty reasoning as nothing", () => {
		const records = (thinking: string) => [
			request(0, [user]),
			answer(0, "final", { thinking }),
		];

		expect(convert(records("a")).examples[0]?.omitted).toEqual(["reasoning"]);
		expect(convert(records("")).examples[0]?.omitted).toEqual([]);
	});

	it("gives each example a stable 16-hex-character id", () => {
		const records = [request(0, [user]), answer(0, "x")];

		const first = convert(records).examples[0]?.id;
		const second = convert(records).examples[0]?.id;

		expect(first).toMatch(/^[0-9a-f]{16}$/);
		expect(second).toBe(first);
	});

	it("carries the provider and model of the request when they are text", () => {
		const withBoth = convert([
			request(0, [user], { provider: "prov", model: "mod" }),
			answer(0, "x"),
		]).examples[0];
		const without = convert([request(0, [user]), answer(0, "x")]).examples[0];
		const notText = convert([
			request(0, [user], { provider: 5, model: { id: "m" } }),
			answer(0, "x"),
		]).examples[0];

		expect(withBoth).toMatchObject({ provider: "prov", model: "mod" });
		for (const example of [without, notText]) {
			expect(example).not.toHaveProperty("provider");
			expect(example).not.toHaveProperty("model");
		}
	});
});
