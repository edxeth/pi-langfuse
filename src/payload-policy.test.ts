import { describe, expect, it } from "vitest";
import {
	getPayloadLimits,
	isCaptureEnabled,
	shapeExportValue,
	shapeLangfuseObservationBody,
	shapeLangfuseTraceBody,
	shapeRawTraceRecord,
	shapeTelemetryValue,
} from "./payload-policy.js";

const baseConfig = {
	redactionEnabled: true,
	secretKey: "sk-lf-test-secret-1234567890",
	redactionAdditionalSecrets: ["configured-secret-123456789"],
};

describe("payload policy", () => {
	it("selects the four capture presets and supports field overrides", () => {
		const input = {
			name: "pi-agent",
			input: "user prompt",
			output: "assistant output",
			metadata: { systemPrompt: "system prompt", model: "model" },
		};

		const metadataOnly = shapeLangfuseTraceBody(
			{ ...baseConfig, capturePolicy: "metadata-only" },
			input,
		);
		expect(metadataOnly).not.toHaveProperty("input");
		expect(metadataOnly).not.toHaveProperty("output");
		expect(metadataOnly.metadata).not.toHaveProperty("systemPrompt");
		expect(metadataOnly.metadata).toMatchObject({ model: "model" });

		const promptsOnly = shapeLangfuseTraceBody(
			{ ...baseConfig, capturePolicy: "prompts-only" },
			input,
		);
		expect(promptsOnly.input).toBe("user prompt");
		expect(promptsOnly).not.toHaveProperty("output");
		expect(promptsOnly.metadata).toMatchObject({
			systemPrompt: "system prompt",
		});

		const conversations = shapeLangfuseObservationBody(
			{ ...baseConfig, capturePolicy: "conversations" },
			"llm-response",
			{
				name: "llm-response",
				input: [{ content: "conversation" }],
				output: "answer",
			},
		);
		expect(conversations.input).toEqual([{ content: "conversation" }]);
		expect(conversations.output).toBe("answer");

		const fullDebug = shapeLangfuseObservationBody(
			{ ...baseConfig },
			"tool:bash",
			{
				name: "tool:bash",
				input: "args",
				output: "result",
				errorMessage: "error sk-lf-test-secret-1234567890",
			},
		);
		expect(fullDebug.input).toBe("args");
		expect(fullDebug.output).toBe("result");
		expect(fullDebug.errorMessage).not.toContain(
			"sk-lf-test-secret-1234567890",
		);

		const mixedHistory = shapeLangfuseObservationBody(
			{
				...baseConfig,
				capturePolicy: "conversations",
				capturePrompt: false,
				captureSystemPrompt: false,
				captureToolOutput: false,
			},
			"llm-response",
			{
				name: "llm-response",
				input: [
					{ role: "system", content: "system text" },
					{ role: "user", content: "user text" },
					{ role: "assistant", content: "assistant text" },
					{ role: "tool", content: "tool text" },
				],
			},
		);
		expect(mixedHistory.input).toEqual([
			{ role: "system" },
			{ role: "user" },
			{ role: "assistant", content: "assistant text" },
			{ role: "tool" },
		]);

		const keyedSecret = shapeLangfuseTraceBody(
			{ ...baseConfig },
			{
				name: "pi-agent",
				metadata: { apiKey: "custom-key-not-matching-patterns" },
			},
		);
		expect(JSON.stringify(keyedSecret)).not.toContain(
			"custom-key-not-matching-patterns",
		);

		const overridden = shapeLangfuseObservationBody(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolOutput: true,
			},
			"tool:bash",
			{ name: "tool:bash", input: "args", output: "result" },
		);
		expect(overridden).not.toHaveProperty("input");
		expect(overridden.output).toBe("result");
		expect(
			isCaptureEnabled(
				{ ...baseConfig, capturePolicy: "conversations" },
				"toolOutput",
			),
		).toBe(false);
		expect(
			isCaptureEnabled(
				{
					...baseConfig,
					capturePolicy: "conversations",
					captureToolOutput: true,
				},
				"toolOutput",
			),
		).toBe(true);
	});

	it("bounds every payload dimension after redaction", () => {
		const circular: Record<string, unknown> = {
			secret: "sk-lf-test-secret-1234567890",
			long: "abcdefghijk",
			deep: { value: "too deep" },
			wideA: "a",
			wideB: "b",
			wideC: "c",
			array: ["one", "two", "three"],
		};
		circular.self = circular;

		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				payloadMaxStringChars: 4,
				payloadMaxToolChars: 3,
				payloadMaxDepth: 2,
				payloadMaxArrayItems: 1,
				payloadMaxObjectKeys: 7,
				payloadMaxNodes: 20,
			},
			{
				type: "tool_execution_end",
				resultSummary: "tool output that is too long",
				args: circular,
			},
		);

		expect(shaped.resultSummary).toHaveLength(3);
		expect(shaped.args).toMatchObject({
			secret: expect.any(String),
		});
		expect(
			String((shaped.args as Record<string, unknown>).secret),
		).not.toContain("sk-lf-test-secret-1234567890");
		expect(Object.keys(shaped.args as Record<string, unknown>)).toHaveLength(7);
		expect((shaped.args as { array?: unknown[] }).array).toHaveLength(1);
		expect(shaped.args).not.toHaveProperty("self");
		expect(JSON.stringify(shaped)).not.toContain(
			"sk-lf-test-secret-1234567890",
		);
		expect(JSON.stringify(shaped)).not.toContain("too deep");
	});

	it("bounds deep and wide values before they reach the telemetry boundary", () => {
		let deep: Record<string, unknown> = { value: "leaf" };
		for (let index = 0; index < 2_000; index += 1) {
			deep = { next: deep };
		}
		const wide = Object.fromEntries(
			Array.from({ length: 2_000 }, (_, index) => [`key-${index}`, index]),
		);
		const shaped = shapeLangfuseObservationBody(
			{
				...baseConfig,
				payloadMaxDepth: 3,
				payloadMaxObjectKeys: 2,
				payloadMaxNodes: 7,
			},
			"llm-response",
			{ name: "llm-response", input: { deep, wide }, output: "answer" },
		);
		const input = shaped.input as { deep?: unknown; wide?: unknown };
		expect(input).toBeDefined();
		expect(Object.keys(input?.wide as Record<string, unknown>)).toHaveLength(2);
		expect(JSON.stringify(input?.deep)).not.toContain('"leaf"');
		expect(shaped).not.toHaveProperty("output");
	});

	it("keeps identity fields while bounding content-bearing metadata", () => {
		const shaped = shapeLangfuseObservationBody(
			{
				...baseConfig,
				payloadMaxStringChars: 3,
				payloadMaxObjectKeys: 2,
			},
			"agent.turn",
			{
				name: "agent.turn",
				traceId: "trace-id",
				parentObservationId: "parent-id",
				metadata: { first: "one", second: "two" },
				errorMessage: "long error message",
			},
		);
		expect(shaped).toMatchObject({
			name: "agent.turn",
			traceId: "trace-id",
			parentObservationId: "parent-id",
		});
		expect(
			Object.keys(shaped.metadata as Record<string, unknown>),
		).toHaveLength(2);
		expect(shaped.errorMessage).toBe("lon");

		const minimal = shapeLangfuseTraceBody(
			{ ...baseConfig, payloadMaxNodes: 0 },
			{
				name: "pi-agent",
				traceId: "trace-id",
				sessionId: "session-id",
				metadata: { secret: "not captured" },
			},
		);
		expect(minimal).toMatchObject({
			name: "pi-agent",
			traceId: "trace-id",
			sessionId: "session-id",
		});
		expect(minimal).not.toHaveProperty("metadata");
	});

	it("keeps unlimited budgets explicit and preserves export redaction", () => {
		const config = {
			...baseConfig,
			payloadMaxStringChars: Infinity,
			payloadMaxToolChars: Infinity,
			payloadMaxDepth: Infinity,
			payloadMaxArrayItems: Infinity,
			payloadMaxObjectKeys: Infinity,
			payloadMaxNodes: Infinity,
		};
		expect(getPayloadLimits(config)).toEqual({
			maxStringChars: Infinity,
			maxToolChars: Infinity,
			maxDepth: Infinity,
			maxArrayItems: Infinity,
			maxObjectKeys: Infinity,
			maxNodes: Infinity,
		});
		const exported = shapeExportValue(
			{ ...config, redactionEnabled: false, payloadMaxStringChars: 1 },
			{ message: "sk-lf-test-secret-1234567890" },
		);
		expect(exported.message).toContain("[REDACTED:langfuse-secret-key:");
	});

	// Full-mode raw records carry unroled Responses input items (the shapes
	// pi builds for the Responses API). Tool fields must follow tool capture
	// policy and reasoning contents must never be captured.
	const responsesFullMessages = () => [
		{
			role: "user",
			content: [{ type: "input_text", text: "INPUT-user text" }],
		},
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "INPUT-assistant text" }],
		},
		{
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "bash",
			arguments: '{"command":"LEAK-tool-arguments"}',
		},
		{
			type: "custom_tool_call",
			id: "ctc_1",
			call_id: "call_2",
			name: "edit",
			input: "LEAK-custom-tool-input",
		},
		{
			type: "function_call_output",
			call_id: "call_1",
			output: "LEAK-tool-output",
		},
		{
			type: "custom_tool_call_output",
			call_id: "call_2",
			output: "LEAK-custom-tool-output",
		},
		{
			type: "reasoning",
			id: "rs_1",
			summary: [{ type: "summary_text", text: "LEAK-reasoning-summary" }],
			content: [{ type: "reasoning_text", text: "LEAK-reasoning-content" }],
			encrypted_content: "LEAK-encrypted-content",
		},
	];

	it("honors tool capture opt-outs on unroled Responses items in full raw records", () => {
		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolInput: false,
				captureToolOutput: false,
			},
			{
				type: "provider_request",
				captureMode: "full",
				messages: responsesFullMessages(),
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).not.toContain("LEAK-tool-arguments");
		expect(json).not.toContain("LEAK-custom-tool-input");
		expect(json).not.toContain("LEAK-tool-output");
		expect(json).not.toContain("LEAK-custom-tool-output");
		// Conversation contents and item structure remain.
		expect(json).toContain("INPUT-user text");
		expect(json).toContain("INPUT-assistant text");
		expect(json).toContain("bash");
		expect(json).toContain("call_1");
	});

	// Unrecognized unroled item types are not tool data: their fields fall
	// back to the role-based mapping (empty role), so only the arguments key
	// keeps tool policy and everything else follows provider/metadata policy.
	it("keeps role-based field classification for unrecognized unroled item types", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "conversations" },
			{
				type: "provider_request",
				messages: [
					{
						type: "web_search_call",
						id: "ws_1",
						status: "completed",
						arguments: "LEAK-search-args",
						content: "KEEP-search-content",
					},
				],
			},
		);
		const items = shaped.messages as Array<Record<string, unknown>>;

		expect(Object.keys(items[0] ?? {})).toEqual([
			"type",
			"id",
			"status",
			"content",
		]);
		expect(items[0]).toMatchObject({
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			content: "KEEP-search-content",
		});
		expect(JSON.stringify(shaped)).not.toContain("LEAK-search-args");
	});

	// Role-bearing messages keep the role-based mapping even when a type
	// field is present: a typed role message must not lose its content to
	// item-type classification.
	it("keeps the role-based mapping for role messages that carry a type", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "conversations" },
			{
				type: "provider_request",
				messages: [
					{
						role: "user",
						type: "reasoning",
						content: "KEEP-typed-role-content",
					},
				],
			},
		);
		const items = shaped.messages as Array<Record<string, unknown>>;

		expect(items[0]).toMatchObject({
			role: "user",
			type: "reasoning",
			content: "KEEP-typed-role-content",
		});
	});

	// When the node budget runs out mid-list, whole later messages are
	// omitted: two fully-shaped simple messages consume exactly four nodes
	// (message + content string each), so the third hits the guard.
	it("omits whole messages once the node budget is exhausted", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, payloadMaxNodes: 4 },
			{
				type: "provider_request",
				messages: [
					{ role: "user", content: "KEEP-first message" },
					{ role: "user", content: "KEEP-second message" },
					{ role: "user", content: "LEAK-third message" },
				],
			},
		);
		const items = shaped.messages as Array<Record<string, unknown>>;

		expect(items).toHaveLength(2);
		expect(JSON.stringify(items)).toContain("KEEP-first message");
		expect(JSON.stringify(items)).toContain("KEEP-second message");
		expect(JSON.stringify(shaped)).not.toContain("LEAK-third message");
	});

	// A message keeps at most maxObjectKeys content keys after its role;
	// later keys (including content) are dropped at the first overflow.
	it("drops message keys beyond the per-message object key budget", () => {
		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				payloadMaxObjectKeys: 2,
			},
			{
				type: "provider_request",
				messages: [
					{
						role: "user",
						k1: "KEEP-one",
						k2: "KEEP-two",
						k3: "LEAK-three",
						content: "LEAK-content",
					},
				],
			},
		);
		const items = shaped.messages as Array<Record<string, unknown>>;

		expect(Object.keys(items[0] ?? {})).toEqual(["role", "k1", "k2"]);
		expect(items[0]).toMatchObject({
			role: "user",
			k1: "KEEP-one",
			k2: "KEEP-two",
		});
		expect(JSON.stringify(shaped)).not.toContain("LEAK-three");
		expect(JSON.stringify(shaped)).not.toContain("LEAK-content");
	});

	// The node-budget guard also fires inside a message: once earlier keys
	// exhaust the budget, a provider-input content array must drop its nested
	// messages entirely instead of partially shaping them.
	it("drops nested provider-input messages once the node budget is exhausted", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, payloadMaxNodes: 2 },
			{
				type: "provider_request",
				messages: [
					{
						type: "web_search_call",
						marker: "KEEP-marker",
						content: [{ role: "user", content: "LEAK-nested" }],
					},
				],
			},
		);
		const items = shaped.messages as Array<Record<string, unknown>>;

		expect(items).toHaveLength(1);
		expect(items[0]?.content).toEqual([]);
		expect(JSON.stringify(shaped)).not.toContain("LEAK-nested");
	});

	// Role-bearing Anthropic messages carry tool data inside their content
	// blocks (tool_use.input on assistant messages, tool_result content on
	// user messages). Nested blocks must follow tool capture policy instead
	// of the enclosing message's field.
	const anthropicFullMessages = () => [
		{
			role: "user",
			content: [{ type: "text", text: "ANTHROPIC-user text" }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "ANTHROPIC-answer" },
				{
					type: "tool_use",
					id: "call_1",
					name: "bash",
					input: { command: "ANTHROPIC-tool-arguments" },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call_1",
					content: [{ type: "text", text: "ANTHROPIC-tool output" }],
				},
			],
		},
	];

	it("honors tool opt-outs on nested Anthropic tool blocks in full raw records", () => {
		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolInput: false,
				captureToolOutput: false,
			},
			{
				type: "provider_request",
				captureMode: "full",
				messages: anthropicFullMessages(),
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).not.toContain("ANTHROPIC-tool-arguments");
		expect(json).not.toContain("ANTHROPIC-tool output");
		// Conversation text and block correlation stay.
		expect(json).toContain("ANTHROPIC-answer");
		expect(json).toContain("ANTHROPIC-user text");
		expect(json).toContain("call_1");
		expect(json).toContain("bash");
	});

	it("captures nested Anthropic tool blocks under full-debug", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig },
			{
				type: "provider_request",
				captureMode: "full",
				messages: anthropicFullMessages(),
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).toContain("ANTHROPIC-tool-arguments");
		expect(json).toContain("ANTHROPIC-tool output");
	});

	// Installed Google Generative AI full-request shape: contents items carry
	// role plus parts; functionCall/functionResponse parts are tool data and
	// thought parts are reasoning; the system prompt rides in config.systemInstruction.
	const googleFullMessages = () => [
		{ role: "user", parts: [{ text: "GOOGLE-user text" }] },
		{
			role: "model",
			parts: [
				{ thought: true, text: "GOOGLE-thought" },
				{ text: "GOOGLE-answer" },
				{
					functionCall: {
						name: "read",
						args: { path: "GOOGLE-tool-arguments" },
						id: "call_1",
					},
				},
			],
		},
		{
			role: "user",
			parts: [
				{
					functionResponse: {
						name: "read",
						response: { output: "GOOGLE-tool output" },
					},
				},
			],
		},
	];

	it("honors tool opt-outs on Google contents parts in full raw records", () => {
		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolInput: false,
				captureToolOutput: false,
			},
			{
				type: "provider_request",
				captureMode: "full",
				messages: googleFullMessages(),
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).not.toContain("GOOGLE-tool-arguments");
		expect(json).not.toContain("GOOGLE-tool output");
		// Conversation text and tool identity stay.
		expect(json).toContain("GOOGLE-user text");
		expect(json).toContain("GOOGLE-answer");
		expect(json).toContain("read");
		expect(json).toContain("call_1");
	});

	it("excludes Google thought parts and honors the system-prompt field policy", () => {
		const withInstruction = () => ({
			type: "provider_request",
			captureMode: "full",
			messages: googleFullMessages(),
			systemPrompt: "GOOGLE-system instruction",
		});

		const fullDebug = shapeRawTraceRecord({ ...baseConfig }, withInstruction());
		const fullDebugJson = JSON.stringify(fullDebug);
		expect(fullDebugJson).toContain("GOOGLE-system instruction");
		expect(fullDebugJson).not.toContain("GOOGLE-thought");
		expect(fullDebugJson).toContain("GOOGLE-tool-arguments");

		const promptsOnly = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "prompts-only" },
			withInstruction(),
		);
		const promptsOnlyJson = JSON.stringify(promptsOnly);
		// Prompts-only keeps prompt and system-prompt content while dropping
		// model output and tool data.
		expect(promptsOnlyJson).toContain("GOOGLE-user text");
		expect(promptsOnlyJson).toContain("GOOGLE-system instruction");
		expect(promptsOnlyJson).not.toContain("GOOGLE-answer");
		expect(promptsOnlyJson).not.toContain("GOOGLE-tool-arguments");
		expect(promptsOnlyJson).not.toContain("GOOGLE-tool output");
	});

	it("honors the tool-output opt-out on Pi toolResult context messages", () => {
		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolOutput: false,
			},
			{
				type: "provider_request",
				captureMode: "full",
				messages: [
					{ role: "user", content: "PI-user text" },
					{
						role: "toolResult",
						toolCallId: "t1",
						content: [{ type: "text", text: "PI-tool output" }],
					},
				],
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).not.toContain("PI-tool output");
		expect(json).toContain("PI-user text");
		expect(json).toContain("t1");
	});

	// Native pi-protocol tool blocks ({type: "toolCall"}) carry the same
	// tool-call data as Anthropic tool_use blocks and must follow the same
	// capture policy; pi thinking blocks keep their visible text under the
	// assistant-output policy, but the encrypted reasoning carrier
	// (redacted_thinking.data) is never captured, like Responses encrypted
	// reasoning and Google thought parts.
	const piFullMessages = () => [
		{ role: "user", content: "PI-user text" },
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "PI-KEEP-thinking text",
				},
				{ type: "text", text: "PI-answer" },
				{
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "PI-LEAK-tool arguments" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "PI-LEAK-tool output" }],
		},
	];

	it("honors the tool-input opt-out on native pi toolCall blocks", () => {
		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolInput: false,
				captureToolOutput: false,
			},
			{
				type: "provider_request",
				captureMode: "full",
				messages: piFullMessages(),
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).not.toContain("PI-LEAK-tool arguments");
		expect(json).not.toContain("PI-LEAK-tool output");
		// Conversation text and block correlation stay.
		expect(json).toContain("PI-answer");
		expect(json).toContain("PI-KEEP-thinking text");
		expect(json).toContain("call_1");
		expect(json).toContain("bash");
	});

	it("captures native pi toolCall blocks and keeps thinking text under full-debug", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig },
			{
				type: "provider_request",
				captureMode: "full",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "PI-KEEP-thinking text" },
							{
								type: "toolCall",
								id: "call_1",
								name: "bash",
								arguments: { command: "PI-KEEP-tool arguments" },
							},
						],
					},
				],
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).toContain("PI-KEEP-tool arguments");
		expect(json).toContain("PI-KEEP-thinking text");
	});

	it("never captures Anthropic redacted_thinking data at any policy", () => {
		const messages = () => [
			{
				role: "assistant",
				content: [
					{
						type: "redacted_thinking",
						data: "REDACTED-ENCRYPTED-blob",
					},
					{ type: "text", text: "ANTHROPIC-answer" },
				],
			},
		];

		for (const capturePolicy of ["conversations", "full-debug"] as const) {
			const shaped = shapeRawTraceRecord(
				{ ...baseConfig, capturePolicy },
				{
					type: "provider_request",
					captureMode: "full",
					messages: messages(),
				},
			);
			const json = JSON.stringify(shaped);
			expect(json).not.toContain("REDACTED-ENCRYPTED-blob");
			// The block type stays for correlation; visible text is unchanged.
			expect(json).toContain("redacted_thinking");
			expect(json).toContain("ANTHROPIC-answer");
		}
	});

	// Pi system messages keep the prompt text in named `sections`; the
	// sections are system-prompt content and must follow the system-prompt
	// capture field, not the metadata field.
	it("classifies pi system message sections under the system-prompt policy", () => {
		const record = () => ({
			type: "provider_request",
			captureMode: "full",
			messages: [
				{
					role: "system",
					content: "",
					sections: { preamble: "PISECTIONS-preamble text" },
				},
				{ role: "user", content: "PI-user text" },
			],
		});

		const fullDebug = shapeRawTraceRecord({ ...baseConfig }, record());
		expect(JSON.stringify(fullDebug)).toContain("PISECTIONS-preamble text");

		const promptsOnly = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "prompts-only" },
			record(),
		);
		expect(JSON.stringify(promptsOnly)).toContain("PISECTIONS-preamble text");

		const metadataOnly = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "metadata-only" },
			record(),
		);
		// Metadata-only omits the provider-input messages wholesale (existing
		// contract), which also drops the sections text.
		expect(metadataOnly).not.toHaveProperty("messages");
	});

	it("captures visible Responses summaries while excluding opaque reasoning content", () => {
		for (const capturePolicy of ["conversations", "full-debug"] as const) {
			const shaped = shapeRawTraceRecord(
				{ ...baseConfig, capturePolicy },
				{
					type: "provider_request",
					captureMode: "full",
					messages: responsesFullMessages(),
				},
			);
			const json = JSON.stringify(shaped);

			expect(json).toContain("LEAK-reasoning-summary");
			expect(json).not.toContain("LEAK-reasoning-content");
			expect(json).not.toContain("LEAK-encrypted-content");
			// The reasoning item's identity stays for correlation.
			expect(json).toContain("rs_1");
		}

		// Full-debug keeps tool fields and visible reasoning summaries while
		// still excluding opaque reasoning contents.
		const fullDebug = JSON.stringify(
			shapeRawTraceRecord(
				{ ...baseConfig, capturePolicy: "full-debug" },
				{
					type: "provider_request",
					captureMode: "full",
					messages: responsesFullMessages(),
				},
			),
		);
		expect(fullDebug).toContain("LEAK-tool-arguments");
		expect(fullDebug).toContain("LEAK-custom-tool-input");
		expect(fullDebug).toContain("LEAK-tool-output");
		expect(fullDebug).toContain("LEAK-reasoning-summary");
	});

	it("captures Responses reasoning summaries only under assistant-output policy", () => {
		const record = () => ({
			type: "provider_request",
			captureMode: "full",
			messages: [
				{
					type: "reasoning",
					id: "rs_summary",
					summary: [
						{
							type: "summary_text",
							text: "VISIBLE-reasoning-summary sk-lf-test-secret-1234567890",
						},
					],
					content: [
						{ type: "reasoning_text", text: "NEVER-reasoning-content" },
					],
					encrypted_content: "NEVER-encrypted-content",
				},
				{
					role: "assistant",
					content: [
						{
							type: "redacted_thinking",
							data: "NEVER-redacted-thinking-data",
						},
					],
				},
			],
		});

		const inherited = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "conversations" },
			record(),
		);
		const inheritedJson = JSON.stringify(inherited);
		expect(inheritedJson).toContain("VISIBLE-reasoning-summary");
		expect(inheritedJson).toContain("[REDACTED:langfuse-secret-key:");
		expect(inheritedJson).not.toContain("sk-lf-test-secret-1234567890");
		expect(inheritedJson).not.toContain("NEVER-reasoning-content");
		expect(inheritedJson).not.toContain("NEVER-encrypted-content");
		expect(inheritedJson).not.toContain("NEVER-redacted-thinking-data");

		const fullObservation = shapeLangfuseObservationBody(
			{ ...baseConfig, capturePolicy: "conversations" },
			"llm-response",
			{
				name: "llm-response",
				input: record().messages,
			},
		);
		expect(JSON.stringify(fullObservation)).toContain(
			"VISIBLE-reasoning-summary",
		);
		expect(JSON.stringify(fullObservation)).not.toContain(
			"NEVER-encrypted-content",
		);
		expect(JSON.stringify(fullObservation)).not.toContain(
			"NEVER-redacted-thinking-data",
		);

		const opaqueNeverCaptured = shapeRawTraceRecord(
			{
				...baseConfig,
				redactionEnabled: false,
				capturePolicy: "full-debug",
			},
			record(),
		);
		expect(JSON.stringify(opaqueNeverCaptured)).not.toContain(
			"NEVER-encrypted-content",
		);
		expect(JSON.stringify(opaqueNeverCaptured)).not.toContain(
			"NEVER-redacted-thinking-data",
		);

		const denied = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureAssistantOutput: false,
			},
			record(),
		);
		expect(JSON.stringify(denied)).not.toContain("VISIBLE-reasoning-summary");

		const explicitlyEnabled = shapeRawTraceRecord(
			{
				...baseConfig,
				capturePolicy: "prompts-only",
				captureAssistantOutput: true,
				payloadMaxStringChars: 48,
			},
			record(),
		);
		const enabledJson = JSON.stringify(explicitlyEnabled);
		expect(enabledJson).toContain("VISIBLE-reasoning-summary");
		expect(enabledJson).toContain("[REDACTED:");
		expect(enabledJson).not.toContain("NEVER-encrypted-content");
	});

	it("strips opaque replay signatures from retained provider copies, even without redaction", () => {
		const liveMessages = [
			{
				role: "model",
				parts: [
					{
						text: "GOOGLE-visible text",
						thoughtSignature: "OPAQUE-google-text-signature",
					},
					{
						functionCall: {
							name: "lookup",
							args: { query: "visible tool input" },
							thoughtSignature: "OPAQUE-nested-function-signature",
						},
						thoughtSignature: "OPAQUE-google-call-signature",
					},
				],
			},
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "RESPONSES-visible text",
						textSignature: "OPAQUE-pi-text-wrapper",
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "PI-visible thinking",
						thinkingSignature: "OPAQUE-pi-thinking-wrapper",
					},
					{
						type: "toolCall",
						id: "call-signature",
						name: "lookup",
						arguments: { query: "visible tool arguments" },
						thoughtSignature: "OPAQUE-pi-tool-wrapper",
					},
				],
			},
		];
		const original = structuredClone(liveMessages);
		const shaped = shapeRawTraceRecord(
			{
				capturePolicy: "full-debug",
				redactionEnabled: false,
			},
			{
				type: "provider_request",
				captureMode: "full",
				messages: liveMessages,
			},
		);
		const json = JSON.stringify(shaped);

		expect(json).toContain("GOOGLE-visible text");
		expect(json).toContain("visible tool input");
		expect(json).toContain("RESPONSES-visible text");
		expect(json).toContain("PI-visible thinking");
		expect(json).toContain("visible tool arguments");
		expect(json).not.toContain("OPAQUE-");
		expect(liveMessages).toEqual(original);
	});

	it("drops an opaque replay signature at the top level of a raw record", () => {
		const shaped = shapeRawTraceRecord(
			{ capturePolicy: "full-debug", redactionEnabled: false },
			{
				type: "assistant_output",
				text: "TOP-visible text",
				thinkingSignature: "OPAQUE-top-level-signature",
			},
		);

		expect(shaped).toMatchObject({ text: "TOP-visible text" });
		expect(shaped).not.toHaveProperty("thinkingSignature");
		expect(JSON.stringify(shaped)).not.toContain("OPAQUE-");
	});

	it("shapes agent.turn input by message role and independent capture policy", () => {
		const incoming = [
			{ role: "system", content: "TURN-system-content" },
			{ role: "user", content: "TURN-user-content" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "TURN-assistant-content" },
					{
						type: "toolCall",
						id: "turn-call",
						name: "bash",
						arguments: { command: "TURN-tool-input" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "turn-call",
				content: [{ type: "text", text: "TURN-tool-output" }],
			},
			{ role: "custom", content: "TURN-custom-content" },
		];
		const observation = () => ({
			name: "agent.turn",
			input: incoming,
			output: {
				text: "TURN-final-answer",
				tool_calls: [],
			},
		});

		const metadataOnly = shapeLangfuseObservationBody(
			{ ...baseConfig, capturePolicy: "metadata-only" },
			"agent.turn",
			observation(),
		);
		expect(metadataOnly).not.toHaveProperty("input");
		expect(metadataOnly).not.toHaveProperty("output");

		const promptsOnly = shapeLangfuseObservationBody(
			{ ...baseConfig, capturePolicy: "prompts-only" },
			"agent.turn",
			observation(),
		);
		const promptsJson = JSON.stringify(promptsOnly);
		expect(promptsJson).toContain("TURN-system-content");
		expect(promptsJson).toContain("TURN-user-content");
		expect(promptsJson).not.toContain("TURN-assistant-content");
		expect(promptsJson).not.toContain("TURN-tool-input");
		expect(promptsJson).not.toContain("TURN-tool-output");
		expect(promptsJson).not.toContain("TURN-custom-content");
		expect(promptsJson).not.toContain("TURN-final-answer");

		const conversations = shapeLangfuseObservationBody(
			{ ...baseConfig, capturePolicy: "conversations" },
			"agent.turn",
			observation(),
		);
		const conversationsJson = JSON.stringify(conversations);
		expect(conversationsJson).toContain("TURN-assistant-content");
		expect(conversationsJson).not.toContain("TURN-tool-input");
		expect(conversationsJson).not.toContain("TURN-tool-output");
		expect(conversationsJson).toContain("TURN-custom-content");

		const overridden = shapeLangfuseObservationBody(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureToolInput: true,
				captureToolOutput: true,
			},
			"agent.turn",
			observation(),
		);
		const overriddenJson = JSON.stringify(overridden);
		expect(overriddenJson).toContain("TURN-tool-input");
		expect(overriddenJson).toContain("TURN-tool-output");
		expect(overriddenJson).toContain("TURN-custom-content");

		const assistantOutputDisabled = shapeLangfuseObservationBody(
			{
				...baseConfig,
				capturePolicy: "conversations",
				captureAssistantOutput: false,
			},
			"agent.turn",
			observation(),
		);
		expect(JSON.stringify(assistantOutputDisabled)).not.toContain(
			"TURN-assistant-content",
		);
		expect(JSON.stringify(assistantOutputDisabled)).not.toContain(
			"TURN-final-answer",
		);
	});

	describe("tool-result wrapper data in turn input", () => {
		// The shape Pi emits for a finished built-in edit: the visible text is
		// short, while `details` carries source-bearing diff and patch text.
		const piEditResult = () => ({
			role: "toolResult",
			toolCallId: "edit-call",
			toolName: "edit",
			content: [{ type: "text", text: "RESULT-visible text" }],
			details: {
				diff: "+ RESULT-PRIVATE-SOURCE-CODE",
				patch: "@@ RESULT-PRIVATE-PATCH",
				firstChangedLine: 3,
			},
			usage: { input: 0, output: 0, totalTokens: 0 },
			isError: false,
			timestamp: 1_700_000_000_000,
		});
		const turn = (message: Record<string, unknown>) => ({
			name: "agent.turn",
			input: [{ role: "user", content: "RESULT-user prompt" }, message],
		});
		const DETAIL_TEXT = ["RESULT-PRIVATE-SOURCE-CODE", "RESULT-PRIVATE-PATCH"];

		it("drops tool-result details whenever tool output is not captured", () => {
			const incoming = turn(piEditResult());
			const before = structuredClone(incoming);
			for (const redactionEnabled of [true, false]) {
				for (const config of [
					{ capturePolicy: "prompts-only" as const },
					{ capturePolicy: "conversations" as const },
					{ capturePolicy: "full-debug" as const, captureToolOutput: false },
				]) {
					const shaped = shapeLangfuseObservationBody(
						{ ...baseConfig, redactionEnabled, ...config },
						"agent.turn",
						incoming,
					);
					const json = JSON.stringify(shaped);
					for (const text of [...DETAIL_TEXT, "RESULT-visible text"]) {
						expect(json).not.toContain(text);
					}
					// Structural correlation fields stay independent.
					expect(shaped.input).toContainEqual(
						expect.objectContaining({
							role: "toolResult",
							toolCallId: "edit-call",
							toolName: "edit",
							isError: false,
							timestamp: 1_700_000_000_000,
						}),
					);
					expect(json).toContain("RESULT-user prompt");
				}
			}
			expect(incoming).toEqual(before);
		});

		it("keeps tool-result details when tool output is captured by policy or override", () => {
			for (const config of [
				{ capturePolicy: "full-debug" as const },
				{ capturePolicy: "conversations" as const, captureToolOutput: true },
				{ capturePolicy: "prompts-only" as const, captureToolOutput: true },
			]) {
				const shaped = shapeLangfuseObservationBody(
					{ ...baseConfig, ...config },
					"agent.turn",
					turn(piEditResult()),
				);
				const json = JSON.stringify(shaped);
				for (const text of [...DETAIL_TEXT, "RESULT-visible text"]) {
					expect(json).toContain(text);
				}
				expect(json).toContain('"firstChangedLine":3');
			}
		});

		it("applies the same ownership to raw provider requests and nested detail records", () => {
			const shaped = shapeRawTraceRecord(
				{ ...baseConfig, capturePolicy: "conversations" },
				{
					type: "provider_request",
					captureMode: "full",
					messages: [
						{
							role: "toolResult",
							toolCallId: "nested-call",
							content: [],
							details: [
								{ nested: { arguments: { command: "RESULT-NESTED-ARGS" } } },
							],
						},
					],
				},
			);
			expect(JSON.stringify(shaped)).not.toContain("RESULT-NESTED-ARGS");
			expect(JSON.stringify(shaped)).toContain("nested-call");
		});

		it("gives custom and bash-execution wrappers the owning role's policy", () => {
			const incoming = {
				name: "agent.turn",
				input: [
					{
						role: "custom",
						customType: "note",
						content: "RESULT-custom content",
						details: { body: "RESULT-custom details" },
						display: true,
						timestamp: 1,
					},
					{
						role: "bashExecution",
						command: "echo RESULT-bash-command",
						output: "RESULT-bash-output",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: 2,
					},
				],
			};
			const promptsOnly = JSON.stringify(
				shapeLangfuseObservationBody(
					{ ...baseConfig, capturePolicy: "prompts-only" },
					"agent.turn",
					incoming,
				),
			);
			expect(promptsOnly).not.toContain("RESULT-custom details");
			expect(promptsOnly).not.toContain("RESULT-bash-output");
			expect(promptsOnly).not.toContain("RESULT-bash-command");
			expect(promptsOnly).toContain('"customType":"note"');
			expect(promptsOnly).toContain('"exitCode":0');

			const conversations = JSON.stringify(
				shapeLangfuseObservationBody(
					{ ...baseConfig, capturePolicy: "conversations" },
					"agent.turn",
					incoming,
				),
			);
			// Provider-input wrappers follow provider input; bash data is tool data.
			expect(conversations).toContain("RESULT-custom details");
			expect(conversations).not.toContain("RESULT-bash-output");
			expect(conversations).not.toContain("RESULT-bash-command");

			const full = JSON.stringify(
				shapeLangfuseObservationBody(
					{ ...baseConfig, capturePolicy: "full-debug" },
					"agent.turn",
					incoming,
				),
			);
			for (const text of [
				"RESULT-custom details",
				"RESULT-bash-output",
				"RESULT-bash-command",
			]) {
				expect(full).toContain(text);
			}
		});
	});

	it("shapes structured assistant tool arguments independently from answer content", () => {
		const toolCalls = [
			{
				id: "call-output-policy",
				name: "bash",
				arguments: { command: "POLICY-TOOL-ARGUMENT" },
			},
		];
		const observation = shapeLangfuseObservationBody(
			{
				...baseConfig,
				redactionEnabled: false,
				capturePolicy: "conversations",
			},
			"llm-response",
			{
				name: "llm-response",
				output: {
					text: "POLICY-ASSISTANT-ANSWER",
					thinking: "POLICY-ASSISTANT-THINKING",
					tool_calls: toolCalls,
				},
			},
		);
		expect(observation.output).toEqual({
			text: "POLICY-ASSISTANT-ANSWER",
			thinking: "POLICY-ASSISTANT-THINKING",
		});
		expect(JSON.stringify(observation)).not.toContain("POLICY-TOOL-ARGUMENT");

		const toolInputOverride = shapeLangfuseObservationBody(
			{
				...baseConfig,
				redactionEnabled: false,
				capturePolicy: "conversations",
				captureAssistantOutput: false,
				captureToolInput: true,
			},
			"llm-response",
			{
				name: "llm-response",
				output: {
					text: "POLICY-ASSISTANT-ANSWER",
					thinking: "POLICY-ASSISTANT-THINKING",
					tool_calls: toolCalls,
				},
			},
		);
		expect(toolInputOverride.output).toEqual({ tool_calls: toolCalls });
		expect(JSON.stringify(toolInputOverride)).not.toContain(
			"POLICY-ASSISTANT-ANSWER",
		);
		expect(JSON.stringify(toolInputOverride)).not.toContain(
			"POLICY-ASSISTANT-THINKING",
		);

		const raw = shapeRawTraceRecord(
			{
				...baseConfig,
				redactionEnabled: false,
				capturePolicy: "conversations",
			},
			{
				type: "assistant_output",
				text: "POLICY-ASSISTANT-ANSWER",
				thinking: "POLICY-ASSISTANT-THINKING",
				toolCalls,
			},
		);
		expect(raw.text).toBe("POLICY-ASSISTANT-ANSWER");
		expect(raw.thinking).toBe("POLICY-ASSISTANT-THINKING");
		expect(raw).not.toHaveProperty("toolCalls");

		const rawToolInputOverride = shapeRawTraceRecord(
			{
				...baseConfig,
				redactionEnabled: false,
				capturePolicy: "conversations",
				captureToolInput: true,
			},
			{
				type: "assistant_output",
				text: "POLICY-ASSISTANT-ANSWER",
				thinking: "POLICY-ASSISTANT-THINKING",
				toolCalls,
			},
		);
		expect(rawToolInputOverride.toolCalls).toEqual(toolCalls);

		const rawAssistantOutputDisabled = shapeRawTraceRecord(
			{
				...baseConfig,
				redactionEnabled: false,
				capturePolicy: "conversations",
				captureAssistantOutput: false,
				captureToolInput: true,
			},
			{
				type: "assistant_output",
				text: "POLICY-ASSISTANT-ANSWER",
				thinking: "POLICY-ASSISTANT-THINKING",
				toolCalls,
			},
		);
		expect(rawAssistantOutputDisabled).not.toHaveProperty("text");
		expect(rawAssistantOutputDisabled).not.toHaveProperty("thinking");
		expect(rawAssistantOutputDisabled.toolCalls).toEqual(toolCalls);

		const structuralCount = shapeRawTraceRecord(
			{ ...baseConfig, capturePolicy: "metadata-only" },
			{ type: "agent_prompt_end", toolCalls: 2 },
		);
		expect(structuralCount.toolCalls).toBe(2);
	});
});

