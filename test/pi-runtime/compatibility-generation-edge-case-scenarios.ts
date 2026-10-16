import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import {
	assistantOutput,
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
} from "./compatibility-fixtures.js";

/** Registers generation edge cases: late events, unrecognized and unserializable payloads, retry reuse, and model parameters. */
export function registerGenerationEdgeCaseScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("attaches late message and response events to the completed generation without opening a phantom", async () => {
		const agentDir = tempRoot("pi-langfuse-late-events-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "late-events-public",
			"secret-key": "late-events-secret",
			"base-url": "http://late-events-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "late-events-model", provider: "late-events-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--late-events--/late-events-session.jsonl",
				getSessionId: () => "late-events-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "late-events-model",
					provider: "late-events-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "late events prompt",
				systemPrompt: "late events system",
				systemPromptOptions: { cwd: "/tmp/late-events" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{
				payload: {
					model: "late-events-model",
					messages: [{ role: "user", content: "REQ-late events" }],
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
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		// Out-of-order host deliveries after completion must reuse the ended
		// generation lookup result and hit the ended guards, not open a new one.
		await handler("message_update")(
			{
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "late delta" },
			},
			context,
		);
		await handler("after_provider_response")(
			{ status: 200, headers: {} },
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

	it("treats non-object payloads as unrecognized requests without model parameters", async () => {
		const agentDir = tempRoot("pi-langfuse-non-object-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "non-object-public",
			"secret-key": "non-object-secret",
			"base-url": "http://non-object-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: {
				id: "non-object-model",
				provider: "non-object-provider",
			},
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--non-object--/non-object-session.jsonl",
				getSessionId: () => "non-object-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "non-object-model",
					provider: "non-object-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "non-object prompt",
				systemPrompt: "non-object system",
				systemPromptOptions: { cwd: "/tmp/non-object" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		// A provider request whose payload is not an object must still be
		// tracked under the session model without model parameters.
		await handler("before_provider_request")(
			{ payload: "INPUT-non-object payload" as unknown },
			context,
		);
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
			model: "non-object-model",
		});
		const generationEnd = generations[0]?.end as
			| Record<string, unknown>
			| undefined;
		expect(generationEnd?.modelParameters).toBeUndefined();
		await handler("session_shutdown")({}, context);
	});

	it("does not coalesce same-turn requests with unserializable payloads", async () => {
		const agentDir = tempRoot("pi-langfuse-unserializable-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "unserializable-public",
			"secret-key": "unserializable-secret",
			"base-url": "http://unserializable-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: {
				id: "unserializable-model",
				provider: "unserializable-provider",
			},
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--unserializable--/unserializable-session.jsonl",
				getSessionId: () => "unserializable-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "unserializable-model",
					provider: "unserializable-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "unserializable prompt",
				systemPrompt: "unserializable system",
				systemPromptOptions: { cwd: "/tmp/unserializable" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		// Identity is unavailable for unserializable payloads; each request
		// must open its own generation instead of coalescing into the first.
		const cyclicPayload = (marker: string) => {
			const payload: Record<string, unknown> = { marker };
			payload.self = payload;
			return payload;
		};
		await handler("before_provider_request")(
			{ payload: cyclicPayload("first") },
			context,
		);
		// A failed response materializes the first generation.
		await handler("after_provider_response")(
			{ status: 429, headers: {} },
			context,
		);
		await handler("before_provider_request")(
			{ payload: cyclicPayload("second") },
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

		const requestKeys = telemetry.state.observations
			.filter((record) => record.name === "llm-response")
			.map(
				(generation) =>
					(generation.metadata as { requestKey?: string }).requestKey,
			)
			.sort();
		expect(requestKeys).toEqual(["turn:0:request:0", "turn:0:request:1"]);
		await handler("session_shutdown")({}, context);
	});

	it("flows late message events to the newest active request after a newer request completed", async () => {
		const agentDir = tempRoot("pi-langfuse-newest-active-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "newest-active-public",
			"secret-key": "newest-active-secret",
			"base-url": "http://newest-active-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: {
				id: "newest-active-model",
				provider: "newest-active-provider",
			},
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--newest-active--/newest-active-session.jsonl",
				getSessionId: () => "newest-active-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "newest-active-model",
					provider: "newest-active-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "newest active prompt",
				systemPrompt: "newest active system",
				systemPromptOptions: { cwd: "/tmp/newest-active" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		// Two explicit-key requests; only the newest is completed. A late
		// message event must flow to the older request that is still active,
		// not to the completed one and not to a phantom generation.
		await handler("before_provider_request")(
			{
				requestId: "req-1",
				payload: {
					model: "newest-active-model",
					messages: [{ role: "user", content: "REQ-one" }],
				},
			},
			context,
		);
		await handler("before_provider_request")(
			{
				requestId: "req-2",
				payload: {
					model: "newest-active-model",
					messages: [{ role: "user", content: "REQ-two" }],
				},
			},
			context,
		);
		await handler("message_end")(
			{
				requestId: "req-2",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "second done" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		await handler("message_update")(
			{
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "late delta" },
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
		const byRequestKey = new Map(
			generations.map((generation) => [
				(generation.metadata as { requestKey?: string }).requestKey,
				generation,
			]),
		);
		// The late delta materialized the still-active request's generation.
		const firstGeneration = byRequestKey.get("req-1");
		if (!firstGeneration) throw new Error("active request generation missing");
		const firstUpdates =
			(firstGeneration.updateCalls as
				| Array<Record<string, unknown>>
				| undefined) ?? [];
		expect(
			firstUpdates.some(
				(update) =>
					(update.metadata as { timeToFirstTokenMs?: number })
						?.timeToFirstTokenMs !== undefined,
			),
		).toBe(true);
		expect(byRequestKey.get("req-2")?.end).toMatchObject({
			output: assistantOutput("second done"),
		});
		await handler("session_shutdown")({}, context);
	});

	// A same-id retry must reuse the existing generation state, not replace
	// it: one observation that carries the earlier response metadata and ends
	// normally with the streamed output.
	it("reuses the pinned generation state across a same-id retry", async () => {
		const agentDir = tempRoot("pi-langfuse-retry-reuse-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "retry-reuse-public",
			"secret-key": "retry-reuse-secret",
			"base-url": "http://retry-reuse-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: {
				id: "retry-reuse-model",
				provider: "retry-reuse-provider",
			},
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--retry-reuse--/retry-reuse-session.jsonl",
				getSessionId: () => "retry-reuse-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "retry-reuse-model",
					provider: "retry-reuse-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "retry reuse prompt",
				systemPrompt: "retry reuse system",
				systemPromptOptions: { cwd: "/tmp/retry-reuse" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{
				requestId: "provider-req-1",
				payload: {
					model: "retry-reuse-model",
					messages: [{ role: "user", content: "REQ-retry" }],
				},
			},
			context,
		);
		await handler("after_provider_response")(
			{ requestId: "provider-req-1", status: 429, headers: {} },
			context,
		);
		await handler("before_provider_request")(
			{
				requestId: "provider-req-1",
				payload: {
					model: "retry-reuse-model",
					messages: [{ role: "user", content: "REQ-retry" }],
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
		expect(generations).toHaveLength(1);
		const generation = generations[0];
		if (!generation) throw new Error("pinned generation missing");
		expect((generation.metadata as { requestKey?: string }).requestKey).toBe(
			"provider-req-1",
		);
		// The retried request kept the original state: response metadata and a
		// normal end survive the retry instead of a replacement state.
		expect(generation.metadata).toMatchObject({
			providerResponseStatuses: [429],
		});
		expect(generation.end).toMatchObject({ output: assistantOutput("done") });
		await handler("session_shutdown")({}, context);
	});

	// Responses-style reasoning effort may arrive as a number; it must be
	// reported under the flat reasoning_effort parameter either way.
	it("reports numeric Responses reasoning effort as a model parameter", async () => {
		const agentDir = tempRoot("pi-langfuse-numeric-effort-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "numeric-effort-public",
			"secret-key": "numeric-effort-secret",
			"base-url": "http://numeric-effort-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: {
				id: "numeric-effort-model",
				provider: "numeric-effort-provider",
			},
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--numeric-effort--/numeric-effort-session.jsonl",
				getSessionId: () => "numeric-effort-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{
				model: {
					id: "numeric-effort-model",
					provider: "numeric-effort-provider",
				},
			},
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "numeric effort prompt",
				systemPrompt: "numeric effort system",
				systemPromptOptions: { cwd: "/tmp/numeric-effort" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{
				payload: {
					model: "numeric-effort-model",
					messages: [{ role: "user", content: "REQ-effort" }],
					reasoning: { effort: 2 },
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
			modelParameters: { reasoning_effort: 2 },
		});
		await handler("session_shutdown")({}, context);
	});
}
