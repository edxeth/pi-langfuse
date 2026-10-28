import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import { getLastRuntimeError } from "../../src/runtime-diagnostics.js";
import {
	assistantOutput,
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	latestRecord,
} from "./compatibility-fixtures.js";

/** Registers run lifecycle scenarios: agent failures, automatic retry, deferred runs, and custom-message runs. */
export function registerRunLifecycleScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("deduplicates prompt starts and records host-shaped agent failures", async () => {
		const agentDir = tempRoot("pi-langfuse-lifecycle-failure-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "failure-public",
			"secret-key": "failure-secret",
			"base-url": "http://failure-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const sessionFile =
			"/tmp/pi-agent/sessions/--failure--/failure-session.jsonl";
		const context = {
			model: { id: "failure-model", provider: "failure-provider" },
			sessionManager: { getSessionFile: () => sessionFile },
		};
		const promptEvent = {
			prompt: "failure prompt",
			systemPrompt: "failure system",
			systemPromptOptions: { cwd: "/tmp/failure" },
		};
		await handler("session_start")({ reason: "startup" }, context);
		await Promise.all([
			handler("before_agent_start")(promptEvent, context),
			handler("before_agent_start")(promptEvent, context),
		]);
		await handler("before_agent_start")(promptEvent, context);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{ payload: { model: "failure-model" } },
			context,
		);
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "failed" }],
			model: "failure-model",
			usage: { input: 1, output: 0, totalTokens: 1 },
			stopReason: "error",
			errorMessage: "upstream failed",
		};
		await handler("message_end")({ message: failureMessage }, context);
		await handler("turn_end")(
			{ turnIndex: 0, message: failureMessage, toolResults: [] },
			context,
		);
		await handler("agent_end")({ messages: [failureMessage] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run

		expect(telemetry.state.traces).toHaveLength(1);
		const trace = telemetry.state.traces[0];
		if (!trace) throw new Error("failure trace was not created");
		const observations = telemetry.state.observations.filter(
			(record) => record.traceId === trace.id,
		);
		expect(observations.map((record) => record.name)).toEqual([
			"agent.prompt",
			"agent.turn",
			"llm-response",
		]);
		expect(latestRecord(observations, "llm-response").end).toMatchObject({
			isError: true,
			statusMessage: "upstream failed",
			metadata: { stopReason: "error", errorMessage: "upstream failed" },
		});
		expect(latestRecord(observations, "agent.turn").end).toMatchObject({
			isError: true,
			statusMessage: "upstream failed",
			metadata: { stopReason: "error", errorMessage: "upstream failed" },
		});
		expect(latestRecord(observations, "agent.prompt").end).toMatchObject({
			isError: true,
			statusMessage: "agent error: upstream failed",
			metadata: {
				completed: false,
				failed: true,
				stopReason: "error",
				errorMessage: "upstream failed",
			},
		});
		expect(trace.lastUpdate).toMatchObject({
			metadata: {
				completed: false,
				failed: true,
				stopReason: "error",
				errorMessage: "upstream failed",
			},
		});
		drainRawTraceQueue();
		const records = readFileSync(
			join(rawTraceDir, "--failure--", "failure-session.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(
			records.filter((record) => record.type === "agent_prompt_start"),
		).toHaveLength(1);
		await handler("session_shutdown")({ reason: "quit" }, context);
	});

	it("keeps one trace across automatic retry until Pi reports settlement", async () => {
		const agentDir = tempRoot("pi-langfuse-retry-recovery-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "retry-public",
			"secret-key": "retry-secret",
			"base-url": "http://retry-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const context = {
			model: { id: "retry-model", provider: "retry-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--retry--/retry-session.jsonl",
				getSessionId: () => "retry-session",
			},
		};
		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "retry-model", provider: "retry-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "retry prompt",
				systemPrompt: "retry system",
				systemPromptOptions: { cwd: "/tmp/retry" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{ payload: { model: "retry-model" } },
			context,
		);
		const failedMessage = {
			role: "assistant",
			content: [{ type: "text", text: "attempt failed" }],
			model: "retry-model",
			usage: { input: 1, output: 0, totalTokens: 1 },
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
		};
		await handler("message_end")({ message: failedMessage }, context);
		await handler("turn_end")(
			{ turnIndex: 0, message: failedMessage, toolResults: [] },
			context,
		);
		await handler("agent_end")({ messages: [failedMessage] }, context);

		// Pi emits agent_end before deciding to retry: the trace must stay open
		// because the automatic continuation never re-emits before_agent_start.
		expect(telemetry.state.flushes).toBe(0);
		expect(
			latestRecord(telemetry.state.observations, "agent.prompt").endCalls,
		).toBeUndefined();

		// Pi's continuation emits a fresh agent_start/turn_start pair; its turn
		// counter restarts at 0.
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{ payload: { model: "retry-model" } },
			context,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "SUCCESS-ANSWER" }],
					model: "retry-model",
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "SUCCESS-ANSWER" }],
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "SUCCESS-ANSWER" }],
					},
				],
			},
			context,
		);
		await handler("agent_settled")({}, context);

		// Settling finalizes the trace once and does not wait for delivery.
		expect(telemetry.state.flushes).toBe(0);
		expect(telemetry.state.traces).toHaveLength(1);
		const trace = telemetry.state.traces[0];
		if (!trace) throw new Error("recovered trace was not created");
		const observations = telemetry.state.observations.filter(
			(record) => record.traceId === trace.id,
		);
		const prompts = observations.filter(
			(record) => record.name === "agent.prompt",
		);
		const turns = observations.filter((record) => record.name === "agent.turn");
		const generations = observations.filter(
			(record) => record.name === "llm-response",
		);
		expect(prompts).toHaveLength(1);
		expect(turns).toHaveLength(2);
		expect(generations).toHaveLength(2);
		for (const turn of turns) {
			expect(turn.parentObservationId).toBe(prompts[0]?.id);
		}
		const failedGeneration = generations.find(
			(record) => (record.end as Record<string, unknown> | undefined)?.isError,
		);
		const successGeneration = generations.find(
			(record) => record !== failedGeneration,
		);
		expect(failedGeneration?.end).toMatchObject({
			isError: true,
			statusMessage: "503 Service Unavailable",
		});
		expect(successGeneration?.end).toMatchObject({
			output: assistantOutput("SUCCESS-ANSWER"),
			usage: { input: 100, output: 50, total: 150 },
		});
		expect(trace.lastUpdate).toMatchObject({
			output: "SUCCESS-ANSWER",
			metadata: {
				completed: true,
				turns: 2,
				recoveredFailure: {
					stopReason: "error",
					errorMessage: "503 Service Unavailable",
				},
				recoveredFailureCount: 1,
			},
		});
		const finalMetadata = (
			trace.lastUpdate as { metadata?: Record<string, unknown> }
		).metadata;
		expect(finalMetadata?.failed).toBeFalsy();
		expect(prompts[0]?.end).toMatchObject({
			output: "SUCCESS-ANSWER",
			metadata: {
				completed: true,
				turns: 2,
				recoveredFailureCount: 1,
			},
		});
		await handler("session_shutdown")({ reason: "quit" }, context);
	});

	it("tracks a deferred custom triggerTurn run that never saw before_agent_start", async () => {
		const agentDir = tempRoot("pi-langfuse-deferred-trigger-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "deferred-public",
			"secret-key": "deferred-secret",
			"base-url": "http://deferred-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const context = {
			model: { id: "deferred-model", provider: "deferred-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--deferred--/deferred-session.jsonl",
				getSessionId: () => "deferred-session",
			},
		};
		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "deferred-model", provider: "deferred-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "first prompt",
				systemPrompt: "first system",
				systemPromptOptions: { cwd: "/tmp/deferred" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "first answer" }],
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
		await handler("agent_end")(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "first answer" }],
					},
				],
			},
			context,
		);
		await handler("agent_settled")({}, context);

		// pi.sendMessage(..., { triggerTurn: true }) during agent_settled
		// defers a real agent run that starts without before_agent_start once
		// the settled dispatch finishes. The concurrent duplicate agent_start
		// must not open a second prompt.
		await Promise.all([
			handler("agent_start")({}, context),
			handler("agent_start")({}, context),
		]);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "custom-trigger answer" }],
					usage: { input: 2, output: 3, totalTokens: 5 },
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
		await handler("agent_end")(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "custom-trigger answer" }],
					},
				],
			},
			context,
		);
		await handler("agent_settled")({}, context);

		expect(telemetry.state.traces).toHaveLength(2);
		const firstTrace = telemetry.state.traces[0];
		const secondTrace = telemetry.state.traces[1];
		if (!firstTrace || !secondTrace) {
			throw new Error("expected one trace per run");
		}
		expect(firstTrace.input).toContain("first prompt");
		expect(firstTrace.metadata).toMatchObject({ completed: true });
		// The deferred run has no user prompt: it must be represented without
		// pretending the custom message was one.
		expect(secondTrace.input).toBeUndefined();
		expect(secondTrace.metadata).toMatchObject({
			completed: true,
			promptSource: "unannounced-agent-run",
		});
		const secondObservations = telemetry.state.observations.filter(
			(record) => record.traceId === secondTrace.id,
		);
		expect(secondObservations.map((record) => record.name)).toEqual([
			"agent.prompt",
			"agent.turn",
			"llm-response",
		]);
		expect(latestRecord(secondObservations, "agent.prompt").end).toMatchObject({
			output: "custom-trigger answer",
			metadata: { completed: true },
		});
		expect(latestRecord(secondObservations, "llm-response").end).toMatchObject({
			output: assistantOutput("custom-trigger answer"),
			usage: { input: 2, output: 3, total: 5 },
		});
		// Neither settlement waits for delivery.
		expect(telemetry.state.flushes).toBe(0);

		drainRawTraceQueue();
		const records = readFileSync(
			join(rawTraceDir, "--deferred--", "deferred-session.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const starts = records.filter(
			(record) => record.type === "agent_prompt_start",
		);
		expect(starts).toHaveLength(2);
		expect(starts[0]).toMatchObject({ prompt: "first prompt" });
		expect(starts[0]).not.toHaveProperty("promptSource");
		expect(starts[1]).toMatchObject({
			prompt: "",
			promptSource: "unannounced-agent-run",
		});
		await handler("session_shutdown")({ reason: "quit" }, context);
	});

	it("traces a custom-message run announced by a before_agent_start without prompt", async () => {
		const agentDir = tempRoot("pi-langfuse-custom-start-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "custom-start-public",
			"secret-key": "custom-start-secret",
			"base-url": "http://custom-start-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const context = {
			model: { id: "custom-start-model", provider: "custom-start-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--custom-start--/custom-start-session.jsonl",
				getSessionId: () => "custom-start-session",
			},
		};
		const runtimeErrorBefore = getLastRuntimeError();
		await handler("session_start")({ reason: "startup" }, context);

		// Since Pi 1.2.0, pi.sendMessage(..., { triggerTurn: true }) while idle
		// fires before_agent_start with messageType "custom", the starting
		// message, and no prompt.
		await handler("before_agent_start")(
			{
				messageType: "custom",
				message: {
					role: "custom",
					customType: "reminder",
					content: "custom message body",
					display: true,
					timestamp: 1,
				},
				systemPrompt: "custom system",
				systemPromptOptions: { cwd: "/tmp/custom-start" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "custom-run answer" }],
					usage: { input: 2, output: 3, totalTokens: 5 },
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
		await handler("agent_end")(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "custom-run answer" }],
					},
				],
			},
			context,
		);
		await handler("agent_settled")({}, context);

		expect(getLastRuntimeError()).toBe(runtimeErrorBefore);
		expect(telemetry.state.traces).toHaveLength(1);
		const trace = telemetry.state.traces[0];
		if (!trace) throw new Error("expected a trace for the custom-message run");
		// A custom message is not a user prompt, so the run is traced like any
		// other run that no user prompt announced.
		expect(trace.input).toBeUndefined();
		expect(trace.metadata).toMatchObject({
			completed: true,
			promptSource: "unannounced-agent-run",
		});
		const observations = telemetry.state.observations.filter(
			(record) => record.traceId === trace.id,
		);
		expect(observations.map((record) => record.name)).toEqual([
			"agent.prompt",
			"agent.turn",
			"llm-response",
		]);
		expect(latestRecord(observations, "llm-response").end).toMatchObject({
			output: assistantOutput("custom-run answer"),
			usage: { input: 2, output: 3, total: 5 },
		});

		drainRawTraceQueue();
		const starts = readFileSync(
			join(rawTraceDir, "--custom-start--", "custom-start-session.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((record) => record.type === "agent_prompt_start");
		expect(starts).toEqual([
			expect.objectContaining({
				prompt: "",
				promptSource: "unannounced-agent-run",
			}),
		]);
		await handler("session_shutdown")({ reason: "quit" }, context);
	});

	it("retags the active trace when the model changes during a prompt", async () => {
		const agentDir = tempRoot("pi-langfuse-model-change-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "model-change-public",
			"secret-key": "model-change-secret",
			"base-url": "http://model-change-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const context = {
			model: { id: "first-model", provider: "first-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--model-change--/model-change-session.jsonl",
			},
		};
		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "first-model", provider: "first-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "model change prompt",
				systemPrompt: "model change system",
				systemPromptOptions: { cwd: "/tmp/model-change" },
			},
			context,
		);

		await handler("model_select")(
			{ model: { id: "second-model", provider: "second-provider" } },
			context,
		);

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		expect(trace.lastUpdate).toMatchObject({
			metadata: { model: "second-model", provider: "second-provider" },
		});
		const tags = (trace.lastUpdate as { tags?: string[] }).tags ?? [];
		expect(tags).toContain("model:second-model");
		expect(tags).toContain("provider:second-provider");
		expect(tags).not.toContain("model:first-model");

		// Pi requires a model object but not non-empty identifiers: the legacy
		// registerProvider path accepts empty model ids and provider names.
		const emptyIdModel = {
			id: "",
			name: "review model",
			api: "openai-completions",
			provider: "review-provider",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 256,
		};
		const selectModel = (model: typeof emptyIdModel) =>
			handler("model_select")(
				{
					type: "model_select",
					model,
					previousModel: undefined,
					source: "set",
				},
				context,
			);
		await selectModel(emptyIdModel);
		expect(
			latestRecord(telemetry.state.traces, "pi-agent").lastUpdate,
		).toMatchObject({
			metadata: { model: "", provider: "review-provider" },
		});
		await selectModel({ ...emptyIdModel, id: "review-model", provider: "" });
		expect(
			latestRecord(telemetry.state.traces, "pi-agent").lastUpdate,
		).toMatchObject({
			metadata: { model: "review-model", provider: "" },
		});
		await handler("session_shutdown")({ reason: "quit" }, context);
	});
}