describe("raw capture provenance", () => {
	const messages = [
		{ role: "user", content: "PROV-USER short" },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "probe",
					arguments: { q: { a: { b: "1" } } },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			content: [{ type: "text", text: "PROV-TOOL-OUTPUT result" }],
		},
	];
	const request: Record<string, unknown> = {
		type: "provider_request",
		captureMode: "full",
		messages,
		systemPrompt: "PROV-SYSTEM short",
	};
	const response: Record<string, unknown> = {
		type: "assistant_output",
		text: "PROV-ANSWER",
		toolCalls: [],
	};

	it("verifies every content field of a fully captured record", () => {
		const shaped = shapeRawTraceRecord(baseConfig, request);
		expect(shaped.captureProvenance).toEqual({
			schema: 1,
			verified: ["messages", "systemPrompt"],
			degraded: {},
		});
		expect(shapeRawTraceRecord(baseConfig, response).captureProvenance).toEqual(
			{ schema: 1, verified: ["text", "toolCalls"], degraded: {} },
		);
	});

	it("marks only the fields a finite budget actually truncated", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, payloadMaxStringChars: 20, payloadMaxToolChars: 20 },
			request,
		);
		// The long tool output is cut inside messages; the short system prompt
		// still fits and stays verified.
		expect(shaped.captureProvenance).toEqual({
			schema: 1,
			verified: ["systemPrompt"],
			degraded: { messages: "budget-truncated" },
		});
	});

	it.each([
		["array items", { payloadMaxArrayItems: 2 }],
		["object keys", { payloadMaxObjectKeys: 1 }],
		["depth", { payloadMaxDepth: 2 }],
		["nodes", { payloadMaxNodes: 4 }],
	])("detects truncation by the %s limit", (_name, limits) => {
		const shaped = shapeRawTraceRecord({ ...baseConfig, ...limits }, request);
		expect(
			(shaped.captureProvenance as { degraded: Record<string, string> })
				.degraded.messages,
		).toBe("budget-truncated");
	});

	it("does not call a limit that is not reached a truncation", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, payloadMaxStringChars: 1_000, payloadMaxNodes: 1_000 },
			request,
		);
		expect(
			(shaped.captureProvenance as { degraded: unknown }).degraded,
		).toEqual({});
	});

	it("marks fields dropped by the capture policy, even inside messages", () => {
		const noToolOutput = shapeRawTraceRecord(
			{ ...baseConfig, captureToolOutput: false },
			request,
		);
		expect(noToolOutput.captureProvenance).toEqual({
			schema: 1,
			verified: ["systemPrompt"],
			degraded: { messages: "policy-omitted" },
		});
		const noAnswer = shapeRawTraceRecord(
			{ ...baseConfig, captureAssistantOutput: false },
			response,
		);
		expect(noAnswer.captureProvenance).toEqual({
			schema: 1,
			verified: ["toolCalls"],
			degraded: { text: "policy-omitted" },
		});
		// Tool-call capture off drops the key, so an empty call list cannot be
		// proven empty.
		const noToolInput = shapeRawTraceRecord(
			{ ...baseConfig, captureToolInput: false },
			response,
		);
		expect(noToolInput).not.toHaveProperty("toolCalls");
		expect(
			(noToolInput.captureProvenance as { degraded: Record<string, string> })
				.degraded.toolCalls,
		).toBe("policy-omitted");
	});

	it("treats a tool result whose only content is dropped details as policy-omitted", () => {
		// The owning-role rule drops `details` with the tool output. Provenance
		// must see that loss even when the result has no text blocks.
		const detailsOnly: Record<string, unknown> = {
			...request,
			messages: [
				{ role: "user", content: "PROV-USER short" },
				{
					role: "toolResult",
					toolCallId: "call-1",
					content: [],
					details: { diff: "PROV-DETAILS-ONLY" },
				},
			],
		};
		expect(
			shapeRawTraceRecord(baseConfig, detailsOnly).captureProvenance,
		).toEqual({
			schema: 1,
			verified: ["messages", "systemPrompt"],
			degraded: {},
		});
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, captureToolOutput: false },
			detailsOnly,
		);
		expect(JSON.stringify(shaped)).not.toContain("PROV-DETAILS-ONLY");
		expect(
			(shaped.captureProvenance as { degraded: Record<string, string> })
				.degraded.messages,
		).toBe("policy-omitted");
	});

	it("reports policy omission when policy and budget both removed content", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, captureToolOutput: false, payloadMaxStringChars: 5 },
			request,
		);
		expect(
			(shaped.captureProvenance as { degraded: Record<string, string> })
				.degraded.messages,
		).toBe("policy-omitted");
	});

	it("leaves other record types without provenance", () => {
		expect(
			shapeRawTraceRecord(baseConfig, { type: "tool_call", input: { q: 1 } }),
		).not.toHaveProperty("captureProvenance");
	});
});

