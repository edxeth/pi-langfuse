import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import {
	assistantOutput,
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	latestRecord,
} from "./compatibility-fixtures.js";

/** Registers request-to-generation correlation scenarios: per-request generations, Responses request identity, and explicit request ids. */
export function registerGenerationCorrelationScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("keeps one correlated generation per model request across response edge cases", async () => {
		const agentDir = tempRoot("pi-langfuse-generation-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "generation-public",
			"secret-key": "generation-secret",
			"base-url": "http://generation-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const sessionFile =
			"/tmp/pi-agent/sessions/--generation--/generation-session.jsonl";
		const context = {
			model: { id: "generation-model", provider: "generation-provider" },
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => "generation-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "generation-model", provider: "generation-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "generation prompt",
				systemPrompt: "generation system",
				systemPromptOptions: { cwd: "/tmp/generation" },
			},
			context,
		);
		await handler("agent_start")({}, context);

		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("context")(
			{
				messages: [
					{ role: "system", content: "generation system" },
					{ role: "user", content: "turn zero" },
				],
			},
			context,
		);
		await handler("before_provider_request")(
			{
				payload: {
					model: "generation-model",
					messages: [{ role: "user", content: "turn zero" }],
				},
			},
			context,
		);
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_update")(
			{
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "think " },
			},
			context,
		);
		await handler("message_update")(
			{
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "answer-0" },
			},
			context,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer-0" }],
					model: "generation-model-final-0",
					usage: {
						input: 4,
						output: 5,
						totalTokens: 9,
						cost: { input: 0.04, output: 0.05, total: 0.09 },
					},
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);

		await handler("turn_start")({ turnIndex: 1 }, context);
		await handler("context")(
			{ messages: [{ role: "user", content: "tool request" }] },
			context,
		);
		await handler("before_provider_request")(
			{
				payload: {
					model: "generation-model",
					messages: [{ role: "user", content: "tool request" }],
				},
			},
			context,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "bash",
							arguments: { command: "pwd" },
						},
					],
					model: "generation-model-final-1",
					usage: { input: 6, output: 2, totalTokens: 8 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 1,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);

		await handler("turn_start")({ turnIndex: 2 }, context);
		await handler("before_provider_request")(
			{
				payload: {
					model: "generation-model",
					messages: [{ role: "user", content: "provider error" }],
				},
			},
			context,
		);
		await handler("after_provider_response")(
			{
				status: 503,
				headers: {},
			},
			context,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [],
					model: "generation-model-error",
					stopReason: "error",
					usage: { input: 7, output: 0, totalTokens: 7 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 2,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);

		await handler("turn_start")({ turnIndex: 3 }, context);
		await handler("context")(
			{ messages: [{ role: "user", content: "request three" }] },
			context,
		);
		await handler("before_provider_request")(
			{ payload: { model: "generation-model" } },
			context,
		);
		await handler("context")(
			{ messages: [{ role: "user", content: "later context" }] },
			context,
		);
		await handler("after_provider_response")(
			{ status: 200, headers: {} },
			context,
		);
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer-3" }],
					model: "generation-model-final-3",
					usage: { input: 2, output: 2, totalTokens: 4 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 3,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);

		await handler("turn_start")({ turnIndex: 4 }, context);
		await handler("before_provider_request")(
			{ payload: { model: "generation-model" } },
			context,
		);
		await handler("after_provider_response")(
			{ status: 429, headers: {} },
			context,
		);
		await handler("after_provider_response")(
			{ status: 200, headers: {} },
			context,
		);
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer-4" }],
					model: "generation-model-final-4",
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(generations).toHaveLength(5);
		const generationsByRequest = new Map(
			generations.map((generation) => [
				(generation.metadata as { requestKey?: string }).requestKey,
				generation,
			]),
		);
		const generation0 = generationsByRequest.get("turn:0:request:0");
		const generation1 = generationsByRequest.get("turn:1:request:0");
		const generation2 = generationsByRequest.get("turn:2:request:0");
		const generation3 = generationsByRequest.get("turn:3:request:0");
		const generation4 = generationsByRequest.get("turn:4:request:0");
		if (
			!generation0 ||
			!generation1 ||
			!generation2 ||
			!generation3 ||
			!generation4
		) {
			throw new Error("all request-correlated generations are required");
		}

		for (const generation of generations) {
			expect(generation.traceId).toBe(trace.id);
		}
		const turn0 = latestRecord(
			telemetry.state.observations.filter(
				(record) =>
					(record.metadata as { turnIndex?: number } | undefined)?.turnIndex ===
						0 && record.name === "agent.turn",
			),
			"agent.turn",
		);
		const turn1 = latestRecord(
			telemetry.state.observations.filter(
				(record) =>
					(record.metadata as { turnIndex?: number } | undefined)?.turnIndex ===
						1 && record.name === "agent.turn",
			),
			"agent.turn",
		);
		const turn2 = latestRecord(
			telemetry.state.observations.filter(
				(record) =>
					(record.metadata as { turnIndex?: number } | undefined)?.turnIndex ===
						2 && record.name === "agent.turn",
			),
			"agent.turn",
		);
		const turn3 = latestRecord(
			telemetry.state.observations.filter(
				(record) =>
					(record.metadata as { turnIndex?: number } | undefined)?.turnIndex ===
						3 && record.name === "agent.turn",
			),
			"agent.turn",
		);
		const turn4 = latestRecord(
			telemetry.state.observations.filter(
				(record) =>
					(record.metadata as { turnIndex?: number } | undefined)?.turnIndex ===
						4 && record.name === "agent.turn",
			),
			"agent.turn",
		);
		expect(generation0.parentObservationId).toBe(turn0.id);
		expect(generation1.parentObservationId).toBe(turn1.id);
		expect(generation2.parentObservationId).toBe(turn2.id);
		expect(generation3.parentObservationId).toBe(turn3.id);
		expect(generation4.parentObservationId).toBe(turn4.id);
		// The generation input describes the observed provider request (audit
		// #2), not the earlier context event: the wire payload here carries no
		// system message, so none may appear in the input.
		expect(generation0.input).toEqual([{ role: "user", content: "turn zero" }]);
		expect(generation0.end).toMatchObject({
			output: assistantOutput("answer-0", "think "),
			model: "generation-model-final-0",
			usage: { input: 4, output: 5, total: 9 },
			costDetails: { input: 0.04, output: 0.05, total: 0.09 },
			metadata: { hasThinking: true },
		});
		expect(generation1.input).toEqual([
			{ role: "user", content: "tool request" },
		]);
		expect(generation1.end).toMatchObject({
			model: "generation-model-final-1",
			usage: { input: 6, output: 2, total: 8 },
		});
		expect(generation2).toMatchObject({
			metadata: expect.objectContaining({
				providerResponseStatus: 503,
				providerResponseStatuses: [503],
			}),
			end: expect.objectContaining({
				isError: true,
				statusMessage: expect.stringContaining("503"),
			}),
		});
		expect(generation3.input).toEqual([
			{ role: "user", content: "request three" },
		]);
		expect(generation3.metadata).toMatchObject({
			providerResponseStatus: 200,
			providerResponseStatuses: [200],
		});
		expect(generation4.lastUpdate).toMatchObject({
			metadata: {
				providerResponseStatus: 200,
				providerResponseStatuses: [429, 200],
			},
		});
		expect(generation4.end).toMatchObject({
			output: assistantOutput("answer-4"),
			model: "generation-model-final-4",
		});
		expect(telemetry.state.scores).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "input_tokens",
					value: 4,
					observationId: generation0.id,
				}),
				expect.objectContaining({
					name: "output_tokens",
					value: 5,
					observationId: generation0.id,
				}),
				expect.objectContaining({
					name: "total_cost",
					value: 0.09,
					observationId: generation0.id,
				}),
			]),
		);

		await handler("session_shutdown")({}, context);
	});

	it("distinguishes distinct same-turn Responses requests, reuses identical ones, and never mutates payloads", async () => {
		const agentDir = tempRoot("pi-langfuse-responses-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "responses-public",
			"secret-key": "responses-secret",
			"base-url": "http://responses-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "grok-4.7", provider: "xai" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--responses--/responses-session.jsonl",
				getSessionId: () => "responses-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "grok-4.7", provider: "xai" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "responses prompt",
				systemPrompt: "responses system",
				systemPromptOptions: { cwd: "/tmp/responses" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("context")(
			{ messages: [{ role: "user", content: "CTX-context view" }] },
			context,
		);

		// Responses payloads carry `input`; each distinct request must be
		// identifiable, while an identical retry reuses the same generation.
		const buildPayload = (marker: string) => ({
			model: "grok-4.7",
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: `INPUT-${marker}` }],
				},
			],
			stream: true,
			store: false,
			max_output_tokens: 2048,
			temperature: 0.7,
			reasoning: { effort: "low" },
			prompt_cache_key: "pck-session",
		});

		const firstPayload = buildPayload("first");
		const firstSnapshot = structuredClone(firstPayload);
		await handler("before_provider_request")(
			{ payload: firstPayload },
			context,
		);
		// A failed response materializes the first generation.
		await handler("after_provider_response")(
			{ status: 429, headers: {} },
			context,
		);
		// Provider retries resend an identical payload and must reuse the
		// generation instead of opening a new one.
		await handler("before_provider_request")(
			{ payload: buildPayload("first") },
			context,
		);

		// A retry with different contents is a distinct request and must get
		// its own generation.
		const secondPayload = buildPayload("second");
		const secondSnapshot = structuredClone(secondPayload);
		await handler("before_provider_request")(
			{ payload: secondPayload },
			context,
		);

		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 2, output: 1, totalTokens: 3 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		// The hook is observation-only: payloads must survive untouched.
		expect(firstPayload).toEqual(firstSnapshot);
		expect(secondPayload).toEqual(secondSnapshot);

		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(generations).toHaveLength(2);
		// Creation order follows observation creation, not request order.
		expect(
			generations
				.map(
					(generation) =>
						(generation.metadata as { requestKey?: string }).requestKey,
				)
				.sort(),
		).toEqual(["turn:0:request:0", "turn:0:request:1"]);
		// Message events flow to the newest request's generation; the superseded
		// first request is closed by turn cleanup as abandoned.
		const byRequestKey = new Map(
			generations.map((generation) => [
				(generation.metadata as { requestKey?: string }).requestKey,
				generation,
			]),
		);
		expect(byRequestKey.get("turn:0:request:1")?.end).toMatchObject({
			output: assistantOutput("done"),
		});
		expect(byRequestKey.get("turn:0:request:0")?.end).toMatchObject({
			isError: true,
			statusMessage: expect.stringContaining("abandoned"),
		});
		expect(byRequestKey.get("turn:0:request:0")?.metadata).toMatchObject({
			providerResponseStatuses: [429],
		});
		// Responses-specific parameters survive into the generation record.
		expect(byRequestKey.get("turn:0:request:0")?.modelParameters).toEqual({
			temperature: 0.7,
			max_output_tokens: 2048,
			reasoning_effort: "low",
		});
		await handler("session_shutdown")({}, context);
	});

	it("attaches message events to the newest request when a superseded request produced no events", async () => {
		const agentDir = tempRoot("pi-langfuse-responses-superseded-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "superseded-public",
			"secret-key": "superseded-secret",
			"base-url": "http://superseded-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "grok-4.7", provider: "xai" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--superseded--/superseded-session.jsonl",
				getSessionId: () => "superseded-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "grok-4.7", provider: "xai" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "superseded prompt",
				systemPrompt: "superseded system",
				systemPromptOptions: { cwd: "/tmp/superseded" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("context")(
			{ messages: [{ role: "user", content: "CTX-context view" }] },
			context,
		);

		// First request never sees a response (network failure), then a retry
		// with different contents is sent. The stream must not be attributed to
		// the superseded request.
		await handler("before_provider_request")(
			{
				payload: {
					model: "grok-4.7",
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: "INPUT-first" }],
						},
					],
				},
			},
			context,
		);
		await handler("before_provider_request")(
			{
				payload: {
					model: "grok-4.7",
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: "INPUT-second" }],
						},
					],
				},
			},
			context,
		);
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 2, output: 1, totalTokens: 3 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		// The superseded request never materialized (no response events), so the
		// stream lands on exactly one generation: the newest request's.
		expect(generations).toHaveLength(1);
		const newestGeneration = generations[0];
		if (!newestGeneration) throw new Error("newest request generation missing");
		expect(
			(newestGeneration.metadata as { requestKey?: string }).requestKey,
		).toBe("turn:0:request:1");
		expect(newestGeneration.end).toMatchObject({
			output: assistantOutput("done"),
		});
		await handler("session_shutdown")({}, context);
	});

	it("keeps distinct generations for same-turn requests whose display summaries collide", async () => {
		const agentDir = tempRoot("pi-langfuse-responses-collision-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "collision-public",
			"secret-key": "collision-secret",
			"base-url": "http://collision-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "grok-4.7", provider: "xai" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--collision--/collision-session.jsonl",
				getSessionId: () => "collision-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "grok-4.7", provider: "xai" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "collision prompt",
				systemPrompt: "collision system",
				systemPromptOptions: { cwd: "/tmp/collision" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		// Both requests share their last 40 input items, so the bounded display
		// summary is identical; only the earliest item differs. Request identity
		// must come from the complete payload, not the display summary.
		const buildPayload = (firstMarker: string) => ({
			model: "grok-4.7",
			input: Array.from({ length: 45 }, (_, index) =>
				index === 0
					? {
							role: "user",
							content: [{ type: "input_text", text: `INPUT-${firstMarker}` }],
						}
					: {
							role: "user",
							content: [
								{
									type: "input_text",
									text: `INPUT-shared-${index}`,
								},
							],
						},
			),
		});
		await handler("before_provider_request")(
			{ payload: buildPayload("first") },
			context,
		);
		await handler("before_provider_request")(
			{ payload: buildPayload("second") },
			context,
		);
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 2, output: 1, totalTokens: 3 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		// The identical display summaries must not merge the two requests into
		// one generation keyed to the first request.
		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(generations).toHaveLength(1);
		const collisionGeneration = generations[0];
		if (!collisionGeneration) {
			throw new Error("newest request generation missing");
		}
		expect(
			(collisionGeneration.metadata as { requestKey?: string }).requestKey,
		).toBe("turn:0:request:1");
		await handler("session_shutdown")({}, context);
	});

	it("pins generations to explicit request ids and reuses them across retries", async () => {
		const agentDir = tempRoot("pi-langfuse-explicit-key-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "explicit-public",
			"secret-key": "explicit-secret",
			"base-url": "http://explicit-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "explicit-model", provider: "explicit-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--explicit--/explicit-session.jsonl",
				getSessionId: () => "explicit-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "explicit-model", provider: "explicit-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "explicit prompt",
				systemPrompt: "explicit system",
				systemPromptOptions: { cwd: "/tmp/explicit" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		const buildPayload = (marker: string) => ({
			model: "explicit-model",
			messages: [{ role: "user", content: `REQ-${marker}` }],
		});

		// An event carrying an explicit request id pins its generation to that
		// id: a retry reuses the same generation, a different id opens another.
		await handler("before_provider_request")(
			{ requestId: "provider-req-1", payload: buildPayload("first") },
			context,
		);
		await handler("after_provider_response")(
			{ requestId: "provider-req-1", status: 429, headers: {} },
			context,
		);
		await handler("before_provider_request")(
			{ requestId: "provider-req-1", payload: buildPayload("first") },
			context,
		);
		await handler("before_provider_request")(
			{ requestId: "provider-req-2", payload: buildPayload("second") },
			context,
		);

		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 2, output: 1, totalTokens: 3 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(generations).toHaveLength(2);
		expect(
			generations.map(
				(generation) =>
					(generation.metadata as { requestKey?: string }).requestKey,
			),
		).toEqual(["provider-req-1", "provider-req-2"]);
		await handler("session_shutdown")({}, context);
	});

	it("opens a generation from message events when no provider request was seen", async () => {
		const agentDir = tempRoot("pi-langfuse-message-only-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "message-only-public",
			"secret-key": "message-only-secret",
			"base-url": "http://message-only-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "message-only-model", provider: "message-only-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--message-only--/message-only-session.jsonl",
				getSessionId: () => "message-only-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "message-only-model",
					provider: "message-only-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "message-only prompt",
				systemPrompt: "message-only system",
				systemPromptOptions: { cwd: "/tmp/message-only" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		// Providers that emit no before_provider_request still get one
		// generation carrying the streamed assistant message.
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_update")(
			{
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "streamed" },
			},
			context,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "streamed" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(generations).toHaveLength(1);
		const generation = generations[0];
		if (!generation) throw new Error("message-only generation missing");
		expect((generation.metadata as { requestKey?: string }).requestKey).toBe(
			"turn:0:request:0",
		);
		expect(generation.end).toMatchObject({
			output: assistantOutput("streamed"),
			usage: { input: 1, output: 1, total: 2 },
		});
		await handler("session_shutdown")({}, context);
	});

	it("does not open a second generation when a late message event follows a completed one", async () => {
		const agentDir = tempRoot("pi-langfuse-late-message-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "late-public",
			"secret-key": "late-secret",
			"base-url": "http://late-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "late-model", provider: "late-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--late--/late-session.jsonl",
				getSessionId: () => "late-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "late-model", provider: "late-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "late prompt",
				systemPrompt: "late system",
				systemPromptOptions: { cwd: "/tmp/late" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		// A duplicate/late message_end must attach to the completed generation
		// instead of opening a phantom one that turn cleanup would abandon.
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		const generations = telemetry.state.observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(generations).toHaveLength(1);
		expect(generations[0]?.end).toMatchObject({
			output: assistantOutput("done"),
		});
		await handler("session_shutdown")({}, context);
	});
}
