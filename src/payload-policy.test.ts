import { describe, expect, it } from "vitest";
import {
	getPayloadLimits,
	isCaptureEnabled,
	shapeExportValue,
	shapeLangfuseObservationBody,
	shapeLangfuseTraceBody,
	shapeRawTraceRecord,
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

	it("excludes reasoning contents from full raw records at every policy", () => {
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

			expect(json).not.toContain("LEAK-reasoning-summary");
			expect(json).not.toContain("LEAK-reasoning-content");
			expect(json).not.toContain("LEAK-encrypted-content");
			// The reasoning item's identity stays for correlation.
			expect(json).toContain("rs_1");
		}

		// Full-debug keeps tool fields (policy opt-in) while still excluding
		// reasoning contents.
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
		expect(fullDebug).not.toContain("LEAK-reasoning-summary");
	});
});