describe.each([
	["with redaction", true],
	["without redaction", false],
])("payload bounds on nested values %s", (_name, redactionEnabled) => {
	const shapeArgs = (limits: Record<string, number>, args: unknown) =>
		(
			shapeRawTraceRecord(
				{ ...baseConfig, redactionEnabled, ...limits },
				{ type: "tool_execution_end", args },
			) as { args: unknown }
		).args;

	it("replaces values below the depth budget with a marker", () => {
		expect(
			shapeArgs({ payloadMaxDepth: 1 }, { shallow: 1, nested: { deep: 2 } }),
		).toEqual({
			shallow: 1,
			nested: "[TRUNCATED:depth]",
		});
	});

	it("marks a reference back to an ancestor and keeps its siblings", () => {
		const node: Record<string, unknown> = { label: "root" };
		node.self = node;

		expect(shapeArgs({ payloadMaxDepth: 5 }, node)).toEqual({
			label: "root",
			self: "[Circular]",
		});
	});

	it("stops reading array items and object keys once the node budget is spent", () => {
		expect(shapeArgs({ payloadMaxNodes: 4 }, [1, 2, 3, 4, 5])).toEqual([
			1, 2, 3,
		]);
		expect(
			shapeArgs({ payloadMaxNodes: 3 }, { a: 1, b: 2, c: 3, d: 4 }),
		).toEqual({
			a: 1,
			b: 2,
		});
	});
});

