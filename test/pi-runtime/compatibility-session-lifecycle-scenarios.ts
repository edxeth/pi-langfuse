import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import registerExtension from "../../src/index.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	assistantOutput,
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	type FakeTelemetryState,
	latestRecord,
	rawRecord,
	registeredSettings,
	settingsListener,
	settingsRegistrations,
	waitForSettingsRegistration,
} from "./compatibility-fixtures.js";

function assertTraceHierarchy(state: FakeTelemetryState) {
	const trace = latestRecord(state.traces, "pi-agent");
	const prompt = latestRecord(state.observations, "agent.prompt");
	const turn = latestRecord(state.observations, "agent.turn");
	const generation = latestRecord(state.observations, "llm-response");
	const tool = latestRecord(state.observations, "tool:bash");

	expect(trace.name).toBe("pi-agent");
	for (const observation of [prompt, turn, generation, tool]) {
		expect(observation.traceId).toBe(trace.id);
	}
	expect(prompt.parentObservationId).toBeUndefined();
	expect(turn.parentObservationId).toBe(prompt.id);
	expect(generation.parentObservationId).toBe(turn.id);
	expect(tool.parentObservationId).toBe(turn.id);
	expect(state.observations.map((item) => item.name)).toEqual([
		"agent.prompt",
		"agent.turn",
		"tool:bash",
		"llm-response",
	]);
}

function withoutVolatileRawFields(record: Record<string, unknown>) {
	const { timestamp, durationMs, estimatedBytes, ...stable } = record;
	return stable;
}

