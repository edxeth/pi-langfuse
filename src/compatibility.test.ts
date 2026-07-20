import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "./index.js";
import { drainRawTraceQueue } from "./raw-trace.js";

interface FakeRecord {
	kind: "trace" | "observation";
	id: string;
	name?: string;
	traceId?: string;
	parentObservationId?: string;
	[key: string]: unknown;
}

interface FakeTelemetryState {
	traces: FakeRecord[];
	observations: FakeRecord[];
	scores: Array<Record<string, unknown>>;
	flushes: number;
	shutdowns: number;
}

const telemetry = vi.hoisted(() => {
	const state: FakeTelemetryState = {
		traces: [],
		observations: [],
		scores: [],
		flushes: 0,
		shutdowns: 0,
	};
	let nextId = 0;

	function createRecord(
		kind: FakeRecord["kind"],
		body: Record<string, unknown> | undefined,
	): FakeRecord {
		return {
			kind,
			id: `${kind}-${++nextId}`,
			...(body ?? {}),
		};
	}

	const client = {
		trace: vi.fn((body: Record<string, unknown>) => {
			const record = createRecord("trace", body);
			state.traces.push(record);
			return {
				id: record.id,
				update: vi.fn((update: Record<string, unknown>) => {
					record.lastUpdate = update;
				}),
			};
		}),
		span: vi.fn((body: Record<string, unknown>) => {
			const record = createRecord("observation", body);
			state.observations.push(record);
			return {
				id: record.id,
				update: vi.fn((update: Record<string, unknown>) => {
					record.lastUpdate = update;
				}),
				end: vi.fn((end: Record<string, unknown>) => {
					record.end = end;
					record.endCalls = Number(record.endCalls ?? 0) + 1;
				}),
			};
		}),
		generation: vi.fn((body: Record<string, unknown>) => {
			const record = createRecord("observation", body);
			state.observations.push(record);
			return {
				id: record.id,
				update: vi.fn((update: Record<string, unknown>) => {
					record.lastUpdate = update;
				}),
				end: vi.fn((end: Record<string, unknown>) => {
					record.end = end;
					record.endCalls = Number(record.endCalls ?? 0) + 1;
				}),
			};
		}),
		score: vi.fn((body: Record<string, unknown>) => {
			state.scores.push(body);
		}),
		flushAsync: vi.fn(async () => {
			state.flushes += 1;
		}),
		shutdownAsync: vi.fn(async () => {
			state.shutdowns += 1;
		}),
	};

	return {
		client,
		state,
		Langfuse: vi.fn(() => client),
		reset() {
			state.traces.length = 0;
			state.observations.length = 0;
			state.scores.length = 0;
			state.flushes = 0;
			state.shutdowns = 0;
			nextId = 0;
			telemetry.Langfuse.mockClear();
			client.trace.mockClear();
			client.span.mockClear();
			client.generation.mockClear();
			client.score.mockClear();
			client.flushAsync.mockClear();
			client.shutdownAsync.mockClear();
		},
	};
});

vi.mock("langfuse", () => ({ Langfuse: telemetry.Langfuse }));

type EventHandler = (event?: unknown, ctx?: unknown) => Promise<void> | void;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;
type TestPi = ReturnType<typeof createTestPi>;

type Registration = {
	extension: string;
	nodes: Record<string, { default: unknown }>;
	documentation: string;
};

function createTestPi(settingsValues?: Record<string, unknown>) {
	const pi = {
		events: {
			on: vi.fn(),
			emit: vi.fn((event: string, probe: { values?: unknown }) => {
				if (event === "extension:settings:get" && settingsValues) {
					probe.values = settingsValues;
				}
			}),
		},
		on: vi.fn(),
		registerCommand: vi.fn(),
		model: { id: "fallback-model", provider: "fallback-provider" },
	};
	return pi;
}

function eventHandler(pi: TestPi, name: string): EventHandler {
	const call = pi.on.mock.calls.find((item) => item[0] === name);
	if (!call) throw new Error(`event handler not registered: ${name}`);
	return call[1] as EventHandler;
}

function commandHandler(pi: TestPi, name: string): CommandHandler {
	const call = pi.registerCommand.mock.calls.find((item) => item[0] === name);
	if (!call) throw new Error(`command not registered: ${name}`);
	return (call[1] as { handler: CommandHandler }).handler;
}

function settingsListener(pi: TestPi, name: string): EventHandler {
	const call = pi.events.on.mock.calls.find((item) => item[0] === name);
	if (!call) throw new Error(`settings listener not registered: ${name}`);
	return call[1] as EventHandler;
}

function latestRecord(records: FakeRecord[], name: string) {
	const record = records.find((item) => item.name === name);
	if (!record) throw new Error(`record not found: ${name}`);
	return record;
}

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

function settingsRegistrations(pi: TestPi): Registration[] {
	return pi.events.emit.mock.calls
		.filter((item) => item[0] === "pi-extension-settings:register")
		.map((item) => item[1] as Registration);
}

function registeredSettings(pi: TestPi): Registration {
	const registration = settingsRegistrations(pi)[0];
	if (!registration) throw new Error("settings registration was not emitted");
	return registration;
}