describe("payload bounds shared across the fields of one record", () => {
	const shape = (
		limits: Record<string, number>,
		record: Record<string, unknown>,
	) =>
		shapeRawTraceRecord(
			{ ...baseConfig, ...limits },
			{ type: "tool_execution_end", ...record },
		) as Record<string, unknown>;

	it("keeps a date at the depth budget out of the tree, as a truncation marker", () => {
		const shaped = shape(
			{ payloadMaxDepth: 1 },
			{ args: { when: new Date(0) } },
		);

		expect(shaped.args).toEqual({ when: "[TRUNCATED:depth]" });
	});

	it("cuts a reference cycle that runs through a date, which the sanitizer leaves untouched", () => {
		const date = new Date(0) as Date & { self?: unknown };
		date.self = date;

		const shaped = shape({}, { args: { when: date } });

		expect(JSON.stringify(shaped.args)).toContain('"[Circular]"');
	});

	it("spends one node budget over every field, cutting array items and object keys late", () => {
		const shaped = shape(
			{ payloadMaxNodes: 6 },
			{
				args: { a: 1, b: 2 },
				resultSummary: ["x", "y", "z", "w"],
				argsSummary: { p: 1, q: 2, r: 3 },
			},
		);

		expect(shaped.args).toEqual({ a: 1, b: 2 });
		expect(shaped.resultSummary).toEqual(["x", "y"]);
		expect(shaped).not.toHaveProperty("argsSummary");
	});

	it("cuts the keys of a later object field when the shared budget runs out between keys", () => {
		const shaped = shape(
			{ payloadMaxNodes: 5 },
			{ args: { a: 1 }, argsSummary: { p: 1, q: 2, r: 3 } },
		);

		expect(shaped.args).toEqual({ a: 1 });
		expect(shaped.argsSummary).toEqual({ p: 1, q: 2 });
	});
});

