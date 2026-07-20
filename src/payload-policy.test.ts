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
});
