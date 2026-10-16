import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import {
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	latestRecord,
} from "./compatibility-fixtures.js";

/** Registers the tool and compaction usage accounting scenario. */
export function registerUsageAccountingScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("accounts for tool and compaction usage once, separate from direct generations", async () => {
		const agentDir = tempRoot("pi-langfuse-indirect-usage-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "usage-public",
			"secret-key": "usage-secret",
			"base-url": "http://usage-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const context = {
			model: { id: "usage-model", provider: "usage-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--usage--/usage-session.jsonl",
				getSessionId: () => "usage-session",
			},
		};
		const nestedUsage = {
			input: 1000,
			output: 100,
			totalTokens: 1100,
			cost: { input: 0.3, output: 0.12, total: 0.42 },
		};
		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "usage-model", provider: "usage-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "usage prompt",
				systemPrompt: "usage system",
				systemPromptOptions: { cwd: "/tmp/usage" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);

		// Tool 1: nested model work reported by both result events.
		await handler("tool_execution_start")(
			{ toolCallId: "tool-1", toolName: "bash", args: { command: "echo 1" } },
			context,
		);
		await handler("tool_result")(
			{
				toolCallId: "tool-1",
				toolName: "bash",
				input: { command: "echo 1" },
				content: [{ type: "text", text: "tool one" }],
				isError: false,
				usage: nestedUsage,
			},
			context,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "tool-1",
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "tool one" }],
					usage: nestedUsage,
				},
				isError: false,
			},
			context,
		);

		// Tool 2: usage only visible on the executed result.
		await handler("tool_execution_start")(
			{ toolCallId: "tool-2", toolName: "read", args: { path: "/tmp/2" } },
			context,
		);
		await handler("tool_result")(
			{
				toolCallId: "tool-2",
				toolName: "read",
				input: { path: "/tmp/2" },
				content: [{ type: "text", text: "tool two" }],
				isError: false,
			},
			context,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "tool-2",
				toolName: "read",
				result: {
					content: [{ type: "text", text: "tool two" }],
					usage: {
						input: 200,
						output: 20,
						totalTokens: 220,
						cost: { total: 0.08 },
					},
				},
				isError: false,
			},
			context,
		);

		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 10, output: 5, totalTokens: 15 },
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

		// Compaction summaries report their own model usage; a repeated event
		// for the same compaction entry must not double the usage.
		const compactionEntry = {
			id: "compaction-1",
			type: "compaction",
			summary: "compacted",
			usage: { input: 500, output: 50, totalTokens: 550, cost: { total: 0.3 } },
		};
		await handler("session_compact")({ compactionEntry }, context);
		await handler("session_compact")({ compactionEntry }, context);

		await handler("agent_end")(
			{
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
				],
			},
			context,
		);
		await handler("agent_settled")({}, context);

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		const observations = telemetry.state.observations.filter(
			(record) => record.traceId === trace.id,
		);
		const toolOne = latestRecord(observations, "tool:bash");
		const toolTwo = latestRecord(observations, "tool:read");
		expect(toolOne.end).toMatchObject({
			usage: { input: 1000, output: 100, total: 1100 },
			usageDetails: { input: 1000, output: 100, total: 1100 },
			costDetails: { input: 0.3, output: 0.12, total: 0.42 },
		});
		expect(toolTwo.end).toMatchObject({
			usage: { input: 200, output: 20, total: 220 },
			costDetails: { total: 0.08 },
		});
		// Direct assistant usage stays separate from indirect tool/compaction usage.
		expect(trace.lastUpdate).toMatchObject({
			metadata: {
				tokensIn: 10,
				tokensOut: 5,
				indirectTokensIn: 1700,
				indirectTokensOut: 170,
				indirectCacheRead: 0,
				indirectCacheWrite: 0,
				indirectCost: 0.8,
			},
		});
		expect(latestRecord(observations, "agent.prompt").end).toMatchObject({
			metadata: {
				tokensIn: 10,
				indirectTokensIn: 1700,
				indirectTokensOut: 170,
				indirectCost: 0.8,
			},
		});
		await handler("session_shutdown")({ reason: "quit" }, context);
	});

	it("counts the usage of every compaction event whose entry carries no identity", async () => {
		const agentDir = tempRoot("pi-langfuse-anonymous-compaction-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "anonymous-compaction-public",
			"secret-key": "anonymous-compaction-secret",
			"base-url": "http://anonymous-compaction-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const context = {
			model: { id: "usage-model", provider: "usage-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--anonymous--/anonymous-session.jsonl",
				getSessionId: () => "anonymous-session",
			},
		};
		await handler("session_start")({ reason: "startup" }, context);
		await handler("before_agent_start")(
			{
				prompt: "anonymous compaction prompt",
				systemPrompt: "anonymous system",
				systemPromptOptions: { cwd: "/tmp/anonymous" },
			},
			context,
		);
		await handler("agent_start")({}, context);

		const compactionEntry = {
			type: "compaction",
			summary: "compacted",
			usage: { input: 500, output: 50, totalTokens: 550, cost: { total: 0.3 } },
		};
		await handler("session_compact")({ compactionEntry }, context);
		await handler("session_compact")({ compactionEntry }, context);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context);

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		expect(trace.lastUpdate).toMatchObject({
			metadata: {
				indirectTokensIn: 1000,
				indirectTokensOut: 100,
				indirectCost: 0.6,
			},
		});
		await handler("session_shutdown")({ reason: "quit" }, context);
	});
}