describe("capture field of message sections and observation inputs", () => {
	it("treats sections as system prompt only for system messages", () => {
		const record = {
			type: "provider_request",
			captureMode: "full",
			messages: [
				{ role: "system", sections: { rules: "SYSTEM-RULES" } },
				{ role: "user", sections: { note: "USER-SECTION" } },
			],
		};

		const shaped = JSON.stringify(
			shapeRawTraceRecord(
				{ ...baseConfig, captureMetadata: false, captureSystemPrompt: true },
				record,
			),
		);

		expect(shaped).toContain("SYSTEM-RULES");
		expect(shaped).not.toContain("USER-SECTION");
	});

	it.each([
		["llm-response", "captureProviderInput"],
		["agent.turn", "captureProviderInput"],
		["agent.prompt", "capturePrompt"],
		["tool:bash", "captureToolInput"],
		["something-else", "captureMetadata"],
	])("lets %s input follow %s alone", (name, setting) => {
		const settings = [
			"captureProviderInput",
			"capturePrompt",
			"captureToolInput",
			"captureMetadata",
		];
		const only = Object.fromEntries(
			settings.map((key) => [key, key === setting]),
		);
		const none = Object.fromEntries(settings.map((key) => [key, false]));
		const body = { name, input: "THE-INPUT" };

		const kept = shapeLangfuseObservationBody(
			{ ...baseConfig, ...only },
			name,
			body,
		);
		const dropped = shapeLangfuseObservationBody(
			{ ...baseConfig, ...none },
			name,
			body,
		);

		expect(kept.input).toBe("THE-INPUT");
		expect(dropped).not.toHaveProperty("input");
	});

	it("keeps raw args of a provider record under provider-input policy, not tool policy", () => {
		const record = { type: "provider_request", args: { q: "ARGS-VALUE" } };

		const providerOff = shapeRawTraceRecord(
			{ ...baseConfig, captureProviderInput: false },
			record,
		);
		const toolOff = shapeRawTraceRecord(
			{ ...baseConfig, captureToolInput: false },
			record,
		);

		expect(providerOff).not.toHaveProperty("args");
		expect(toolOff.args).toEqual({ q: "ARGS-VALUE" });
	});

	it("classifies a record without a type like any other non-tool record", () => {
		const shaped = shapeRawTraceRecord(
			{ ...baseConfig, captureProviderInput: false },
			{ input: "UNTYPED-INPUT", text: "answer" },
		);

		expect(shaped).not.toHaveProperty("input");
		expect(shaped.text).toBe("answer");
	});
});