/** Registers the public event path, overlapping-session isolation, shared client ownership, and prompt-ownership replacement scenarios. */
export function registerSessionLifecycleScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("preserves the public event path, trace hierarchy, config bridge, usage, raw records, and redaction", async () => {
		const agentDir = tempRoot("pi-langfuse-compat-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		const sessionFile =
			"/tmp/pi-agent/sessions/--compat-project--/compat-session.jsonl";
		mkdirSync(join(agentDir, "langfuse"), { recursive: true });
		writeFileSync(
			join(agentDir, "langfuse", "pi-langfuse.json"),
			JSON.stringify({
				enabled: true,
				publicKey: "file-public",
				secretKey: "file-secret",
				host: "http://file-host",
				userId: "file-user",
				defaultTags: "file-tag",
				release: "file-release",
				environment: "file-environment",
				redactionEnabled: false,
				rawTraceEnabled: false,
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.LANGFUSE_PUBLIC_KEY = "env-public";
		process.env.LANGFUSE_SECRET_KEY = "env-secret";
		process.env.LANGFUSE_HOST = "http://env-host";
		process.env.LANGFUSE_RELEASE = "env-release";
		process.env.LANGFUSE_ENV = "env-environment";
		process.env.PI_LANGFUSE_UNREDACTED = "1";

		const settingsValues = {
			enabled: true,
			"public-key": "settings-public",
			"secret-key": "settings-secret",
			"base-url": "http://settings-host",
			"user-id": "settings-user",
			"default-tags": "compat-tag, pi",
			release: "settings-release",
			environment: "settings-environment",
			"redaction-enabled": true,
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		};
		const pi = createTestPi(settingsValues);
		const setStatus = vi.fn();
		await registerExtension(pi as unknown as ExtensionAPI);

		const registration = registeredSettings(pi);
		expect(registration.extension).toBe("pi-langfuse");
		expect(registration.nodes["base-url"]?.default).toBe(
			"http://settings-host",
		);
		expect(registration.nodes["public-key"]?.default).toBe("settings-public");
		expect(registration.nodes["redaction-enabled"]?.default).toBe(true);
		expect(registration.nodes["raw-trace-enabled"]?.default).toBe(true);
		expect(registration.nodes["capture-policy"]?.default).toBe("full-debug");
		expect(registration.nodes["payload-max-string-chars"]?.default).toBe(
			"unlimited",
		);
		expect(registration.nodes["capture-prompt"]?.default).toBe("inherit");
		expect(registration.documentation).toContain("settings panel");

		await settingsListener(pi, "pi-extension-settings:ready")();
		expect(
			pi.events.emit.mock.calls.filter(
				(item) => item[0] === "pi-extension-settings:register",
			),
		).toHaveLength(2);
		expect(pi.events.on.mock.calls.map((item) => item[0])).toEqual([
			"pi-extension-settings:ready",
			"pi-extension-settings:pi-langfuse:changed",
			"extension:settings:changed:pi-langfuse",
			"pi-ask:started",
			"pi-ask:completed",
		]);
		settingsValues["base-url"] = "http://settings-host-first-change";
		const firstRegistrationCount = settingsRegistrations(pi).length;
		await settingsListener(pi, "pi-extension-settings:pi-langfuse:changed")();
		const firstChangedRegistration = await waitForSettingsRegistration(
			pi,
			firstRegistrationCount,
		);
		expect(firstChangedRegistration.nodes["base-url"]?.default).toBe(
			"http://settings-host-first-change",
		);

		settingsValues["base-url"] = "http://settings-host-second-change";
		const secondRegistrationCount = settingsRegistrations(pi).length;
		await settingsListener(pi, "extension:settings:changed:pi-langfuse")();
		const secondChangedRegistration = await waitForSettingsRegistration(
			pi,
			secondRegistrationCount,
		);
		expect(secondChangedRegistration.nodes["base-url"]?.default).toBe(
			"http://settings-host-second-change",
		);

		await eventHandler(pi, "session_start")(
			{ reason: "resume", previousSessionFile: "/tmp/previous.jsonl" },
			{
				ui: { setStatus },
				sessionManager: { getSessionFile: () => sessionFile },
			},
		);
		await eventHandler(
			pi,
			"model_select",
		)({
			model: { id: "compat-model", provider: "compat-provider" },
		});
		await eventHandler(pi, "before_agent_start")(
			{
				prompt: "Use settings-secret to patch the project",
				systemPrompt: "System settings-secret",
				systemPromptOptions: { cwd: "/tmp/compat-project" },
			},
			{
				model: { id: "compat-model", provider: "compat-provider" },
				sessionManager: { getSessionFile: () => sessionFile },
			},
		);
		await eventHandler(pi, "agent_start")();
		await eventHandler(pi, "turn_start")({ turnIndex: 0 });
		await eventHandler(
			pi,
			"context",
		)({
			messages: [
				{ role: "system", content: "System settings-secret" },
				{ role: "user", content: "Patch the project" },
			],
		});
		await eventHandler(
			pi,
			"tool_execution_start",
		)({
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "printf settings-secret" },
		});
		await eventHandler(
			pi,
			"tool_call",
		)({
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: "printf settings-secret" },
		});
		await eventHandler(
			pi,
			"tool_execution_update",
		)({
			toolCallId: "tool-1",
			partialResult: { content: [{ type: "text", text: "partial output" }] },
		});
		await eventHandler(
			pi,
			"tool_result",
		)({
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: "printf settings-secret" },
			content: [{ type: "text", text: "tool result" }],
			isError: false,
		});
		await eventHandler(
			pi,
			"before_provider_request",
		)({
			payload: {
				model: "compat-model",
				messages: [
					{ role: "system", content: "System settings-secret" },
					{ role: "user", content: "Patch the project" },
				],
			},
		});
		await eventHandler(
			pi,
			"message_start",
		)({
			message: { role: "assistant" },
		});
		await eventHandler(
			pi,
			"message_update",
		)({
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_delta", delta: "check " },
		});
		await eventHandler(
			pi,
			"message_update",
		)({
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		});
		await eventHandler(
			pi,
			"message_end",
		)({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				model: "compat-model-final",
				usage: {
					input: 3,
					output: 2,
					cacheRead: 1,
					cacheWrite: 1,
					totalTokens: 5,
					cost: { input: 0.03, output: 0.06, total: 0.09 },
				},
			},
		});
		await eventHandler(
			pi,
			"tool_execution_end",
		)({
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "tool result" }] },
			isError: false,
		});
		await eventHandler(
			pi,
			"turn_end",
		)({
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 3, output: 2, totalTokens: 5 },
			},
			toolResults: [],
		});
		await eventHandler(pi, "session_compact")({});
		await eventHandler(
			pi,
			"agent_end",
		)({
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
		});
		await eventHandler(pi, "agent_settled")({});

		// Settling sends the finished prompt without waiting for delivery;
		// session shutdown owns the flush.
		expect(telemetry.state.flushes).toBe(0);
		expect(telemetry.state.shutdowns).toBe(0);
		expect(telemetry.LangfuseClient).toHaveBeenCalledWith(
			expect.objectContaining({
				publicKey: "settings-public",
				secretKey: "settings-secret",
				baseUrl: "http://settings-host-second-change",
			}),
		);
		expect(setStatus).toHaveBeenCalledWith("pi-langfuse:status", "Langfuse 🟢");
		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		expect(trace).toMatchObject({
			name: "pi-agent",
			sessionId: "compat-session",
			userId: "settings-user",
			release: "settings-release",
			environment: "settings-environment",
		});
		expect(trace.input).not.toContain("settings-secret");
		expect(trace.tags).toEqual(
			expect.arrayContaining([
				"pi",
				"pi-langfuse",
				"compat-tag",
				"provider:compat-provider",
				"model:compat-model",
				"session:resume",
			]),
		);
		expect(trace.metadata).toMatchObject({
			redaction: { applied: true },
			cwd: "/tmp/compat-project",
			sessionFile,
			previousSessionFile: "/tmp/previous.jsonl",
		});

		assertTraceHierarchy(telemetry.state);
		const incompatible = {
			traces: telemetry.state.traces.map((record) => ({
				...record,
				name:
					record.name === "pi-agent" ? "pi-agent-incompatible" : record.name,
			})),
			observations: telemetry.state.observations,
			scores: telemetry.state.scores,
			flushes: telemetry.state.flushes,
			shutdowns: telemetry.state.shutdowns,
			received: telemetry.state.received,
		};
		expect(() => assertTraceHierarchy(telemetry.state)).not.toThrow();
		expect(() => assertTraceHierarchy(incompatible)).toThrow(/pi-agent/);
		const prompt = latestRecord(telemetry.state.observations, "agent.prompt");
		const turn = latestRecord(telemetry.state.observations, "agent.turn");
		const generation = latestRecord(
			telemetry.state.observations,
			"llm-response",
		);
		const tool = latestRecord(telemetry.state.observations, "tool:bash");
		expect(prompt.input).not.toContain("settings-secret");
		expect(prompt.end).toMatchObject({
			output: "done",
			metadata: expect.objectContaining({
				completed: true,
				turns: 1,
				toolCalls: 1,
			}),
		});
		expect(turn.end).toMatchObject({
			input: [],
			output: assistantOutput("done"),
			usage: { input: 3, output: 2, total: 5 },
			usageDetails: { input: 3, output: 2, total: 5 },
		});
		expect(generation.end).toMatchObject({
			output: assistantOutput("done"),
			model: "compat-model-final",
			usage: { input: 3, output: 2, total: 5 },
			usageDetails: {
				input: 3,
				output: 2,
				input_cached_read: 1,
				input_cached_write: 1,
				total: 5,
			},
			costDetails: { input: 0.03, output: 0.06, total: 0.09 },
		});
		expect(tool.end).toMatchObject({
			isError: false,
			output: "tool result",
			metadata: expect.objectContaining({ tool: "bash" }),
		});
		// Tokens and cost travel on the generation (checked above), not as
		// duplicate scores.
		expect(
			telemetry.state.scores.filter((score) =>
				["input_tokens", "output_tokens", "total_cost"].includes(
					String(score.name),
				),
			),
		).toEqual([]);

		await eventHandler(pi, "session_shutdown")();
		expect(telemetry.state.shutdowns).toBe(1);
		const rawPath = join(
			rawTraceDir,
			"--compat-project--",
			"compat-session.jsonl",
		);
		expect(existsSync(rawPath)).toBe(true);
		const records = readFileSync(rawPath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.type)).toEqual([
			"session_start",
			"agent_prompt_start",
			"tool_execution_start",
			"tool_call",
			"tool_result_first_seen",
			"provider_request",
			"assistant_output",
			"tool_execution_end",
			"session_compact",
			"session_end",
		]);
		for (const record of records) {
			expect(withoutVolatileRawFields(record)).toMatchObject({
				sessionId: "compat-session",
				sessionFile,
				runtime: "pi",
				redaction: { applied: true },
			});
		}
		expect(
			withoutVolatileRawFields(rawRecord(records, "session_start")),
		).toMatchObject({
			type: "session_start",
			reason: "resume",
			previousSessionFile: "/tmp/previous.jsonl",
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "agent_prompt_start")),
		).toMatchObject({
			type: "agent_prompt_start",
			cwd: "/tmp/compat-project",
			sessionReason: "resume",
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "tool_execution_start")),
		).toMatchObject({
			type: "tool_execution_start",
			traceId: trace.id,
			turnIndex: 0,
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: expect.stringContaining("printf") },
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "tool_call")),
		).toMatchObject({
			type: "tool_call",
			traceId: trace.id,
			turnIndex: 0,
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: expect.stringContaining("printf") },
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "tool_result_first_seen")),
		).toMatchObject({
			type: "tool_result_first_seen",
			traceId: trace.id,
			turnIndex: 0,
			toolCallId: "tool-1",
			toolName: "bash",
			contentSummary: "tool result",
			contentTruncated: false,
			isError: false,
		});
		const providerRequest = rawRecord(records, "provider_request");
		expect(providerRequest).toMatchObject({
			type: "provider_request",
			traceId: trace.id,
			turnIndex: 0,
			model: "compat-model",
			captureMode: "summary",
			messageCount: 2,
			fullMessagesOmitted: true,
		});
		expect(providerRequest).not.toHaveProperty("messages");
		expect(providerRequest.messagesSummary).toEqual([
			expect.objectContaining({
				role: "system",
				content: expect.not.stringContaining("settings-secret"),
			}),
			{ role: "user", content: "Patch the project" },
		]);
		const promptRecord = rawRecord(records, "agent_prompt_start");
		expect(promptRecord.prompt).not.toContain("settings-secret");
		expect(promptRecord.redaction).toEqual({ applied: true });
		expect(
			withoutVolatileRawFields(rawRecord(records, "assistant_output")),
		).toMatchObject({
			type: "assistant_output",
			traceId: trace.id,
			turnIndex: 0,
			text: "done",
			messageModel: "compat-model-final",
			usage: { input: 3, output: 2 },
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "tool_execution_end")),
		).toMatchObject({
			type: "tool_execution_end",
			traceId: trace.id,
			turnIndex: 0,
			toolCallId: "tool-1",
			toolName: "bash",
			argsSummary: expect.stringContaining("printf"),
			resultSummary: "tool result",
			resultTruncated: false,
			isError: false,
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "session_compact")),
		).toMatchObject({
			type: "session_compact",
			traceId: trace.id,
			compactCount: 1,
		});
		expect(
			withoutVolatileRawFields(rawRecord(records, "session_end")),
		).toMatchObject({
			type: "session_end",
			reason: "shutdown",
		});
	});

	it("keeps overlapping session state isolated through registered handlers", async () => {
		const agentDir = tempRoot("pi-langfuse-session-isolation-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		const sessionIdA = "2026-07-20T18-00-00-000Z_session-a";
		const sessionIdB = "2026-07-20T18-00-01-000Z_session-b";
		const sessionFileA = `/tmp/pi-agent/sessions/--session-a--/${sessionIdA}.jsonl`;
		const sessionFileB = `/tmp/pi-agent/sessions/--session-b--/${sessionIdB}.jsonl`;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "isolation-public",
			"secret-key": "isolation-secret",
			"base-url": "http://isolation-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const contextA = {
			model: { id: "model-a", provider: "provider-a" },
			sessionManager: {
				getSessionFile: () => sessionFileA,
				getSessionId: () => "session-a",
			},
		};
		const contextB = {
			model: { id: "model-b", provider: "provider-b" },
			sessionManager: {
				getSessionFile: () => sessionFileB,
				getSessionId: () => "session-b",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, contextA);
		await handler("session_start")({ reason: "startup" }, contextB);
		await handler("model_select")(
			{ model: { id: "model-a", provider: "provider-a" } },
			contextA,
		);
		await handler("model_select")(
			{ model: { id: "model-b", provider: "provider-b" } },
			contextB,
		);

		await Promise.all([
			handler("before_agent_start")(
				{
					prompt: "prompt-a",
					systemPrompt: "system-a",
					systemPromptOptions: { cwd: "/tmp/project-a" },
				},
				contextA,
			),
			handler("before_agent_start")(
				{
					prompt: "prompt-b",
					systemPrompt: "system-b",
					systemPromptOptions: { cwd: "/tmp/project-b" },
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("agent_start")({}, contextA),
			handler("agent_start")({}, contextB),
		]);
		await Promise.all([
			handler("turn_start")({ turnIndex: 0 }, contextA),
			handler("turn_start")({ turnIndex: 0 }, contextB),
		]);
		await Promise.all([
			handler("context")(
				{ messages: [{ role: "user", content: "context-a" }] },
				contextA,
			),
			handler("context")(
				{ messages: [{ role: "user", content: "context-b" }] },
				contextB,
			),
		]);
		await Promise.all([
			handler("tool_execution_start")(
				{
					toolCallId: "tool-a",
					toolName: "bash",
					args: { command: "echo a" },
				},
				contextA,
			),
			handler("tool_execution_start")(
				{
					toolCallId: "tool-b",
					toolName: "bash",
					args: { command: "echo b" },
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("tool_call")(
				{
					toolCallId: "tool-a",
					toolName: "bash",
					input: { command: "echo a" },
				},
				contextA,
			),
			handler("tool_call")(
				{
					toolCallId: "tool-b",
					toolName: "bash",
					input: { command: "echo b" },
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("before_provider_request")(
				{
					payload: {
						model: "model-a",
						messages: [{ role: "user", content: "context-a" }],
					},
				},
				contextA,
			),
			handler("before_provider_request")(
				{
					payload: {
						model: "model-b",
						messages: [{ role: "user", content: "context-b" }],
					},
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("message_start")({ message: { role: "assistant" } }, contextA),
			handler("message_start")({ message: { role: "assistant" } }, contextB),
		]);
		await Promise.all([
			handler("message_update")(
				{
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", delta: "answer-a" },
				},
				contextA,
			),
			handler("message_update")(
				{
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", delta: "answer-b" },
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("tool_result")(
				{
					toolCallId: "tool-a",
					toolName: "bash",
					input: { command: "echo a" },
					content: [{ type: "text", text: "result-a" }],
					isError: false,
				},
				contextA,
			),
			handler("tool_result")(
				{
					toolCallId: "tool-b",
					toolName: "bash",
					input: { command: "echo b" },
					content: [{ type: "text", text: "result-b" }],
					isError: true,
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("message_end")(
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer-a" }],
						model: "model-a-final",
						usage: { input: 2, output: 3, totalTokens: 5 },
					},
				},
				contextA,
			),
			handler("message_end")(
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer-b" }],
						model: "model-b-final",
						usage: { input: 5, output: 7, totalTokens: 12 },
					},
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("tool_execution_end")(
				{
					toolCallId: "tool-a",
					toolName: "bash",
					result: { content: [{ type: "text", text: "result-a" }] },
					isError: false,
				},
				contextA,
			),
			handler("tool_execution_end")(
				{
					toolCallId: "tool-b",
					toolName: "bash",
					result: { content: [{ type: "text", text: "result-b" }] },
					isError: true,
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("turn_end")(
				{
					turnIndex: 0,
					message: { role: "assistant", content: [] },
					toolResults: [],
				},
				contextA,
			),
			handler("turn_end")(
				{
					turnIndex: 0,
					message: { role: "assistant", content: [] },
					toolResults: [],
				},
				contextB,
			),
		]);
		await handler("session_compact")({}, contextA);
		await handler("session_compact")({}, contextA);
		await handler("session_compact")({}, contextB);
		await Promise.all([
			handler("agent_end")(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "answer-a" }],
						},
					],
				},
				contextA,
			),
			handler("agent_end")(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "answer-b" }],
						},
					],
				},
				contextB,
			),
		]);
		await Promise.all([
			handler("agent_settled")({}, contextA),
			handler("agent_settled")({}, contextB),
		]);
		await Promise.all([
			handler("session_shutdown")({}, contextA),
			handler("session_shutdown")({}, contextB),
		]);
		drainRawTraceQueue();

		const traceA = telemetry.state.traces.find(
			(record) => record.sessionId === sessionIdA,
		);
		const traceB = telemetry.state.traces.find(
			(record) => record.sessionId === sessionIdB,
		);
		expect(traceA).toBeDefined();
		expect(traceB).toBeDefined();
		if (!traceA || !traceB) throw new Error("isolated traces were not created");

		for (const [
			trace,
			traceSessionId,
			model,
			provider,
			cwd,
			output,
			compactCount,
			toolError,
		] of [
			[
				traceA,
				sessionIdA,
				"model-a",
				"provider-a",
				"/tmp/project-a",
				"answer-a",
				2,
				0,
			],
			[
				traceB,
				sessionIdB,
				"model-b",
				"provider-b",
				"/tmp/project-b",
				"answer-b",
				1,
				1,
			],
		] as const) {
			const observations = telemetry.state.observations.filter(
				(record) => record.traceId === trace.id,
			);
			const prompt = latestRecord(observations, "agent.prompt");
			const turn = latestRecord(observations, "agent.turn");
			const generation = latestRecord(observations, "llm-response");
			const tool = latestRecord(observations, "tool:bash");
			expect(observations.map((record) => record.name)).toEqual([
				"agent.prompt",
				"agent.turn",
				"tool:bash",
				"llm-response",
			]);
			expect(turn.parentObservationId).toBe(prompt.id);
			expect(generation.parentObservationId).toBe(turn.id);
			expect(tool.parentObservationId).toBe(turn.id);
			for (const observation of observations) {
				expect(observation.traceId).toBe(trace.id);
				expect(observation.end).toBeDefined();
			}
			expect(trace.lastUpdate).toMatchObject({
				output,
				sessionId: traceSessionId,
				metadata: {
					model,
					provider,
					cwd,
					turns: 1,
					toolCalls: 1,
					toolErrors: toolError,
					compactCount,
				},
			});
			expect(prompt.metadata).toMatchObject({ cwd, model, provider });
			expect(prompt.end).toMatchObject({
				output,
				metadata: {
					turns: 1,
					toolCalls: 1,
					toolErrors: toolError,
					compactCount,
				},
			});
			expect(generation.end).toMatchObject({
				output: assistantOutput(output),
			});
			expect(tool.end).toMatchObject({ isError: toolError === 1 });
		}

		const rawA = readFileSync(
			join(rawTraceDir, "--session-a--", `${sessionIdA}.jsonl`),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const rawB = readFileSync(
			join(rawTraceDir, "--session-b--", `${sessionIdB}.jsonl`),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		for (const [records, sessionId, prompt, output] of [
			[rawA, sessionIdA, "prompt-a", "answer-a"],
			[rawB, sessionIdB, "prompt-b", "answer-b"],
		] as const) {
			expect(records.length).toBeGreaterThan(0);
			expect(records.every((record) => record.sessionId === sessionId)).toBe(
				true,
			);
			expect(rawRecord(records, "agent_prompt_start").prompt).toBe(prompt);
			expect(rawRecord(records, "assistant_output").text).toBe(output);
			expect(rawRecord(records, "provider_request").model).toBe(
				sessionId === sessionIdA ? "model-a" : "model-b",
			);
		}
		expect(
			rawA
				.filter((record) => record.type === "session_compact")
				.map((record) => record.compactCount),
		).toEqual([1, 2]);
		expect(
			rawB
				.filter((record) => record.type === "session_compact")
				.map((record) => record.compactCount),
		).toEqual([1]);
		expect(telemetry.state.shutdowns).toBe(1);

		const observationCount = telemetry.state.observations.length;
		await handler("tool_execution_end")(
			{
				toolCallId: "tool-a",
				toolName: "bash",
				result: { content: [{ type: "text", text: "late" }] },
				isError: false,
			},
			contextA,
		);
		expect(telemetry.state.observations).toHaveLength(observationCount);
	});

	it("keeps the shared client alive across independent extension runtimes", async () => {
		const agentDir = tempRoot("pi-langfuse-client-ownership-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const settings = {
			enabled: true,
			"public-key": "ownership-public",
			"secret-key": "ownership-secret",
			"base-url": "http://ownership-host",
		};
		const piA = createTestPi(settings);
		const piB = createTestPi(settings);
		await registerExtension(piA as unknown as ExtensionAPI);
		const contextA = {
			model: { id: "model-a", provider: "provider-a" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--ownership-a--/2026-07-20T18-10-00-000Z_a.jsonl",
				getSessionId: () => "a",
			},
		};
		await eventHandler(piA, "session_start")({ reason: "startup" }, contextA);
		await eventHandler(piA, "before_agent_start")(
			{
				prompt: "prompt-a",
				systemPrompt: "system-a",
				systemPromptOptions: { cwd: "/tmp/ownership-a" },
			},
			contextA,
		);
		await eventHandler(piA, "agent_start")({}, contextA);

		await registerExtension(piB as unknown as ExtensionAPI);
		expect(telemetry.state.shutdowns).toBe(0);
		const contextB = {
			model: { id: "model-b", provider: "provider-b" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--ownership-b--/2026-07-20T18-10-01-000Z_b.jsonl",
				getSessionId: () => "b",
			},
		};
		await eventHandler(piB, "session_start")({ reason: "startup" }, contextB);
		await eventHandler(piA, "session_shutdown")({}, contextA);
		expect(telemetry.state.shutdowns).toBe(0);
		await eventHandler(piB, "before_agent_start")(
			{
				prompt: "prompt-b-next",
				systemPrompt: "system-b-next",
				systemPromptOptions: { cwd: "/tmp/ownership-b" },
			},
			contextB,
		);
		await eventHandler(piB, "agent_start")({}, contextB);
		expect(telemetry.state.traces).toHaveLength(2);
		await eventHandler(piB, "session_shutdown")({}, contextB);
		expect(telemetry.state.shutdowns).toBe(1);
	});

	it("does not create a child observation after its prompt ownership is replaced", async () => {
		const agentDir = tempRoot("pi-langfuse-observation-ownership-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "observation-public",
			"secret-key": "observation-secret",
			"base-url": "http://observation-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const context = {
			model: { id: "model", provider: "provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--observation--/2026-07-20T18-20-00-000Z_session.jsonl",
				getSessionId: () => "session",
			},
		};
		await eventHandler(pi, "session_start")({ reason: "startup" }, context);
		await eventHandler(pi, "before_agent_start")(
			{
				prompt: "first",
				systemPrompt: "system-first",
				systemPromptOptions: { cwd: "/tmp/observation" },
			},
			context,
		);

		const pendingAgentStart = eventHandler(pi, "agent_start")({}, context);
		const replacement = eventHandler(pi, "before_agent_start")(
			{
				prompt: "second",
				systemPrompt: "system-second",
				systemPromptOptions: { cwd: "/tmp/observation" },
			},
			context,
		);
		await Promise.all([pendingAgentStart, replacement]);
		expect(telemetry.state.observations.map((record) => record.name)).toEqual([
			"agent.prompt",
			"agent.prompt",
		]);
		expect(telemetry.state.observations[0]?.endCalls).toBe(1);
		expect(telemetry.state.observations[1]?.endCalls).toBeUndefined();
		await eventHandler(pi, "session_shutdown")({}, context);
	});

	it("ignores a compaction event for an unknown session or a prompt that is finalizing", async () => {
		const agentDir = tempRoot("pi-langfuse-late-compaction-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "late-compaction-public",
			"secret-key": "late-compaction-secret",
			"base-url": "http://late-compaction-host",
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const handler = (name: string) => eventHandler(pi, name);
		const sessionFile =
			"/tmp/pi-agent/sessions/--late-compaction--/late-compaction.jsonl";
		const context = {
			model: { id: "late-model", provider: "late-provider" },
			sessionManager: { getSessionFile: () => sessionFile },
		};
		const unknown = {
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--unknown--/unknown.jsonl",
			},
		};
		const compactionEntry = {
			id: "late-compaction-1",
			usage: { input: 500, output: 50, totalTokens: 550 },
		};
		await handler("session_start")({ reason: "startup" }, context);
		await handler("before_agent_start")(
			{
				prompt: "late compaction prompt",
				systemPrompt: "late system",
				systemPromptOptions: { cwd: "/tmp/late" },
			},
			context,
		);
		await handler("agent_start")({}, context);

		await handler("session_compact")({ compactionEntry }, unknown);
		// Shutdown starts finalizing the prompt before its first await.
		const shuttingDown = handler("session_shutdown")({}, context);
		await handler("session_compact")({ compactionEntry }, context);
		await shuttingDown;
		drainRawTraceQueue();

		const records = readFileSync(
			join(rawTraceDir, "--late-compaction--", "late-compaction.jsonl"),
			"utf-8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.type)).not.toContain(
			"session_compact",
		);
		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		expect(trace.lastUpdate).not.toMatchObject({
			metadata: { indirectTokensIn: 500 },
		});
		expect(existsSync(join(rawTraceDir, "--unknown--"))).toBe(false);
	});

	async function openPrompt(label: string, extraSettings = {}) {
		const agentDir = tempRoot(`pi-langfuse-${label}-agent-`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": `${label}-public`,
			"secret-key": `${label}-secret`,
			"base-url": `http://${label}-host`,
			...extraSettings,
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const context = {
			model: { id: `${label}-model`, provider: `${label}-provider` },
			sessionManager: {
				getSessionFile: () =>
					`/tmp/pi-agent/sessions/--${label}--/${label}-session.jsonl`,
				getSessionId: () => `${label}-session`,
			},
		};
		await eventHandler(pi, "session_start")({ reason: "startup" }, context);
		await eventHandler(pi, "before_agent_start")(
			{
				prompt: `${label} prompt`,
				systemPrompt: `${label} system`,
				systemPromptOptions: { cwd: `/tmp/${label}` },
			},
			context,
		);
		await eventHandler(pi, "agent_start")({}, context);
		return { pi, context };
	}

	it("finalizes an open prompt without flushing when a session starts over it", async () => {
		const { pi, context } = await openPrompt("replacement");
		const prompt = latestRecord(telemetry.state.observations, "agent.prompt");

		await eventHandler(pi, "session_start")({ reason: "new" }, context);

		expect(prompt.endCalls).toBe(1);
		expect(prompt.end).toMatchObject({
			metadata: { abandonmentReason: "session replacement" },
		});
		expect(telemetry.state.flushes).toBe(0);
		await eventHandler(pi, "session_shutdown")({}, context);
	});

	it("flushes the client when a session shuts down over an open prompt", async () => {
		const { pi, context } = await openPrompt("shutdown-flush");

		await eventHandler(pi, "session_shutdown")({}, context);

		expect(telemetry.state.flushes).toBeGreaterThanOrEqual(1);
		expect(telemetry.state.shutdowns).toBe(1);
	});

	it("exports an open prompt when its session shuts down beside a live one", async () => {
		const { pi, context } = await openPrompt("shutdown-beside");
		const other = {
			model: { id: "other-model", provider: "other-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--shutdown-other--/other-session.jsonl",
				getSessionId: () => "other-session",
			},
		};
		await eventHandler(pi, "session_start")({ reason: "startup" }, other);
		telemetry.state.flushes = 0;

		await eventHandler(pi, "session_shutdown")({}, context);

		// The other session keeps the shared client open, so only this
		// shutdown's own flush can export the prompt it finalized.
		expect(telemetry.state.shutdowns).toBe(0);
		expect(telemetry.state.flushes).toBeGreaterThanOrEqual(1);
		await eventHandler(pi, "session_shutdown")({}, other);
	});

	it("keeps the shared client when an unknown context shuts down beside a live session", async () => {
		const { pi, context } = await openPrompt("unknown-shutdown");

		await eventHandler(pi, "session_shutdown")(
			{},
			{
				sessionManager: {
					getSessionFile: () => "/tmp/pi-agent/sessions/--other--/other.jsonl",
				},
			},
		);

		expect(telemetry.state.shutdowns).toBe(0);
		await eventHandler(pi, "session_shutdown")({}, context);
		expect(telemetry.state.shutdowns).toBe(1);
	});

	it("remembers a model selected before the session started", async () => {
		const agentDir = tempRoot("pi-langfuse-early-model-agent-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "early-model-public",
			"secret-key": "early-model-secret",
			"base-url": "http://early-model-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const context = {
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--early-model--/early-model.jsonl",
			},
		};

		await eventHandler(pi, "model_select")(
			{ model: { id: "early-model", provider: "early-provider" } },
			context,
		);
		await eventHandler(pi, "before_agent_start")(
			{
				prompt: "early model prompt",
				systemPrompt: "system",
				systemPromptOptions: { cwd: "/tmp/early-model" },
			},
			context,
		);

		const trace = latestRecord(telemetry.state.traces, "pi-agent");
		expect(trace.metadata).toMatchObject({
			model: "early-model",
			provider: "early-provider",
		});
		await eventHandler(pi, "session_shutdown")({}, context);
	});
}
