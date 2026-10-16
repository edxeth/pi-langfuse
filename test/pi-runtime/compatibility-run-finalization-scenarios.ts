import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	assistantOutput,
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	latestRecord,
	settingsListener,
	settingsRegistrations,
	waitForSettingsRegistration,
} from "./compatibility-fixtures.js";

/** Registers the partial-run finalization scenario across duplicate lifecycle and session replacement events. */
export function registerRunFinalizationScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("finalizes partial runs once across duplicate lifecycle and session replacement events", async () => {
		const agentDir = tempRoot("pi-langfuse-lifecycle-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const settingsValues = {
			enabled: true,
			"public-key": "lifecycle-public",
			"secret-key": "lifecycle-secret",
			"base-url": "http://lifecycle-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		};
		const pi = createTestPi(settingsValues);
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const fileA = "/tmp/pi-agent/sessions/--lifecycle-a--/lifecycle-a.jsonl";
		const contextA = {
			model: { id: "model-a", provider: "provider-a" },
			sessionManager: {
				getSessionFile: () => fileA,
				getSessionId: () => "manager-a",
			},
		};

		await handler("session_start")({ reason: "startup" }, contextA);
		await handler("before_agent_start")(
			{
				prompt: "partial prompt",
				systemPrompt: "partial system",
				systemPromptOptions: { cwd: "/tmp/lifecycle-a" },
			},
			contextA,
		);
		await Promise.all([
			handler("agent_start")({}, contextA),
			handler("agent_start")({}, contextA),
		]);
		await Promise.all([
			handler("turn_start")({ turnIndex: 0 }, contextA),
			handler("turn_start")({ turnIndex: 0 }, contextA),
		]);
		await handler("turn_end")(
			{
				turnIndex: 1,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			contextA,
		);
		await handler("turn_start")({ turnIndex: 1 }, contextA);
		await handler("before_provider_request")(
			{
				payload: {
					model: "model-a",
					messages: [{ role: "user", content: "partial prompt" }],
				},
			},
			contextA,
		);
		await Promise.all([
			handler("message_start")({ message: { role: "assistant" } }, contextA),
			handler("message_start")({ message: { role: "assistant" } }, contextA),
		]);
		await handler("tool_execution_start")(
			{
				toolCallId: "partial-tool",
				toolName: "bash",
				args: { command: "echo partial" },
			},
			contextA,
		);
		await handler("tool_execution_start")(
			{
				toolCallId: "partial-tool",
				toolName: "bash",
				args: { command: "echo partial" },
			},
			contextA,
		);
		await handler("tool_execution_start")(
			{
				toolCallId: "completed-tool",
				toolName: "write",
				args: { path: "/tmp/completed" },
			},
			contextA,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "completed-tool",
				toolName: "write",
				result: { content: [{ type: "text", text: "done" }] },
				isError: false,
			},
			contextA,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "completed-tool",
				toolName: "write",
				result: { content: [{ type: "text", text: "duplicate" }] },
				isError: true,
			},
			contextA,
		);
		await handler("session_compact")({}, contextA);

		await Promise.all([
			handler("agent_end")({ messages: [] }, contextA),
			handler("agent_end")({ messages: [] }, contextA),
		]);
		await Promise.all([
			handler("agent_settled")({}, contextA),
			handler("agent_settled")({}, contextA),
		]);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			contextA,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "late" }],
				},
			},
			contextA,
		);

		const traceA = latestRecord(telemetry.state.traces, "pi-agent");
		const observationsA = telemetry.state.observations.filter(
			(record) => record.traceId === traceA.id,
		);
		expect(observationsA.map((record) => record.name)).toEqual([
			"agent.prompt",
			"agent.turn",
			"llm-response",
			"tool:bash",
			"tool:write",
		]);
		expect(observationsA).toHaveLength(5);
		for (const observation of observationsA) {
			expect(observation.endCalls).toBe(1);
		}
		expect(latestRecord(observationsA, "agent.prompt").end).toMatchObject({
			isError: true,
			statusMessage: "prompt abandoned during agent finalization",
			metadata: { abandoned: true, compactCount: 1 },
		});
		expect(latestRecord(observationsA, "agent.turn").end).toMatchObject({
			isError: true,
			statusMessage: "turn ended during cleanup",
			metadata: { abandoned: true },
		});
		expect(latestRecord(observationsA, "llm-response").end).toMatchObject({
			isError: true,
			statusMessage: "generation abandoned during prompt finalization",
			metadata: { abandoned: true },
		});
		expect(latestRecord(observationsA, "tool:bash").end).toMatchObject({
			isError: true,
			statusMessage: "tool ended without completion event",
			metadata: { abandoned: true },
		});
		expect(latestRecord(observationsA, "tool:write").end).toMatchObject({
			isError: false,
			output: "done",
		});
		expect(traceA.lastUpdate).toMatchObject({
			metadata: {
				completed: false,
				abandoned: true,
				compactCount: 1,
				toolCalls: 2,
			},
		});

		await Promise.all([
			handler("session_shutdown")({ reason: "resume" }, contextA),
			handler("session_shutdown")({ reason: "resume" }, contextA),
		]);
		drainRawTraceQueue();
		const rawA = readFileSync(
			join(rawTraceDir, "--lifecycle-a--", "lifecycle-a.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(rawA.filter((record) => record.type === "session_end")).toHaveLength(
			1,
		);
		const observationCountAfterA = telemetry.state.observations.length;
		await handler("tool_execution_end")(
			{
				toolCallId: "partial-tool",
				toolName: "bash",
				result: { content: [{ type: "text", text: "late" }] },
				isError: false,
			},
			contextA,
		);
		await handler("turn_start")({ turnIndex: 0 }, contextA);
		expect(telemetry.state.observations).toHaveLength(observationCountAfterA);

		const fileB = "/tmp/pi-agent/sessions/--lifecycle-b--/lifecycle-b.jsonl";
		const contextB = {
			model: { id: "model-b", provider: "provider-b" },
			sessionManager: {
				getSessionFile: () => fileB,
				getSessionId: () => "manager-b",
			},
		};
		await handler("session_start")(
			{ reason: "resume", previousSessionFile: fileA },
			contextB,
		);
		await handler("before_agent_start")(
			{
				prompt: "refresh prompt",
				systemPrompt: "refresh system",
				systemPromptOptions: { cwd: "/tmp/lifecycle-b" },
			},
			contextB,
		);
		await handler("agent_start")({}, contextB);
		await handler("turn_start")({ turnIndex: 0 }, contextB);
		const refreshRegistrationCount = settingsRegistrations(pi).length;
		await settingsListener(pi, "pi-extension-settings:pi-langfuse:changed")();
		await waitForSettingsRegistration(pi, refreshRegistrationCount);
		await handler("agent_end")({ messages: [] }, contextB);
		await handler("session_shutdown")({ reason: "fork" }, contextB);

		const fileC = "/tmp/pi-agent/sessions/--lifecycle-c--/lifecycle-c.jsonl";
		const contextC = {
			model: { id: "model-c", provider: "provider-c" },
			sessionManager: {
				getSessionFile: () => fileC,
				getSessionId: () => "manager-c",
			},
		};
		await handler("session_start")(
			{ reason: "fork", previousSessionFile: fileB },
			contextC,
		);
		await handler("before_agent_start")(
			{
				prompt: "complete prompt",
				systemPrompt: "complete system",
				systemPromptOptions: { cwd: "/tmp/lifecycle-c" },
			},
			contextC,
		);
		await handler("agent_start")({}, contextC);
		await handler("turn_start")({ turnIndex: 0 }, contextC);
		await handler("before_provider_request")(
			{ payload: { model: "model-c" } },
			contextC,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "complete" }],
					usage: { input: 1, output: 2, totalTokens: 3 },
				},
			},
			contextC,
		);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "duplicate" }],
					usage: { input: 4, output: 5, totalTokens: 9 },
				},
			},
			contextC,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			contextC,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			contextC,
		);
		await handler("agent_end")({ messages: [] }, contextC);
		await handler("agent_settled")({}, contextC); // Pi settles every accepted run

		const traceC = telemetry.state.traces.find(
			(record) => record.sessionId === "lifecycle-c",
		);
		if (!traceC) throw new Error("forked session trace was not created");
		const observationsC = telemetry.state.observations.filter(
			(record) => record.traceId === traceC.id,
		);
		expect(observationsC.map((record) => record.name)).toEqual([
			"agent.prompt",
			"agent.turn",
			"llm-response",
		]);
		expect(latestRecord(observationsC, "llm-response").endCalls).toBe(1);
		expect(latestRecord(observationsC, "llm-response").end).toMatchObject({
			output: assistantOutput("complete"),
			usage: { input: 1, output: 2, total: 3 },
		});
		expect(latestRecord(observationsC, "agent.prompt").end).toMatchObject({
			metadata: { completed: true, turns: 1 },
		});
		await handler("session_shutdown")({ reason: "quit" }, contextC);
	});
}