describe("payload budgets at their exact limits", () => {
	const record = (limits: Record<string, number>, fields: object) =>
		shapeRawTraceRecord(
			{ ...baseConfig, ...limits },
			{ type: "tool_execution_end", ...fields },
		) as Record<string, unknown>;

	it("spends the node budget on whole top-level fields and drops the rest", () => {
		const shaped = record(
			{ payloadMaxNodes: 2 },
			{ args: 1, resultSummary: 2, argsSummary: 3 },
		);

		expect(shaped).toMatchObject({ args: 1, resultSummary: 2 });
		expect(shaped).not.toHaveProperty("argsSummary");
	});

	it.each([
		["an array", [1]],
		["an empty array", []],
	])(
		"drops a provider-input field holding %s once the node budget is spent",
		(_name, value) => {
			// `args` is provider input outside tool records. A spent budget drops the
			// field itself; it does not leave an empty container behind.
			const provider = (limits: Record<string, number>) =>
				shapeRawTraceRecord(
					{ ...baseConfig, ...limits },
					{ type: "agent_prompt_start", input: "x", args: value },
				) as Record<string, unknown>;

			expect(provider({ payloadMaxNodes: 1 })).toMatchObject({ input: "x" });
			expect(provider({ payloadMaxNodes: 1 })).not.toHaveProperty("args");
			expect(provider({ payloadMaxNodes: 0 })).not.toHaveProperty("input");
			expect(provider({ payloadMaxNodes: 0 })).not.toHaveProperty("args");
		},
	);

	it("does not capture the value of a key inside an array once the node budget is spent", () => {
		const input = (payloadMaxNodes: number) =>
			JSON.stringify(
				(
					shapeRawTraceRecord(
						{ ...baseConfig, payloadMaxNodes },
						{ type: "agent_prompt_start", input: [{ count: 42 }] },
					) as Record<string, unknown>
				).input,
			);

		// The array, its object, and the number are three nodes. One node is
		// spent on the array, so the number is a later node.
		expect(input(3)).toContain("42");
		expect(input(1)).not.toContain("42");
	});

	it("counts a Date inside an array as an object level of the depth budget", () => {
		// A Date is kept by the sanitizer, so the depth bound of the shaper is
		// the one that applies to it.
		const shaped = shapeTelemetryValue(
			{ ...baseConfig, payloadMaxDepth: 1 },
			"toolInput",
			[new Date(0)],
			{ forceCapture: true },
		);

		expect(shaped).toEqual(["[TRUNCATED:depth]"]);
	});

	it("keeps the contents of a top-level object when the depth budget is one level, even for a sensitive key", () => {
		const shaped = shapeLangfuseTraceBody(
			{ ...baseConfig, redactionEnabled: false, payloadMaxDepth: 1 },
			{ metadata: { password: Object.assign(new Date(0), { x: 1 }) } },
		);

		expect(shaped.metadata).toEqual({ password: { x: 1 } });
	});

	it("applies the object key budget to the fields of an error", () => {
		const error = new Error("ordinary failure");
		error.stack = undefined;

		const shaped = shapeTelemetryValue(
			{ ...baseConfig, payloadMaxObjectKeys: 1 },
			"toolInput",
			error,
			{ forceCapture: true },
		);

		expect(Object.keys(shaped as object)).toHaveLength(1);
	});

	describe("once the node budget is spent, nothing further is read", () => {
		const unreadable = (target: object, key: string) => {
			let reads = 0;
			Object.defineProperty(target, key, {
				enumerable: true,
				get() {
					reads += 1;
					throw new Error("a value past the node budget was read");
				},
			});
			return () => reads;
		};

		it("skips the items of an array reached through a Date", () => {
			const items: unknown[] = [];
			items.length = 1;
			const reads = unreadable(items, "0");
			const input = Object.assign(new Date(0), { items });

			expect(() =>
				shapeTelemetryValue(
					{ ...baseConfig, payloadMaxNodes: 2 },
					"toolInput",
					input,
					{ forceCapture: true },
				),
			).not.toThrow();
			expect(reads()).toBe(0);
		});

		it("skips the keys of an object reached through a Date", () => {
			const input = new Date(0);
			const reads = unreadable(input, "x");

			expect(() =>
				shapeTelemetryValue(
					{ ...baseConfig, payloadMaxNodes: 1 },
					"toolInput",
					input,
					{ forceCapture: true },
				),
			).not.toThrow();
			expect(reads()).toBe(0);
		});

		it("skips the metadata keys that follow the budget", () => {
			const tail = {};
			const reads = unreadable(tail, "x");

			expect(() =>
				shapeLangfuseTraceBody(
					{ ...baseConfig, payloadMaxNodes: 1 },
					{ metadata: { a: 1, b: tail } },
				),
			).not.toThrow();
			expect(reads()).toBe(0);
		});
	});

	it("charges a whole array, and nothing beyond its items, against the node budget", () => {
		const fields = { args: [1, 2], resultSummary: 5 };

		// The array costs three nodes (itself and two items), the scalar one.
		expect(record({ payloadMaxNodes: 4 }, fields)).toMatchObject({
			args: [1, 2],
			resultSummary: 5,
		});
		expect(record({ payloadMaxNodes: 3 }, fields)).not.toHaveProperty(
			"resultSummary",
		);
	});

	it("keeps exactly the configured number of array items and object keys", () => {
		expect(
			record({ payloadMaxArrayItems: 2 }, { args: [1, 2, 3, 4] }).args,
		).toEqual([1, 2]);
		expect(
			record({ payloadMaxArrayItems: 3 }, { args: [1, 2, 3] }).args,
		).toEqual([1, 2, 3]);
		expect(
			record({ payloadMaxObjectKeys: 2 }, { args: { a: 1, b: 2, c: 3, d: 4 } })
				.args,
		).toEqual({ a: 1, b: 2 });
	});

	it("counts each array level toward the depth budget", () => {
		expect(record({ payloadMaxDepth: 2 }, { args: [[[1]]] }).args).toEqual([
			["[TRUNCATED:depth]"],
		]);
	});

	it("keeps a top-level sensitive field, redacted, instead of dropping it", () => {
		const shaped = record(
			{},
			{ authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
		);

		expect(shaped.authorization).toEqual(expect.stringContaining("[REDACTED:"));
		expect(JSON.stringify(shaped)).not.toContain(
			"abcdefghijklmnopqrstuvwxyz123456",
		);
	});

	it("measures tool fields by the tool budget and every other field by the string budget", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const fields = {
			args: text,
			resultSummary: text,
			argsSummary: text,
			text,
		};

		const toolSmall = record(
			{ payloadMaxToolChars: 3, payloadMaxStringChars: 50 },
			fields,
		);
		const stringSmall = record(
			{ payloadMaxToolChars: 50, payloadMaxStringChars: 3 },
			fields,
		);

		expect(toolSmall).toMatchObject({
			args: "abc",
			resultSummary: "abc",
			argsSummary: "abc",
			text,
		});
		expect(stringSmall).toMatchObject({
			args: text,
			resultSummary: text,
			argsSummary: text,
			text: "abc",
		});
	});

	it("applies the object-key and node budgets to the content fields of a trace body", () => {
		const body = {
			input: "prompt text",
			output: { text: "answer", tool_calls: [] },
			metadata: { model: "m", systemPrompt: "sys" },
		};

		const oneKey = shapeLangfuseTraceBody(
			{ ...baseConfig, payloadMaxObjectKeys: 1 },
			body,
		);
		const oneNode = shapeLangfuseTraceBody(
			{ ...baseConfig, payloadMaxNodes: 1 },
			body,
		);

		expect(Object.keys(oneKey)).toEqual(["input"]);
		expect(Object.keys(oneNode)).toEqual(["input"]);
	});

	it("masks sensitive metadata keys by key name, whatever their value shape", () => {
		const shaped = shapeLangfuseTraceBody(baseConfig, {
			metadata: {
				authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
				apiKey: { nested: [1, 2] },
				note: "ok",
			},
		});

		expect(shaped.metadata).toMatchObject({
			authorization: expect.stringMatching(
				/^\[REDACTED:authorization:[0-9a-f]{10}\]$/,
			),
			apiKey: expect.stringMatching(/^\[REDACTED:api-key:[0-9a-f]{10}\]$/),
			note: "ok",
		});
	});

	it("keeps only the first metadata keys that survive, up to the key budget", () => {
		const metadata = { a: 1, skipped: undefined, b: 2, c: 3, d: 4 };

		const byKeys = shapeLangfuseTraceBody(
			{ ...baseConfig, payloadMaxObjectKeys: 2 },
			{ metadata },
		);
		const byNodes = shapeLangfuseTraceBody(
			{ ...baseConfig, payloadMaxNodes: 2 },
			{ metadata },
		);

		expect(byKeys.metadata).toEqual({ a: 1, b: 2 });
		expect(byNodes.metadata).toEqual({ a: 1, b: 2 });
	});
});

