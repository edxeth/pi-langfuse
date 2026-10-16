import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Registers capture policy, payload budget, source identity, and health score scenarios. */
export function registerCapturePrivacyScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("applies capture policy and payload budgets through registered handlers", async () => {
		const agentDir = tempRoot("pi-langfuse-privacy-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "privacy-public",
			"secret-key": "privacy-secret-1234567890",
			"base-url": "http://privacy-host",
			"capture-policy": "metadata-only",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
			"payload-max-string-chars": 8,
			"payload-max-tool-chars": 8,
			"payload-max-depth": 2,
			"payload-max-array-items": 1,
			"payload-max-object-keys": 10,
			"payload-max-nodes": 20,
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const sessionFile =
			"/tmp/pi-agent/sessions/--privacy--/privacy-session.jsonl";
		const context = {
			model: { id: "privacy-model", provider: "privacy-provider" },
			sessionManager: { getSessionFile: () => sessionFile },
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("before_agent_start")(
			{
				prompt: "prompt privacy-secret-1234567890 with a long suffix",
				systemPrompt: "system privacy-secret-1234567890",
				systemPromptOptions: { cwd: "/tmp/privacy-project-with-a-long-name" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("context")(
			{
				messages: [
					{ role: "system", content: "system privacy-secret-1234567890" },
					{ role: "user", content: "provider input" },
				],
			},
			context,
		);
		await handler("tool_execution_start")(
			{
				toolCallId: "privacy-tool",
				toolName: "bash",
				args: { command: "echo privacy-secret-1234567890" },
			},
			context,
		);
		await handler("before_provider_request")(
			{
				payload: {
					model: "privacy-model",
					messages: [{ role: "user", content: "provider input" }],
				},
			},
			context,
		);
		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "assistant output privacy-secret-1234567890",
						},
					],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		await handler("tool_result")(
			{
				toolCallId: "privacy-tool",
				toolName: "bash",
				input: { command: "echo privacy-secret-1234567890" },
				content: [
					{ type: "text", text: "tool output privacy-secret-1234567890" },
				],
				isError: false,
			},
			context,
		);
		await handler("tool_execution_end")(
			{
				toolCallId: "privacy-tool",
				toolName: "bash",
				result: {
					content: [
						{ type: "text", text: "tool output privacy-secret-1234567890" },
					],
				},
				isError: false,
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
		await handler("session_shutdown")({}, context);
		drainRawTraceQueue();

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		const observations = telemetry.state.observations.filter(
			(record) => record.traceId === trace.id,
		);
		const prompt = latestRecord(observations, "agent.prompt");
		const generation = latestRecord(observations, "llm-response");
		const tool = latestRecord(observations, "tool:bash");
		expect(trace).not.toHaveProperty("input");
		expect(trace.metadata).not.toHaveProperty("systemPrompt");
		expect(prompt).not.toHaveProperty("input");
		expect(prompt.end).not.toHaveProperty("output");
		expect(generation).not.toHaveProperty("input");
		expect(generation.end).not.toHaveProperty("output");
		expect(tool).not.toHaveProperty("input");
		expect(tool.end).not.toHaveProperty("output");
		const traceMetadata = trace.metadata as Record<string, unknown> | undefined;
		expect(String(traceMetadata?.cwd).length).toBeLessThanOrEqual(8);

		const raw = readFileSync(
			join(rawTraceDir, "--privacy--", "privacy-session.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const rawJson = JSON.stringify(raw);
		expect(rawJson).not.toContain("privacy-secret-1234567890");
		expect(rawRecord(raw, "agent_prompt_start")).not.toHaveProperty("prompt");
		expect(rawRecord(raw, "agent_prompt_start")).not.toHaveProperty(
			"systemPrompt",
		);
		expect(rawRecord(raw, "provider_request")).not.toHaveProperty(
			"messagesSummary",
		);
		expect(rawRecord(raw, "tool_execution_start")).not.toHaveProperty("args");
		expect(rawRecord(raw, "assistant_output")).not.toHaveProperty("text");
		expect(rawRecord(raw, "tool_execution_end")).not.toHaveProperty(
			"resultSummary",
		);
	});

	it("captures safe source identity, generation telemetry, and health scores", async () => {
		const agentDir = tempRoot("pi-langfuse-observability-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		const sourceRepo = join(agentDir, "source-repo");
		mkdirSync(sourceRepo, { recursive: true });
		execFileSync("git", ["init"], { cwd: sourceRepo });
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: sourceRepo,
		});
		execFileSync("git", ["config", "user.name", "Test User"], {
			cwd: sourceRepo,
		});
		writeFileSync(join(sourceRepo, "README.md"), "observability\n");
		execFileSync("git", ["add", "README.md"], { cwd: sourceRepo });
		execFileSync("git", ["commit", "-m", "init"], { cwd: sourceRepo });
		execFileSync(
			"git",
			[
				"remote",
				"add",
				"origin",
				"https://token:secret@github.com/example/observability.git",
			],
			{ cwd: sourceRepo },
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const settingsValues = {
			enabled: true,
			"public-key": "observability-public",
			"secret-key": "observability-secret",
			"base-url": "http://observability-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
			"redaction-enabled": false,
		};
		const pi = createTestPi(settingsValues);
		const sessionFile =
			"/tmp/pi-agent/sessions/--observability--/observability-session.jsonl";
		const context = {
			model: { id: "observability-model", provider: "observability-provider" },
			sessionManager: { getSessionFile: () => sessionFile },
		};
		await registerExtension(pi as unknown as ExtensionAPI);
		await eventHandler(pi, "session_start")({}, context);
		await eventHandler(pi, "model_select")(
			{
				model: {
					id: "observability-model",
					provider: "observability-provider",
				},
			},
			context,
		);
		await eventHandler(pi, "before_agent_start")(
			{
				prompt: "observe this repository",
				systemPrompt: "system prompt",
				systemPromptOptions: { cwd: sourceRepo },
			},
			context,
		);
		await eventHandler(pi, "agent_start")({}, context);
		await eventHandler(pi, "turn_start")({ turnIndex: 0 }, context);
		await eventHandler(pi, "tool_execution_start")(
			{
				toolCallId: "tool-error",
				toolName: "bash",
				args: { command: "false" },
			},
			context,
		);
		await eventHandler(pi, "tool_execution_end")(
			{
				toolCallId: "tool-error",
				toolName: "bash",
				result: "failed",
				isError: true,
			},
			context,
		);
		await eventHandler(pi, "before_provider_request")(
			{
				payload: {
					model: "observability-model",
					temperature: 0.2,
					top_p: 0.9,
					max_tokens: 1024,
					reasoning_effort: "high",
					stop: ["END"],
					unsafe_override: "do-not-capture",
				},
			},
			context,
		);
		await eventHandler(pi, "after_provider_response")(
			{
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"X-Request-Id": "provider-request-42",
					"Retry-After": "5",
					"Set-Cookie": "session=provider-secret",
					authorization: "Bearer provider-secret",
				},
				providerMetadata: {
					finishReason: "stop",
					requestId: "provider-request-42",
					apiKey: "provider-secret",
					debugPath: sourceRepo,
					accountAlias: "internal-customer",
				},
			},
			context,
		);
		await eventHandler(pi, "message_start")(
			{ message: { role: "assistant" } },
			context,
		);
		await eventHandler(pi, "message_update")(
			{
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "think" },
			},
			context,
		);
		telemetry.client.score.create.mockImplementationOnce(() => {
			throw new Error("score endpoint unavailable");
		});
		await eventHandler(pi, "message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					model: "observability-model-final",
					usage: {
						input: 2,
						output: 1,
						totalTokens: 3,
						cost: { input: 0, output: 0, total: 0 },
					},
				},
			},
			context,
		);
		await eventHandler(pi, "turn_end")(
			{
				turnIndex: 0,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 2, output: 1, totalTokens: 3 },
				},
				toolResults: [],
			},
			context,
		);
		await eventHandler(pi, "agent_end")(
			{
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
				],
			},
			context,
		);
		// Pi settles every accepted run
		await eventHandler(pi, "agent_settled")({}, context);

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		const generation = latestRecord(
			telemetry.state.observations,
			"llm-response",
		);
		const tool = latestRecord(telemetry.state.observations, "tool:bash");
		const generationEnd = generation.end as Record<string, unknown>;
		expect(trace.metadata).toMatchObject({
			source_type: "git-repo",
			git_remote_host: "github.com",
			git_remote_path: "example/observability",
			repo_identity: "example/observability",
		});
		expect(JSON.stringify(trace.metadata)).not.toContain("token:secret");
		const sourceFields = Object.fromEntries(
			Object.entries(trace.metadata as Record<string, unknown>).filter(
				([key]) =>
					[
						"source_type",
						"git_remote_host",
						"git_remote_path",
						"repo_identity",
						"repo_owner",
						"repo_name",
						"repo_root_name",
						"git_branch",
						"git_commit",
						"metadata_source",
					].includes(key),
			),
		);
		expect(JSON.stringify(sourceFields)).not.toContain(sourceRepo);
		expect(generationEnd).toMatchObject({
			model: "observability-model-final",
			modelParameters: {
				temperature: 0.2,
				top_p: 0.9,
				max_tokens: 1024,
				reasoning_effort: "high",
			},
			metadata: expect.objectContaining({
				providerResponseStatus: 200,
				providerResponseHeaders: {
					"content-type": "application/json",
					"x-request-id": "provider-request-42",
					"retry-after": "5",
				},
				providerResponseMetadata: {
					finishReason: "stop",
					requestId: "provider-request-42",
				},
			}),
		});
		expect(JSON.stringify(generationEnd)).not.toContain("provider-secret");
		expect(JSON.stringify(generationEnd)).not.toContain("Set-Cookie");
		expect(generationEnd.metadata).not.toHaveProperty(
			"providerResponseHeaders.set-cookie",
		);
		expect(JSON.stringify(generationEnd)).not.toContain(sourceRepo);
		expect(JSON.stringify(generationEnd)).not.toContain("internal-customer");
		expect(
			(generationEnd.metadata as Record<string, unknown>)
				.providerResponseMetadata,
		).toEqual({
			finishReason: "stop",
			requestId: "provider-request-42",
		});
		expect(generationEnd).not.toHaveProperty("costDetails");
		expect(generation.updateCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ completionStartTime: expect.any(Date) }),
			]),
		);
		expect(generationEnd.metadata).toEqual(
			expect.objectContaining({ timeToFirstTokenMs: expect.any(Number) }),
		);
		expect(telemetry.state.scores).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "tool_is_error",
					value: 1,
					observationId: tool.id,
				}),
				expect.objectContaining({
					name: "tool_call_count",
					value: 1,
					traceId: trace.id,
				}),
				expect.objectContaining({
					name: "turn_count",
					value: 1,
					traceId: trace.id,
				}),
				expect.objectContaining({
					name: "total_tool_errors",
					value: 1,
					traceId: trace.id,
				}),
				expect.objectContaining({
					name: "tool_success_rate",
					value: 0,
					traceId: trace.id,
				}),
				expect.objectContaining({
					name: "session_had_errors",
					value: 1,
					traceId: trace.id,
				}),
			]),
		);
		for (const score of telemetry.state.scores) {
			const hasTraceId = typeof score.traceId === "string";
			const hasSessionId = typeof score.sessionId === "string";
			const hasObservationId = typeof score.observationId === "string";
			expect(hasSessionId).toBe(false);
			expect(hasTraceId).toBe(true);
			expect(hasObservationId ? hasTraceId : true).toBe(true);
		}
		await eventHandler(pi, "session_shutdown")({}, context);
	});
}
