import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	latestRecord,
	rawRecord,
} from "./compatibility-fixtures.js";

/** Registers concurrent tool correlation and child-generation cleanup scenarios. */
export function registerToolLifecycleScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("correlates concurrent tool lifecycle events through registered handlers", async () => {
		const agentDir = tempRoot("pi-langfuse-tool-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		const sessionFile =
			"/tmp/pi-agent/sessions/--tool-project--/tool-session.jsonl";
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "tool-public",
			"secret-key": "tool-secret",
			"base-url": "http://tool-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "tool-model", provider: "tool-provider" },
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => "tool-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "tool-model", provider: "tool-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "tool prompt",
				systemPrompt: "tool system",
				systemPromptOptions: { cwd: "/tmp/tool-project" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		await Promise.all([
			handler("tool_call")(
				{
					toolCallId: "tool-a",
					toolName: "bash",
					input: { command: "echo a" },
				},
				context,
			),
			handler("tool_execution_start")(
				{
					toolCallId: "tool-b",
					toolName: "read",
					args: { path: "/tmp/b.txt" },
				},
				context,
			),
		]);
		await handler("tool_execution_start")(
			{
				toolCallId: "tool-a",
				toolName: "bash",
				args: { command: "echo a" },
			},
			context,
		);
		await Promise.all([
			handler("tool_execution_update")(
				{
					toolCallId: "tool-a",
					toolName: "bash",
					args: { command: "echo a" },
					partialResult: { content: [{ type: "text", text: "partial a" }] },
				},
				context,
			),
			handler("tool_execution_update")(
				{
					toolCallId: "tool-b",
					toolName: "read",
					args: { path: "/tmp/b.txt" },
					partialResult: {
						content: [{ type: "image", data: "data:image/png;base64,AAAA" }],
					},
				},
				context,
			),
		]);
		await handler("tool_execution_start")(
			{
				toolCallId: "tool-c",
				toolName: "edit",
				args: { path: "/tmp/c.txt" },
			},
			context,
		);
		await handler("tool_execution_update")(
			{
				toolCallId: "tool-c",
				toolName: "edit",
				args: { path: "/tmp/c.txt" },
				partialResult: { content: [{ type: "text", text: "partial c" }] },
			},
			context,
		);
		await handler("tool_execution_start")(
			{
				toolCallId: "tool-d",
				toolName: "write",
				args: { path: "/tmp/d.txt" },
			},
			context,
		);

		// Completion events arrive out of order. Each event is independently usable,
		// and a later companion event must not create or end another span.
		await handler("tool_result")(
			{
				toolCallId: "tool-b",
				toolName: "read",
				input: { path: "/tmp/b.txt" },
				content: [
					{ type: "text", text: "provisional read" },
					{ type: "image", data: "data:image/png;base64,BBBB" },
				],
				isError: false,
			},
			context,
		);
		await handler("tool_result")(
			{
				toolCallId: "tool-d",
				toolName: "write",
				input: { path: "/tmp/d.txt" },
				content: [{ type: "text", text: "result-only" }],
				isError: false,
			},
			context,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "tool-a",
				toolName: "bash",
				result: { content: [{ type: "text", text: "result a" }] },
				isError: false,
			},
			context,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "tool-b",
				toolName: "read",
				result: { content: [{ type: "text", text: "read failed" }] },
				isError: true,
			},
			context,
		);

		await handler("session_shutdown")({}, context);
		drainRawTraceQueue();

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		const turn = latestRecord(telemetry.state.observations, "agent.turn");
		const tools = telemetry.state.observations.filter((record) =>
			["tool:bash", "tool:read", "tool:edit", "tool:write"].includes(
				record.name || "",
			),
		);
		expect(tools).toHaveLength(4);
		expect(tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"tool:bash",
				"tool:read",
				"tool:edit",
				"tool:write",
			]),
		);
		for (const tool of tools) {
			expect(tool.traceId).toBe(trace.id);
			expect(tool.parentObservationId).toBe(turn.id);
			expect(tool.endCalls).toBe(1);
			expect(tool.end).toMatchObject({
				metadata: { durationMs: expect.any(Number) },
			});
		}
		// Progress never reaches a span on its own (spans export once, at
		// end); a tool that completes exports its final output unmarked.
		const bashEnd = latestRecord(telemetry.state.observations, "tool:bash")
			.end as Record<string, unknown>;
		expect(bashEnd).toMatchObject({
			isError: false,
			output: "result a",
		});
		expect(bashEnd.metadata).not.toHaveProperty("partial");
		expect(
			latestRecord(telemetry.state.observations, "tool:read").end,
		).toMatchObject({
			isError: true,
			output: "read failed",
		});
		// The abandoned edit keeps its own latest progress, marked partial.
		expect(
			latestRecord(telemetry.state.observations, "tool:edit").end,
		).toMatchObject({
			isError: true,
			output: "partial c",
			statusMessage: "tool ended without completion event",
			metadata: { abandoned: true, partial: true },
		});
		const resultOnlyEnd = latestRecord(
			telemetry.state.observations,
			"tool:write",
		).end as Record<string, unknown>;
		expect(resultOnlyEnd).toMatchObject({
			isError: false,
			output: "result-only",
		});
		expect(resultOnlyEnd.metadata).not.toHaveProperty("abandoned");
		expect(
			latestRecord(telemetry.state.traces, "pi-agent").lastUpdate,
		).toMatchObject({
			metadata: { toolCalls: 4, toolErrors: 1 },
		});

		const rawPath = join(rawTraceDir, "--tool-project--", "tool-session.jsonl");
		const records = readFileSync(rawPath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(
			records.filter((record) => record.type === "tool_call"),
		).toHaveLength(1);
		expect(
			records.filter((record) => record.type === "tool_execution_start"),
		).toHaveLength(4);
		expect(
			records.filter((record) => record.type === "tool_result_first_seen"),
		).toHaveLength(2);
		expect(
			records.filter((record) => record.type === "tool_execution_end"),
		).toHaveLength(2);
		expect(rawRecord(records, "tool_result_first_seen")).toMatchObject({
			toolCallId: "tool-b",
			contentSummary:
				"provisional read\n[1 image content block(s) from tool result]",
			imgBlocks: 1,
			isError: false,
		});
		expect(
			records
				.filter((record) => record.type === "tool_execution_end")
				.map((record) => record.toolCallId),
		).toEqual(expect.arrayContaining(["tool-a", "tool-b"]));
	});

	it("closes child generations before turn cleanup and treats result-only tools as complete", async () => {
		const agentDir = tempRoot("pi-langfuse-lifecycle-children-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "children-public",
			"secret-key": "children-secret",
			"base-url": "http://children-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const contextA = {
			model: { id: "model-a", provider: "provider-a" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--children-a--/children-a.jsonl",
			},
		};
		await handler("session_start")({ reason: "startup" }, contextA);
		await handler("before_agent_start")(
			{
				prompt: "unfinished generation",
				systemPrompt: "system",
				systemPromptOptions: { cwd: "/tmp/children-a" },
			},
			contextA,
		);
		await handler("agent_start")({}, contextA);
		await handler("turn_start")({ turnIndex: 0 }, contextA);
		await handler("before_provider_request")(
			{ payload: { model: "model-a" } },
			contextA,
		);
		await handler("message_start")(
			{ message: { role: "assistant" } },
			contextA,
		);
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
		await handler("agent_end")({ messages: [] }, contextA);
		await handler("agent_settled")({}, contextA); // Pi settles every accepted run

		const traceA = latestRecord(telemetry.state.traces, "pi-agent");
		const generationA = latestRecord(
			telemetry.state.observations.filter(
				(record) => record.traceId === traceA.id,
			),
			"llm-response",
		);
		expect(generationA.endCalls).toBe(1);
		expect(generationA.end).toMatchObject({
			isError: true,
			statusMessage: "generation abandoned during prompt finalization",
		});
		expect(traceA.lastUpdate).toMatchObject({
			metadata: {
				completed: false,
				abandoned: true,
				abandonmentReason: "turn ended before generation completion",
			},
		});
		expect(
			telemetry.state.scores.filter((score) => score.traceId === traceA.id),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "session_had_errors",
					value: 1,
				}),
			]),
		);
		const promptA = latestRecord(
			telemetry.state.observations.filter(
				(record) => record.traceId === traceA.id,
			),
			"agent.prompt",
		);
		expect(promptA.end).toMatchObject({
			metadata: {
				completed: false,
				abandoned: true,
				abandonmentReason: "turn ended before generation completion",
			},
		});
		await handler("session_shutdown")({ reason: "resume" }, contextA);

		const contextB = {
			model: { id: "model-b", provider: "provider-b" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--children-b--/children-b.jsonl",
			},
		};
		await handler("session_start")(
			{
				reason: "resume",
				previousSessionFile: contextA.sessionManager.getSessionFile(),
			},
			contextB,
		);
		await handler("before_agent_start")(
			{
				prompt: "result-only tool",
				systemPrompt: "system",
				systemPromptOptions: { cwd: "/tmp/children-b" },
			},
			contextB,
		);
		await handler("agent_start")({}, contextB);
		await handler("turn_start")({ turnIndex: 0 }, contextB);
		await handler("tool_result")(
			{
				toolCallId: "result-only",
				toolName: "bash",
				input: { command: "echo done" },
				content: [{ type: "text", text: "done" }],
				isError: false,
			},
			contextB,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			contextB,
		);
		await handler("agent_end")({ messages: [] }, contextB);
		await handler("agent_settled")({}, contextB); // Pi settles every accepted run

		const traceB = telemetry.state.traces.find(
			(record) => record.sessionId === "children-b",
		);
		if (!traceB) throw new Error("result-only tool trace was not created");
		const observationsB = telemetry.state.observations.filter(
			(record) => record.traceId === traceB.id,
		);
		expect(latestRecord(observationsB, "agent.prompt").end).toMatchObject({
			metadata: { completed: true },
		});
		expect(latestRecord(observationsB, "tool:bash").end).toMatchObject({
			isError: false,
			output: "done",
		});
		expect(
			(latestRecord(observationsB, "tool:bash").end as Record<string, unknown>)
				.metadata,
		).not.toHaveProperty("abandoned");
		await handler("session_shutdown")({ reason: "quit" }, contextB);
	});
}