describe("tool-role message wrappers follow the tool capture fields", () => {
	const messages = [
		{ role: "tool", content: "C1", wrapperKey: "W1" },
		{ role: "tool_result", content: "C2", wrapperKey: "W2" },
		{ role: "toolResult", content: "C3", wrapperKey: "W3" },
		{ role: "bashExecution", command: "CMD", output: "OUT", wrapperKey: "W4" },
		{ role: "user", content: "U", wrapperKey: "W5" },
	];
	const shapeMessages = (overrides: Record<string, unknown>) =>
		(
			shapeRawTraceRecord(
				{ ...baseConfig, ...overrides },
				{ type: "provider_request", messages },
			) as { messages: Array<Record<string, unknown>> }
		).messages;

	it("drops tool results' content and wrapper data when tool output is not captured", () => {
		const shaped = shapeMessages({ captureToolOutput: false });

		for (const index of [0, 1, 2]) {
			expect(Object.keys(shaped[index] ?? {})).toEqual(["role"]);
		}
		expect(Object.keys(shaped[3] ?? {})).toEqual(["role", "command"]);
		expect(shaped[4]).toMatchObject({ role: "user", content: "U" });
	});

	it("drops a shell command, and keeps its output, when tool input is not captured", () => {
		const bash = shapeMessages({ captureToolInput: false })[3] ?? {};

		expect(bash).toHaveProperty("output", "OUT");
		expect(bash).not.toHaveProperty("command");
	});

	it("keeps tool results when only prompts are not captured", () => {
		const shaped = shapeMessages({ capturePrompt: false });

		expect(shaped[0]).toMatchObject({ content: "C1" });
		expect(Object.keys(shaped[4] ?? {})).toEqual(["role"]);
	});
});

describe("provenance when every payload limit is finite", () => {
	it("still marks a field that a finite budget truncated", () => {
		const request: Record<string, unknown> = {
			type: "provider_request",
			captureMode: "full",
			systemPrompt: "short",
			messages: [{ role: "user", content: "x".repeat(200) }],
		};

		const shaped = shapeRawTraceRecord(
			{
				...baseConfig,
				payloadMaxStringChars: 20,
				payloadMaxToolChars: 20,
				payloadMaxDepth: 50,
				payloadMaxArrayItems: 50,
				payloadMaxObjectKeys: 50,
				payloadMaxNodes: 5_000,
			},
			request,
		);

		expect(shaped.captureProvenance).toEqual({
			schema: 1,
			verified: ["systemPrompt"],
			degraded: { messages: "budget-truncated" },
		});
	});
});