async function waitForSettingsRegistration(
	pi: TestPi,
	previousCount: number,
): Promise<Registration> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const registrations = settingsRegistrations(pi);
		if (registrations.length > previousCount) {
			const registration = registrations.at(-1);
			if (registration) return registration;
		}
		await Promise.resolve();
	}
	throw new Error("settings refresh did not re-register settings");
}

function withoutVolatileRawFields(record: Record<string, unknown>) {
	const { timestamp, durationMs, estimatedBytes, ...stable } = record;
	return stable;
}

function rawRecord(records: Array<Record<string, unknown>>, type: string) {
	const record = records.find((item) => item.type === type);
	if (!record) throw new Error(`raw record not found: ${type}`);
	return record;
}

const createdRoots: string[] = [];

function tempRoot(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	createdRoots.push(root);
	return root;
}

beforeEach(() => {
	drainRawTraceQueue();
	telemetry.reset();
	delete process.env.LANGFUSE_PUBLIC_KEY;
	delete process.env.LANGFUSE_SECRET_KEY;
	delete process.env.LANGFUSE_BASE_URL;
	delete process.env.LANGFUSE_HOST;
	delete process.env.LANGFUSE_RELEASE;
	delete process.env.LANGFUSE_ENV;
	delete process.env.PI_LANGFUSE_REDACTION;
	delete process.env.PI_LANGFUSE_UNREDACTED;
	delete process.env.PI_LANGFUSE_RAW_TRACE;
	delete process.env.PI_LANGFUSE_RAW_TRACE_DIR;
	delete process.env.PI_LANGFUSE_SKIP_UNPERSISTED;
	delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	drainRawTraceQueue();
	for (const root of createdRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("executable compatibility contract", () => {
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

		expect(telemetry.state.flushes).toBe(1);
		expect(telemetry.state.shutdowns).toBe(0);
		expect(telemetry.Langfuse).toHaveBeenCalledWith(
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
			usage: { input: 3, output: 2, total: 5 },
			usageDetails: { input: 3, output: 2, total: 5 },
		});
		expect(generation.end).toMatchObject({
			output: "done",
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
		expect(telemetry.state.scores).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "input_tokens", value: 3 }),
				expect.objectContaining({ name: "output_tokens", value: 2 }),
				expect.objectContaining({ name: "total_cost", value: 0.09 }),
			]),
		);

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
			expect(generation.end).toMatchObject({ output });
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
		expect(telemetry.state.traces).toHaveLength(2);
		await eventHandler(piB, "session_shutdown")({}, contextB);
		expect(telemetry.state.shutdowns).toBe(1);
	});

	it("does not create an observation after its prompt ownership is replaced", async () => {
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
		expect(telemetry.state.observations).toHaveLength(0);
		await eventHandler(pi, "session_shutdown")({}, context);
	});

	it("captures configuration source precedence through the registered settings bridge", async () => {
		const cases: Array<{
			name: string;
			settings: Record<string, unknown>;
			fileHost?: string;
			envHost?: string;
			expectedHost: string;
		}> = [
			{
				name: "settings override file and environment",
				settings: { enabled: false, "base-url": "http://settings-host" },
				fileHost: "http://file-host",
				envHost: "http://env-host",
				expectedHost: "http://settings-host",
			},
			{
				name: "file overrides environment",
				settings: { enabled: false },
				fileHost: "http://file-host",
				envHost: "http://env-host",
				expectedHost: "http://file-host",
			},
			{
				name: "environment overrides defaults",
				settings: { enabled: false },
				envHost: "http://env-host",
				expectedHost: "http://env-host",
			},
			{
				name: "defaults fill missing sources",
				settings: { enabled: false },
				expectedHost: "https://cloud.langfuse.com",
			},
		];

		for (const testCase of cases) {
			const root = tempRoot(
				`pi-langfuse-config-${testCase.name.replaceAll(" ", "-")}-`,
			);
			process.env.PI_CODING_AGENT_DIR = root;
			delete process.env.LANGFUSE_HOST;
			if (testCase.envHost) process.env.LANGFUSE_HOST = testCase.envHost;
			if (testCase.fileHost) {
				mkdirSync(join(root, "langfuse"), { recursive: true });
				writeFileSync(
					join(root, "langfuse", "pi-langfuse.json"),
					JSON.stringify({ host: testCase.fileHost }),
				);
			}

			const pi = createTestPi(testCase.settings);
			await registerExtension(pi as unknown as ExtensionAPI);
			expect(registeredSettings(pi).nodes["base-url"]?.default).toBe(
				testCase.expectedHost,
			);
		}
	});

	it("runs the registered commands without changing their public behavior", async () => {
		const root = tempRoot("pi-langfuse-command-compat-");
		process.env.PI_CODING_AGENT_DIR = root;
		const notifications: Array<{ message: string; type?: string }> = [];
		const pi = createTestPi();
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await registerExtension(pi as unknown as ExtensionAPI);
			expect(pi.registerCommand.mock.calls.map((item) => item[0])).toEqual([
				"langfuse-init",
				"langfuse:export",
				"langfuse:toggle",
			]);

			const toggleContext = {
				ui: {
					notify: (message: string, type?: string) =>
						notifications.push({ message, type }),
				},
			};
			await commandHandler(pi, "langfuse:toggle")("off", toggleContext);
			const storedSettings = JSON.parse(
				readFileSync(join(root, "settings.json"), "utf-8"),
			) as {
				"extensions:settings": { "pi-langfuse": { enabled: boolean } };
			};
			expect(storedSettings["extensions:settings"]["pi-langfuse"].enabled).toBe(
				false,
			);
			expect(notifications.at(-1)?.message).toContain("tracing disabled");

			const initDir = join(root, "initialized");
			await commandHandler(pi, "langfuse-init")(
				`--yes --no-start --dir ${initDir}`,
				{
					hasUI: false,
					ui: {
						notify: (message: string, type?: string) =>
							notifications.push({ message, type }),
					},
				},
			);
			expect(
				readFileSync(join(initDir, "docker-compose.yml"), "utf-8"),
			).toContain("docker.io/langfuse/langfuse:3");
			expect(
				readFileSync(join(initDir, "docker-compose.yml"), "utf-8"),
			).toContain("docker.io/langfuse/langfuse-worker:3");
			expect(
				readFileSync(join(initDir, "pi-langfuse.json"), "utf-8"),
			).toContain('"localAutostart": true');
			expect(
				notifications.some((item) => item.message.includes("initialized")),
			).toBe(true);

			const sessionsDir = join(root, "sessions");
			const exportDir = join(root, "export");
			mkdirSync(join(sessionsDir, "--project--"), { recursive: true });
			writeFileSync(
				join(sessionsDir, "--project--", "session.jsonl"),
				'{"type":"message","content":"sk-lf-export-secret-1234567890"}\n',
			);
			await commandHandler(pi, "langfuse:export")(
				`--sessions-only --sessions-dir ${sessionsDir} --out ${exportDir} --no-trufflehog`,
				{
					ui: {
						notify: (message: string, type?: string) =>
							notifications.push({ message, type }),
					},
				},
			);
			const exported = readFileSync(
				join(exportDir, "sessions", "--project--", "session.jsonl"),
				"utf-8",
			);
			expect(exported).not.toContain("sk-lf-export-secret-1234567890");
			expect(exported).toContain("[REDACTED:");
			expect(
				notifications.some((item) => item.message.includes("Redacted export:")),
			).toBe(true);
		} finally {
			consoleLog.mockRestore();
		}

		await eventHandler(pi, "session_shutdown")();
	});

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
		expect(generation0.input).toEqual([
			{ role: "system", content: "generation system" },
			{ role: "user", content: "turn zero" },
		]);
		expect(generation0.end).toMatchObject({
			output: "answer-0",
			model: "generation-model-final-0",
			usage: { input: 4, output: 5, total: 9 },
			costDetails: { input: 0.04, output: 0.05, total: 0.09 },
			metadata: { thinking: "think " },
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
			output: "answer-4",
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
		expect(
			latestRecord(telemetry.state.observations, "tool:bash").lastUpdate,
		).toMatchObject({
			output: "partial a",
			metadata: { partial: true, tool: "bash" },
		});
		expect(
			latestRecord(telemetry.state.observations, "tool:bash").end,
		).toMatchObject({
			isError: false,
			output: "result a",
		});
		expect(
			latestRecord(telemetry.state.observations, "tool:read").end,
		).toMatchObject({
			isError: true,
			output: "read failed",
		});
		expect(
			latestRecord(telemetry.state.observations, "tool:edit").end,
		).toMatchObject({
			isError: true,
			statusMessage: "tool ended without completion event",
			metadata: { abandoned: true },
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
			output: "complete",
			usage: { input: 1, output: 2, total: 3 },
		});
		expect(latestRecord(observationsC, "agent.prompt").end).toMatchObject({
			metadata: { completed: true, turns: 1 },
		});
		await handler("session_shutdown")({ reason: "quit" }, contextC);
	});

	it("keeps the compiled package entrypoint loadable", async () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
		) as { main?: string };
		expect(packageJson.main).toBe("dist/index.js");

		const fixtureRoot = tempRoot("pi-langfuse-entrypoint-");
		const fixtureDist = join(fixtureRoot, "dist");
		mkdirSync(fixtureDist, { recursive: true });
		writeFileSync(
			join(fixtureRoot, "package.json"),
			JSON.stringify({ type: "module" }),
		);
		symlinkSync(
			resolve("node_modules"),
			join(fixtureRoot, "node_modules"),
			"dir",
		);
		execFileSync(
			process.execPath,
			[
				resolve("node_modules/typescript/bin/tsc"),
				"--project",
				resolve("tsconfig.json"),
				"--outDir",
				fixtureDist,
			],
			{ cwd: process.cwd() },
		);

		const compiled = await import(
			pathToFileURL(join(fixtureDist, "index.js")).href
		);
		expect(compiled.default).toBeTypeOf("function");
	});
});
