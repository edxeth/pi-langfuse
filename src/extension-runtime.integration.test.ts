import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LangfuseRecorder,
	startLangfuseRecorder,
} from "../test/pi-runtime/recorder.js";
import registerExtension from "./index.js";
import { flushClient, shutdownClient } from "./langfuse-client.js";
import { drainRawTraceQueue } from "./raw-trace.js";

type EventHandler = (event?: unknown, ctx?: unknown) => Promise<void> | void;

type TestPi = {
	events: {
		on: ReturnType<typeof vi.fn>;
		emit: ReturnType<typeof vi.fn>;
	};
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	model: { id: string; provider: string };
};

function createTestPi(settingsValues: Record<string, unknown>): TestPi {
	return {
		events: {
			on: vi.fn(),
			emit: vi.fn((event: string, probe: { values?: unknown }) => {
				if (event === "extension:settings:get") {
					probe.values = settingsValues;
				}
			}),
		},
		on: vi.fn(),
		registerCommand: vi.fn(),
		model: { id: "fallback-model", provider: "fallback-provider" },
	};
}

function eventHandler(pi: TestPi, name: string): EventHandler {
	const registration = pi.on.mock.calls.find((call) => call[0] === name);
	if (!registration) throw new Error(`event handler not registered: ${name}`);
	return registration[1] as EventHandler;
}

type OtlpValue = {
	stringValue?: string;
	intValue?: string;
	boolValue?: boolean;
	arrayValue?: { values?: OtlpValue[] };
};

type OtlpAttribute = {
	key: string;
	value?: OtlpValue;
};

type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes?: OtlpAttribute[];
};

type OtlpPayload = {
	resourceSpans?: Array<{
		scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
	}>;
	batch?: Array<{
		type?: string;
		body?: Record<string, unknown>;
	}>;
};

function parsePayload(body: string): OtlpPayload | undefined {
	try {
		return JSON.parse(body) as OtlpPayload;
	} catch {
		return undefined;
	}
}

function exportedOtlpSpans(bodies: string[]): OtlpSpan[] {
	const spans: OtlpSpan[] = [];
	for (const body of bodies) {
		const payload = parsePayload(body);
		if (!payload?.resourceSpans) continue;
		spans.push(
			...payload.resourceSpans.flatMap((resource) =>
				(resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
			),
		);
	}
	if (spans.length > 0) return spans;
	throw new Error("no OTLP span export was received");
}

function attributeValue(span: OtlpSpan, key: string) {
	return span.attributes?.find((attribute) => attribute.key === key)?.value;
}

function attributeString(span: OtlpSpan, key: string) {
	return attributeValue(span, key)?.stringValue;
}

function attributeStrings(span: OtlpSpan, key: string) {
	return (attributeValue(span, key)?.arrayValue?.values ?? [])
		.map((value) => value.stringValue)
		.filter((value): value is string => value !== undefined);
}

function attributeNumber(span: OtlpSpan, key: string) {
	const value = attributeValue(span, key);
	if (value?.intValue !== undefined) return Number(value.intValue);
	if (value?.stringValue !== undefined) return Number(value.stringValue);
	return undefined;
}

const configEnvironmentKeys = [
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_LANGFUSE_CONFIG",
	"LANGFUSE_PUBLIC_KEY",
	"LANGFUSE_SECRET_KEY",
	"LANGFUSE_BASE_URL",
	"LANGFUSE_HOST",
	"LANGFUSE_USER_ID",
	"LANGFUSE_RELEASE",
	"LANGFUSE_ENV",
	"PI_LANGFUSE_USER_ID",
	"PI_LANGFUSE_TAGS",
	"PI_LANGFUSE_RELEASE",
	"PI_LANGFUSE_ENV",
	"PI_LANGFUSE_AUTOSTART",
	"PI_LANGFUSE_AUTOSTART_DIR",
	"PI_LANGFUSE_AUTOSTART_HEALTH_URL",
	"PI_LANGFUSE_AUTOSTART_TIMEOUT_MS",
	"PI_LANGFUSE_REDACTION",
	"PI_LANGFUSE_UNREDACTED",
	"PI_LANGFUSE_REDACTION_SECRETS",
	"PI_LANGFUSE_SKIP_UNPERSISTED",
	"PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD",
	"PI_LANGFUSE_PROVIDER_PAYLOAD_MAX_CHARS",
	"PI_LANGFUSE_CAPTURE_POLICY",
	"PI_LANGFUSE_CAPTURE_PROMPT",
	"PI_LANGFUSE_CAPTURE_SYSTEM_PROMPT",
	"PI_LANGFUSE_CAPTURE_PROVIDER_INPUT",
	"PI_LANGFUSE_CAPTURE_ASSISTANT_OUTPUT",
	"PI_LANGFUSE_CAPTURE_TOOL_INPUT",
	"PI_LANGFUSE_CAPTURE_TOOL_OUTPUT",
	"PI_LANGFUSE_CAPTURE_METADATA",
	"PI_LANGFUSE_PAYLOAD_MAX_STRING_CHARS",
	"PI_LANGFUSE_PAYLOAD_MAX_TOOL_CHARS",
	"PI_LANGFUSE_PAYLOAD_MAX_DEPTH",
	"PI_LANGFUSE_PAYLOAD_MAX_ARRAY_ITEMS",
	"PI_LANGFUSE_PAYLOAD_MAX_OBJECT_KEYS",
	"PI_LANGFUSE_PAYLOAD_MAX_NODES",
	"PI_LANGFUSE_RAW_TRACE",
	"PI_LANGFUSE_RAW_TRACE_DIR",
	"PI_LANGFUSE_RAW_PROVIDER_REQUEST",
] as const;

let previousEnvironment: Map<string, string | undefined>;

function setIsolatedEnvironment() {
	for (const key of configEnvironmentKeys) delete process.env[key];
	process.env.PI_LANGFUSE_AUTOSTART = "0";
	process.env.PI_LANGFUSE_CAPTURE_POLICY = "full-debug";
	process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD = "0";
	process.env.PI_LANGFUSE_PAYLOAD_MAX_STRING_CHARS = "unlimited";
	process.env.PI_LANGFUSE_PAYLOAD_MAX_TOOL_CHARS = "unlimited";
	process.env.PI_LANGFUSE_PAYLOAD_MAX_DEPTH = "unlimited";
	process.env.PI_LANGFUSE_PAYLOAD_MAX_ARRAY_ITEMS = "unlimited";
	process.env.PI_LANGFUSE_PAYLOAD_MAX_OBJECT_KEYS = "unlimited";
	process.env.PI_LANGFUSE_PAYLOAD_MAX_NODES = "unlimited";
	process.env.PI_LANGFUSE_REDACTION = "1";
	process.env.PI_LANGFUSE_UNREDACTED = "0";
	process.env.PI_LANGFUSE_RAW_PROVIDER_REQUEST = "summary";
	process.env.PI_LANGFUSE_SKIP_UNPERSISTED = "0";
}

const createdRoots: string[] = [];

function tempRoot(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	createdRoots.push(root);
	return root;
}

beforeEach(() => {
	previousEnvironment = new Map(
		configEnvironmentKeys.map((key) => [key, process.env[key]]),
	);
});

afterEach(async () => {
	try {
		drainRawTraceQueue();
		await shutdownClient();
	} finally {
		for (const key of configEnvironmentKeys) {
			const value = previousEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const root of createdRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("registered Langfuse v5 runtime path", () => {
	it("exports the existing trace tree and telemetry semantics through the real extension", async () => {
		const agentDir = tempRoot("pi-langfuse-v5-extension-agent-");
		const rawTraceDir = join(agentDir, "raw-traces");
		const secret = "sk-local-extension-secret-1234567890";
		const sessionFile =
			"/tmp/pi-agent/sessions/--v5-extension--/v5-extension-session.jsonl";
		setIsolatedEnvironment();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_LANGFUSE_RAW_TRACE_DIR = rawTraceDir;

		const bodies: string[] = [];
		const scoreBodies: Record<string, unknown>[] = [];
		const receivedSpans: OtlpSpan[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				bodies.push(body);
				// A v4-shaped server: the supported routes answer, the legacy
				// v3-only routes are gone.
				if (request.url?.includes("/api/public/scores")) {
					scoreBodies.push(JSON.parse(body) as Record<string, unknown>);
					response.statusCode = 200;
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify({ id: "created-score" }));
					return;
				}
				if (
					request.url?.includes("/api/public/ingestion") ||
					request.url?.includes("/api/public/traces/")
				) {
					response.statusCode = 404;
					response.end("not found");
					return;
				}
				// Answer the v2 observations query from received OTLP spans so the
				// fallback completeness check behaves like a real server.
				if (request.url?.includes("/api/public/otel/v1/traces")) {
					const payload = parsePayload(body);
					if (payload?.resourceSpans) {
						for (const resource of payload.resourceSpans) {
							for (const scope of resource.scopeSpans ?? []) {
								receivedSpans.push(...(scope.spans ?? []));
							}
						}
					}
				}
				if (request.url?.includes("/api/public/v2/observations")) {
					const traceId =
						new URL(request.url, "http://localhost").searchParams.get(
							"traceId",
						) || "";
					const data = receivedSpans
						.filter((span) => span.traceId === traceId)
						.map((span) => ({ id: span.spanId }));
					response.statusCode = 200;
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify({ data, meta: {} }));
					return;
				}
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end("{}");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});

		try {
			const address = server.address() as AddressInfo;
			const pi = createTestPi({
				enabled: true,
				"public-key": "pk-local-extension",
				"secret-key": "sk-local-extension-key",
				"base-url": `http://127.0.0.1:${address.port}`,
				"user-id": "extension-user",
				"default-tags": "compatibility, local-v5",
				release: "extension-release",
				environment: "extension-test",
				"capture-policy": "full-debug",
				"capture-message-updates": true,
				"payload-max-string-chars": "unlimited",
				"payload-max-tool-chars": "unlimited",
				"payload-max-depth": "unlimited",
				"payload-max-array-items": "unlimited",
				"payload-max-object-keys": "unlimited",
				"payload-max-nodes": "unlimited",
				"redaction-enabled": true,
				"raw-trace-enabled": true,
				"raw-trace-dir": rawTraceDir,
			});
			const context = {
				model: { id: "extension-model", provider: "extension-provider" },
				sessionManager: { getSessionFile: () => sessionFile },
			};
			const handler = (name: string) => eventHandler(pi, name);
			const emit = (name: string, event: unknown) =>
				handler(name)(event, context);

			await registerExtension(pi as unknown as ExtensionAPI);
			await emit("session_start", { reason: "startup" });
			await emit("model_select", {
				model: { id: "extension-model", provider: "extension-provider" },
			});
			await emit("before_agent_start", {
				prompt: `first prompt ${secret}`,
				systemPrompt: `system prompt ${secret}`,
				systemPromptOptions: { cwd: "/tmp/v5-extension-project" },
			});
			await emit("agent_start", {});

			await emit("turn_start", { turnIndex: 0 });
			await emit("message_start", {
				message: { role: "user", content: "first request" },
			});
			await emit("message_end", {
				message: { role: "user", content: "first request" },
			});
			await emit("context", {
				messages: [
					{ role: "system", content: `system prompt ${secret}` },
					{ role: "user", content: "first request" },
				],
			});
			await emit("before_provider_request", {
				payload: {
					model: "extension-model",
					messages: [
						{ role: "system", content: `system prompt ${secret}` },
						{ role: "user", content: "first request" },
					],
				},
			});
			await emit("message_start", { message: { role: "assistant" } });
			await emit("message_update", {
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "thinking " },
			});
			await emit("message_update", {
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "streamed " },
			});
			await Promise.all([
				emit("tool_execution_start", {
					toolCallId: "tool-a",
					toolName: "bash",
					args: { command: `printf ${secret}` },
				}),
				emit("tool_execution_start", {
					toolCallId: "tool-b",
					toolName: "read",
					args: { path: "/tmp/v5-output.txt" },
				}),
			]);
			await emit("tool_execution_update", {
				toolCallId: "tool-a",
				toolName: "bash",
				args: { command: `printf ${secret}` },
				partialResult: { content: [{ type: "text", text: "partial" }] },
			});
			await Promise.all([
				emit("tool_execution_end", {
					toolCallId: "tool-b",
					toolName: "read",
					result: { content: [{ type: "text", text: "tool-b output" }] },
					isError: false,
				}),
				emit("tool_execution_end", {
					toolCallId: "tool-a",
					toolName: "bash",
					result: {
						content: [{ type: "text", text: `tool-a output ${secret}` }],
					},
					isError: false,
				}),
			]);
			await emit("message_end", {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "streamed answer" }],
					model: "extension-model-final-0",
					usage: {
						input: 4,
						output: 6,
						totalTokens: 10,
						cost: { input: 0.04, output: 0.06, total: 0.1 },
					},
				},
			});
			await emit("turn_end", {
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			});

			await emit("turn_start", { turnIndex: 1 });
			await emit("message_start", {
				message: { role: "user", content: "second request" },
			});
			await emit("message_end", {
				message: { role: "user", content: "second request" },
			});
			await emit("context", {
				messages: [{ role: "user", content: "second request" }],
			});
			await emit("before_provider_request", {
				payload: {
					model: "extension-model",
					messages: [{ role: "user", content: "second request" }],
				},
			});
			await emit("message_start", { message: { role: "assistant" } });
			await emit("message_update", {
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "second " },
			});
			await emit("message_end", {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "second answer" }],
					model: "extension-model-final-1",
					usage: { input: 2, output: 3, totalTokens: 5 },
				},
			});
			await emit("turn_end", {
				turnIndex: 1,
				message: { role: "assistant", content: [] },
				toolResults: [],
			});
			await emit("agent_end", {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "final answer" }],
					},
				],
			});
			await emit("agent_settled", {});
			await emit("session_shutdown", {});
			drainRawTraceQueue();

			const exported = bodies.join("\n");
			const spans = exportedOtlpSpans(bodies);
			const promptSpans = spans.filter((span) => span.name === "agent.prompt");
			const turnSpans = spans.filter((span) => span.name === "agent.turn");
			const generationSpans = spans.filter(
				(span) => span.name === "llm-response",
			);
			const toolSpans = spans.filter((span) =>
				["tool:bash", "tool:read"].includes(span.name),
			);
			expect(promptSpans).toHaveLength(1);
			expect(turnSpans).toHaveLength(2);
			expect(generationSpans).toHaveLength(2);
			expect(toolSpans).toHaveLength(2);
			const promptSpan = promptSpans[0];
			if (!promptSpan) throw new Error("prompt span was not exported");
			expect(promptSpan.parentSpanId).toBeUndefined();
			expect(
				turnSpans.every((span) => span.parentSpanId === promptSpan.spanId),
			).toBe(true);
			const turnByIndex = new Map(
				turnSpans.map((span) => [
					attributeNumber(span, "langfuse.observation.metadata.turnIndex"),
					span,
				]),
			);
			expect([...turnByIndex.keys()].sort()).toEqual([0, 1]);
			const firstTurn = turnByIndex.get(0);
			const secondTurn = turnByIndex.get(1);
			if (!firstTurn || !secondTurn)
				throw new Error("both turn spans are required");
			expect(
				JSON.parse(
					attributeString(firstTurn, "langfuse.observation.input") || "null",
				),
			).toEqual([{ role: "user", content: "first request" }]);
			expect(
				JSON.parse(
					attributeString(firstTurn, "langfuse.observation.output") || "null",
				),
			).toEqual({
				text: "streamed answer",
				tool_calls: [],
				thinking: "thinking ",
			});
			expect(
				JSON.parse(
					attributeString(secondTurn, "langfuse.observation.input") || "null",
				),
			).toEqual([{ role: "user", content: "second request" }]);
			expect(
				JSON.parse(
					attributeString(secondTurn, "langfuse.observation.output") || "null",
				),
			).toEqual({
				text: "second answer",
				tool_calls: [],
			});
			for (const span of generationSpans) {
				const turnIndex = attributeNumber(
					span,
					"langfuse.observation.metadata.turnIndex",
				);
				if (turnIndex === undefined)
					throw new Error("generation turn is missing");
				expect(span.parentSpanId).toBe(turnByIndex.get(turnIndex)?.spanId);
			}
			for (const span of toolSpans) {
				expect(
					attributeNumber(span, "langfuse.observation.metadata.turnIndex"),
				).toBe(0);
				expect(span.parentSpanId).toBe(turnByIndex.get(0)?.spanId);
			}
			expect(new Set(spans.map((span) => span.traceId))).toEqual(
				new Set([promptSpan.traceId]),
			);
			expect(attributeString(promptSpan, "langfuse.trace.name")).toBe(
				"pi-agent",
			);
			expect(attributeString(promptSpan, "session.id")).toBe(
				"v5-extension-session",
			);
			expect(attributeString(promptSpan, "user.id")).toBe("extension-user");
			expect(attributeString(promptSpan, "langfuse.release")).toBe(
				"extension-release",
			);
			expect(attributeString(promptSpan, "langfuse.environment")).toBe(
				"extension-test",
			);
			expect(attributeStrings(promptSpan, "langfuse.trace.tags")).toEqual(
				expect.arrayContaining(["compatibility", "local-v5"]),
			);
			expect(attributeString(promptSpan, "langfuse.trace.input")).toMatch(
				/^first prompt \[REDACTED:/,
			);
			expect(attributeString(promptSpan, "langfuse.trace.output")).toBe(
				"final answer",
			);

			const generationByTurn = new Map(
				generationSpans.map((span) => [
					attributeNumber(span, "langfuse.observation.metadata.turnIndex"),
					span,
				]),
			);
			const firstGeneration = generationByTurn.get(0);
			if (!firstGeneration)
				throw new Error("first generation was not exported");
			expect(
				attributeString(
					firstGeneration,
					"langfuse.observation.metadata.partial",
				),
			).toBe("true");
			expect(
				JSON.parse(
					attributeString(firstGeneration, "langfuse.observation.output") ||
						"null",
				),
			).toEqual({
				text: "streamed answer",
				tool_calls: [],
				thinking: "thinking ",
			});
			expect(
				attributeString(
					firstGeneration,
					"langfuse.observation.metadata.hasThinking",
				),
			).toBe("true");
			expect(
				attributeString(
					firstGeneration,
					"langfuse.observation.metadata.thinking",
				),
			).toBeUndefined();
			expect(
				JSON.parse(
					attributeString(
						firstGeneration,
						"langfuse.observation.usage_details",
					) || "{}",
				),
			).toEqual({ input: 4, output: 6, total: 10 });
			expect(
				JSON.parse(
					attributeString(
						firstGeneration,
						"langfuse.observation.cost_details",
					) || "{}",
				),
			).toEqual({ input: 0.04, output: 0.06, total: 0.1 });
			// Scores travel through the supported scores endpoint (the legacy
			// ingestion route is rejected by this server) and carry the
			// configured environment, matching the environment on spans.
			expect(scoreBodies.length).toBeGreaterThan(0);
			for (const score of scoreBodies) {
				expect(score.environment).toBe("extension-test");
			}
			// Tokens and cost travel on the generation (checked above), not as
			// duplicate score objects.
			expect(
				scoreBodies.filter((score) =>
					["input_tokens", "output_tokens", "total_cost"].includes(
						String(score.name),
					),
				),
			).toEqual([]);
			expect(exported).not.toContain(secret);

			const rawPath = join(
				rawTraceDir,
				"--v5-extension--",
				"v5-extension-session.jsonl",
			);
			expect(existsSync(rawPath)).toBe(true);
			const raw = readFileSync(rawPath, "utf8");
			const rawRecords = raw
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(rawRecords.map((record) => record.type)).toEqual(
				expect.arrayContaining([
					"session_start",
					"provider_request",
					"assistant_output",
					"session_end",
				]),
			);
			expect(
				rawRecords.every(
					(record) => record.sessionId === "v5-extension-session",
				),
			).toBe(true);
			expect(
				rawRecords
					.filter((record) => typeof record.traceId === "string")
					.every((record) => record.traceId === promptSpan.traceId),
			).toBe(true);
			expect(raw).toContain("[REDACTED:");
			expect(raw).not.toContain(secret);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});

type RecordedScore = {
	name?: string;
	value?: number;
	traceId?: string;
	dataType?: string;
	comment?: string;
	observationId?: string;
};

type Notification = { message: string; type?: string };

type FeedbackSession = {
	file: string;
	id: string;
	notifications: Notification[];
	setStatus: ReturnType<typeof vi.fn>;
	ctx: Record<string, unknown>;
};

type Harness = {
	pi: TestPi;
	recorder: LangfuseRecorder;
	settingsValues: Record<string, unknown>;
	session: (name: string) => FeedbackSession;
	emit: (session: FeedbackSession, name: string, event: unknown) => unknown;
	command: (session: FeedbackSession, args: string) => Promise<void>;
	askEvent: (channel: "started" | "completed", event: unknown) => void;
};

async function startHarness(recorder: LangfuseRecorder): Promise<Harness> {
	const agentDir = tempRoot("pi-langfuse-feedback-agent-");
	setIsolatedEnvironment();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_LANGFUSE_RAW_TRACE_DIR = join(agentDir, "raw-traces");
	const settingsValues: Record<string, unknown> = {
		enabled: true,
		"public-key": "pk-feedback-test",
		"secret-key": "sk-feedback-test-key",
		"base-url": recorder.url,
		environment: "feedback-test",
		"capture-policy": "full-debug",
		"redaction-enabled": true,
		"raw-trace-enabled": false,
	};
	const pi = createTestPi(settingsValues);
	await registerExtension(pi as unknown as ExtensionAPI);
	const sessions = new Map<string, FeedbackSession>();
	const session = (name: string) => {
		const existing = sessions.get(name);
		if (existing) return existing;
		const file = `/tmp/pi-agent/sessions/--feedback--/${name}.jsonl`;
		const notifications: Notification[] = [];
		const setStatus = vi.fn();
		const created: FeedbackSession = {
			file,
			id: name,
			notifications,
			setStatus,
			ctx: {
				model: { id: "feedback-model", provider: "feedback-provider" },
				sessionManager: { getSessionFile: () => file },
				hasUI: true,
				isIdle: () => true,
				ui: {
					setStatus,
					notify: (message: string, type?: string) =>
						notifications.push({ message, type }),
				},
			},
		};
		sessions.set(name, created);
		return created;
	};
	const askListener = (channel: string) => {
		const registration = pi.events.on.mock.calls.find(
			(call) => call[0] === `pi-ask:${channel}`,
		);
		if (!registration) throw new Error(`pi-ask:${channel} is not subscribed`);
		return registration[1] as (event: unknown) => void;
	};
	return {
		pi,
		recorder,
		settingsValues,
		session,
		emit: (target, name, event) => eventHandler(pi, name)(event, target.ctx),
		command: async (target, args) => {
			const registration = pi.registerCommand.mock.calls.find(
				(call) => call[0] === "langfuse-score",
			);
			if (!registration) throw new Error("langfuse-score is not registered");
			const options = registration[1] as {
				handler: (args: string, ctx: unknown) => Promise<void>;
			};
			await options.handler(args, target.ctx);
		},
		askEvent: (channel, event) => askListener(channel)(event),
	};
}

async function withHarness(
	run: (harness: Harness, recorder: LangfuseRecorder) => Promise<void>,
) {
	const recorder = await startLangfuseRecorder("feedback");
	try {
		await run(await startHarness(recorder), recorder);
	} finally {
		await shutdownClient();
		await recorder.close();
	}
}

function settingsChangedListener(harness: Harness): () => void {
	const registration = harness.pi.events.on.mock.calls.find(
		(call) => call[0] === "pi-extension-settings:pi-langfuse:changed",
	);
	if (!registration) throw new Error("settings change listener is missing");
	return registration[1] as () => void;
}

async function startPrompt(harness: Harness, target: FeedbackSession) {
	await harness.emit(target, "session_start", { reason: "startup" });
	await harness.emit(target, "before_agent_start", {
		prompt: `prompt for ${target.id}`,
		systemPrompt: "system",
		systemPromptOptions: { cwd: "/tmp/feedback-project" },
	});
	await harness.emit(target, "agent_start", {});
	await harness.emit(target, "turn_start", { turnIndex: 0 });
}

async function startTool(
	harness: Harness,
	target: FeedbackSession,
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown> = {},
) {
	await harness.emit(target, "tool_call", { toolCallId, toolName, input });
	await harness.emit(target, "tool_execution_start", {
		toolCallId,
		toolName,
		args: input,
	});
}

async function endTool(
	harness: Harness,
	target: FeedbackSession,
	toolCallId: string,
	toolName: string,
	isError = false,
) {
	await harness.emit(target, "tool_result", {
		toolCallId,
		toolName,
		input: {},
		content: [{ type: "text", text: "tool output" }],
		isError,
	});
	await harness.emit(target, "tool_execution_end", {
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text: "tool output" }] },
		isError,
	});
}

/** Pi reports a finished turn's tool results in transcript order. */
async function finishPrompt(
	harness: Harness,
	target: FeedbackSession,
	options: {
		transcript?: Array<{ toolCallId: string; isError: boolean }>;
		aborted?: boolean;
		settledTwice?: boolean;
	} = {},
) {
	await harness.emit(target, "turn_end", {
		turnIndex: 0,
		message: { role: "assistant", content: [] },
		toolResults: (options.transcript ?? []).map((result) => ({
			role: "toolResult",
			...result,
		})),
	});
	await harness.emit(target, "agent_end", {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		],
	});
	const settled =
		options.aborted === undefined ? {} : { aborted: options.aborted };
	await harness.emit(target, "agent_settled", settled);
	if (options.settledTwice)
		await harness.emit(target, "agent_settled", settled);
	// Settling does not wait for delivery; wait for it here, as session
	// shutdown does, so the recorder holds the finished prompt.
	await flushClient();
}

function scoreBodies(recorder: LangfuseRecorder): RecordedScore[] {
	return recorder.scores.map((score) => score.body as RecordedScore);
}

function exportedSpans(recorder: LangfuseRecorder): OtlpSpan[] {
	return recorder.records.flatMap((record) => {
		const payload = record.body as OtlpPayload | undefined;
		return (payload?.resourceSpans ?? []).flatMap((resource) =>
			(resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
		);
	});
}

/** Trace ids of the session's prompts, in export order. */
function traceIdsOf(recorder: LangfuseRecorder, sessionId: string) {
	const ids: string[] = [];
	for (const span of exportedSpans(recorder)) {
		if (
			span.name === "agent.prompt" &&
			attributeString(span, "session.id") === sessionId &&
			!ids.includes(span.traceId)
		)
			ids.push(span.traceId);
	}
	return ids;
}

function onlyTraceId(recorder: LangfuseRecorder, sessionId: string) {
	const ids = traceIdsOf(recorder, sessionId);
	if (ids.length !== 1) throw new Error(`expected one trace for ${sessionId}`);
	return ids[0] as string;
}

function scoresOfTrace(recorder: LangfuseRecorder, traceId: string) {
	return scoreBodies(recorder).filter((score) => score.traceId === traceId);
}

function scoreNamed(
	recorder: LangfuseRecorder,
	traceId: string,
	name: string,
): RecordedScore[] {
	return scoresOfTrace(recorder, traceId).filter(
		(score) => score.name === name,
	);
}

function feedbackScores(recorder: LangfuseRecorder) {
	return scoreBodies(recorder).filter(
		(score) => score.name === "user_feedback",
	);
}

/**
 * The prompt span carries the metadata that finalization wrote. Only scalar
 * values also propagate to `langfuse.trace.metadata.*`.
 */
function traceMetadata(
	recorder: LangfuseRecorder,
	traceId: string,
	key: string,
): unknown {
	for (const span of exportedSpans(recorder)) {
		if (span.traceId !== traceId || span.name !== "agent.prompt") continue;
		const raw = attributeString(span, `langfuse.observation.metadata.${key}`);
		if (raw !== undefined) return /^[[{]/.test(raw) ? JSON.parse(raw) : raw;
	}
	return undefined;
}

function toolSpanMetadata(
	recorder: LangfuseRecorder,
	toolName: string,
	key: string,
): unknown {
	const span = exportedSpans(recorder).find(
		(candidate) => candidate.name === `tool:${toolName}`,
	);
	const raw = span
		? attributeString(span, `langfuse.observation.metadata.${key}`)
		: undefined;
	return raw === undefined ? undefined : JSON.parse(raw);
}

describe("explicit feedback through the registered /langfuse-score command", () => {
	it("scores only the invoking session's last finalized trace with a delivered, announced score", async () => {
		await withHarness(async (harness, recorder) => {
			const first = harness.session("feedback-a");
			const second = harness.session("feedback-b");
			await startPrompt(harness, first);
			await finishPrompt(harness, first);
			await startPrompt(harness, second);
			await finishPrompt(harness, second);
			const traceA = onlyTraceId(recorder, "feedback-a");
			const traceB = onlyTraceId(recorder, "feedback-b");
			expect(traceA).not.toBe(traceB);

			await harness.command(first, "good Nice   work");
			// The notification means the scores endpoint already answered.
			expect(feedbackScores(recorder)).toHaveLength(1);
			expect(first.notifications.at(-1)).toEqual({
				message: `Feedback saved: good for trace ${traceA}`,
				type: "info",
			});
			await harness.command(second, "BAD");

			expect(feedbackScores(recorder)).toEqual([
				expect.objectContaining({
					name: "user_feedback",
					value: 1,
					dataType: "BOOLEAN",
					traceId: traceA,
					comment: "Nice work",
				}),
				expect.objectContaining({
					name: "user_feedback",
					value: 0,
					dataType: "BOOLEAN",
					traceId: traceB,
				}),
			]);
			expect(feedbackScores(recorder)[1]?.comment).toBeUndefined();
			expect(recorder.legacyHits).toEqual([]);
		});
	});

	it("rejects feedback when the session has no finalized trace, including during its first prompt", async () => {
		await withHarness(async (harness, recorder) => {
			const idle = harness.session("feedback-idle");
			await harness.command(idle, "good");
			expect(idle.notifications.at(-1)).toEqual({
				message:
					"Feedback not saved: this session has no finalized trace to rate",
				type: "warning",
			});

			const active = harness.session("feedback-first-prompt");
			await startPrompt(harness, active);
			await harness.command(active, "good");
			expect(active.notifications.at(-1)?.type).toBe("warning");

			// A session that finalized a trace does not lend it to another session.
			const finished = harness.session("feedback-finished");
			await startPrompt(harness, finished);
			await finishPrompt(harness, finished);
			await harness.command(idle, "bad");
			expect(idle.notifications.at(-1)?.type).toBe("warning");
			expect(feedbackScores(recorder)).toEqual([]);
		});
	});

	it("keeps targeting the prior finalized trace while a new prompt is active", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-active");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			const priorTrace = onlyTraceId(recorder, "feedback-active");

			await startPrompt(harness, target);
			await harness.command(target, "bad regression");
			expect(feedbackScores(recorder)).toEqual([
				expect.objectContaining({ traceId: priorTrace, value: 0 }),
			]);

			await finishPrompt(harness, target);
			const traces = traceIdsOf(recorder, "feedback-active");
			expect(traces).toHaveLength(2);
			expect(traces[1]).not.toBe(priorTrace);
			// The second prompt becomes the target only once it finalizes.
			await harness.command(target, "good");
			expect(feedbackScores(recorder).at(-1)?.traceId).toBe(traces[1]);
		});
	});

	it.each(["", "   ", "maybe", "good-ish text", "0"])(
		"rejects invalid arguments %j without scoring",
		async (args) => {
			await withHarness(async (harness, recorder) => {
				const target = harness.session("feedback-args");
				await startPrompt(harness, target);
				await finishPrompt(harness, target);
				await harness.command(target, args);
				expect(target.notifications.at(-1)).toEqual({
					message: "Usage: /langfuse-score <good|bad> [comment]",
					type: "warning",
				});
				expect(feedbackScores(recorder)).toEqual([]);
			});
		},
	);

	it("rejects feedback after the destination changes and accepts it again once restored", async () => {
		await withHarness(async (harness, recorder) => {
			const other = await startLangfuseRecorder("feedback-other");
			try {
				const target = harness.session("feedback-reload");
				await startPrompt(harness, target);
				await finishPrompt(harness, target);
				const trace = onlyTraceId(recorder, "feedback-reload");
				const original = { ...harness.settingsValues };
				const reload = async (changes: Record<string, unknown>) => {
					const before = target.setStatus.mock.calls.length;
					Object.assign(harness.settingsValues, changes);
					settingsChangedListener(harness)();
					await vi.waitFor(() =>
						expect(target.setStatus.mock.calls.length).toBeGreaterThan(before),
					);
				};
				// Bind this session as the UI context the reload refreshes.
				await harness.emit(target, "session_start", { reason: "reload" });

				await reload({ "base-url": other.url });
				await harness.command(target, "good");
				await reload({ "base-url": recorder.url, "public-key": "pk-other" });
				await harness.command(target, "good");
				expect(
					target.notifications.map((entry) => [entry.message, entry.type]),
				).toEqual([
					[
						"Feedback not saved: the last trace was written to a different Langfuse destination than the current configuration",
						"error",
					],
					[
						"Feedback not saved: the last trace was written to a different Langfuse destination than the current configuration",
						"error",
					],
				]);
				expect(feedbackScores(recorder)).toEqual([]);
				expect(feedbackScores(other)).toEqual([]);

				await reload(original);
				await harness.command(target, "good");
				expect(feedbackScores(recorder)).toEqual([
					expect.objectContaining({ traceId: trace }),
				]);
				expect(feedbackScores(other)).toEqual([]);
			} finally {
				await shutdownClient();
				await other.close();
			}
		});
	});

	it("rejects feedback for a trace finalized by a configuration reload under the old destination", async () => {
		await withHarness(async (harness, recorder) => {
			const other = await startLangfuseRecorder("feedback-reload-active");
			try {
				const target = harness.session("feedback-reload-active");
				await startPrompt(harness, target);
				const before = target.setStatus.mock.calls.length;
				harness.settingsValues["base-url"] = other.url;
				settingsChangedListener(harness)();
				await vi.waitFor(() =>
					expect(target.setStatus.mock.calls.length).toBeGreaterThan(before),
				);
				// The reload finalized the prompt with the new configuration in hand,
				// yet the trace belongs to the destination it was created for.
				expect(traceIdsOf(recorder, "feedback-reload-active")).toHaveLength(1);
				await harness.command(target, "bad");
				expect(target.notifications.at(-1)?.type).toBe("error");
				expect(feedbackScores(recorder)).toEqual([]);
				expect(feedbackScores(other)).toEqual([]);
			} finally {
				await shutdownClient();
				await other.close();
			}
		});
	});

	it("redacts, flattens, and bounds the comment", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-comment");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			const configuredSecret = "sk-feedback-test-key";
			const patternSecret = "sk-local-extension-secret-1234567890";
			const padding = "word ".repeat(10);
			const comment = `bad \u0007${configuredSecret}\n${padding}${patternSecret} tail ${"y ".repeat(1500)}`;
			await harness.command(target, comment);
			const [score] = feedbackScores(recorder);
			const saved = score?.comment ?? "";
			expect(saved.length).toBeLessThanOrEqual(501);
			expect(saved).toMatch(
				/^\[REDACTED:[^\]]+\] (word ){10}\[REDACTED:[^\]]+\] tail( y)+ ?…$/,
			);
			expect(saved).not.toContain(configuredSecret);
			expect(saved).not.toContain(patternSecret);
			expect([...saved].every((char) => char.charCodeAt(0) >= 32)).toBe(true);
			expect(JSON.stringify(recorder.records)).not.toContain(configuredSecret);
		});
	});

	it("redacts a configured secret that contains whitespace before flattening", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-space-secret");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			const secret = "alpha  beta\tgamma\ndelta epsilon";
			process.env.PI_LANGFUSE_REDACTION_SECRETS = `${secret}, unrelated-secret-value`;
			await harness.command(target, `good note ${secret} end`);
			const saved = feedbackScores(recorder)[0]?.comment ?? "";
			expect(saved).toMatch(/^note \[REDACTED:configured-secret:[^\]]+\] end$/);
			for (const fragment of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
				expect(saved).not.toContain(fragment);
				expect(JSON.stringify(recorder.records)).not.toContain(fragment);
			}
		});
	});

	it("applies the final length bound after redacting a secret that straddles it", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-boundary-secret");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			const secret = "boundary  secret\nliteral value";
			process.env.PI_LANGFUSE_REDACTION_SECRETS = secret;
			const lead = `${"w".repeat(9)} `.repeat(49);
			// The secret starts at flattened offset 490; its redaction marker is
			// longer than the 10 characters left before the bound.
			await harness.command(target, `bad ${lead}${secret} tail`);
			const saved = feedbackScores(recorder)[0]?.comment ?? "";
			expect(saved.startsWith(lead)).toBe(true);
			expect(saved.slice(lead.length)).toBe("[REDACTED:…");
			expect(saved.length).toBe(501);
			expect(saved).not.toMatch(/boundary|literal/);
		});
	});

	it("rejects an oversized comment, including a private key, without scoring or echoing it", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-oversized");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			const body = Array.from({ length: 70 }, (_, line) =>
				`SYNTHETICKEYBODY${String(line).padStart(4, "0")}`.padEnd(64, "x"),
			).join("\n");
			const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
			expect(pem.length).toBeGreaterThan(4_000);
			await harness.command(target, `good ${pem}`);
			// Exactly at the limit is accepted; one character over is not.
			await harness.command(target, `good ${"a".repeat(4_000)}`);
			await harness.command(target, `good ${"a".repeat(4_001)}`);
			expect(
				target.notifications.map((entry) => [entry.message, entry.type]),
			).toEqual([
				[
					`Feedback not saved: the comment has ${pem.length} characters, over the 4000 limit. Shorten it or omit it.`,
					"warning",
				],
				[expect.stringMatching(/^Feedback saved: good/), "info"],
				[
					"Feedback not saved: the comment has 4001 characters, over the 4000 limit. Shorten it or omit it.",
					"warning",
				],
			]);
			expect(feedbackScores(recorder)).toHaveLength(1);
			expect(JSON.stringify(target.notifications)).not.toContain(
				"SYNTHETICKEYBODY",
			);
			expect(JSON.stringify(recorder.records)).not.toContain(
				"SYNTHETICKEYBODY",
			);
		});
	});

	it("redacts a multiline private key that fits the input limit before the stored bound", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-pem");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			const pem = `-----BEGIN PRIVATE KEY-----\n${"SYNTHETICKEYBODY".padEnd(64, "x")}\n${"SYNTHETICKEYTAIL".padEnd(64, "x")}\n-----END PRIVATE KEY-----`;
			await harness.command(target, `good ${"w ".repeat(100)}${pem} after`);
			const saved = feedbackScores(recorder)[0]?.comment ?? "";
			expect(saved).not.toContain("SYNTHETICKEY");
			expect(saved).not.toContain("PRIVATE KEY");
			expect(saved).toMatch(/^(w ){100}\[REDACTED:[^\]]+\] after$/);
		});
	});

	it("reports a failed delivery instead of announcing saved feedback", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-failure");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			recorder.faults.scoreStatus = 500;
			await harness.command(target, "good");
			expect(feedbackScores(recorder)).toHaveLength(1);
			expect(target.notifications.at(-1)).toEqual({
				message: "Feedback not saved: Langfuse did not accept the score",
				type: "error",
			});
			expect(
				target.notifications.some((entry) =>
					entry.message.startsWith("Feedback saved"),
				),
			).toBe(false);
			// The transport failure is also visible as a runtime diagnostic.
			expect(
				target.notifications.some((entry) =>
					entry.message.includes("Failed to send Langfuse score (HTTP 500)"),
				),
			).toBe(true);

			recorder.faults.scoreStatus = 200;
			await harness.command(target, "good retry");
			expect(target.notifications.at(-1)?.type).toBe("info");
		});
	});

	it("reports a runtime that cannot take the configuration instead of saving feedback", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-runtime-conflict");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			// An open prompt in another session pins the runtime's configuration.
			await startPrompt(harness, harness.session("feedback-runtime-busy"));
			harness.settingsValues.environment = "changed-environment";

			await harness.command(target, "good");

			expect(target.notifications.at(-1)).toEqual({
				message: expect.stringContaining(
					"Feedback not saved: Langfuse: a runtime with a different configuration is still active",
				),
				type: "error",
			});
			expect(feedbackScores(recorder)).toEqual([]);
		});
	});

	it("rejects feedback when tracing is not configured", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("feedback-unconfigured");
			await startPrompt(harness, target);
			await finishPrompt(harness, target);
			harness.settingsValues.enabled = false;
			await harness.command(target, "good");
			expect(target.notifications.at(-1)).toEqual({
				message:
					"Feedback not saved: Langfuse tracing is disabled or not configured",
				type: "error",
			});
			expect(feedbackScores(recorder)).toEqual([]);
		});
	});
});

describe("operational prompt scores through the registered extension", () => {
	const autoScoreValue = (
		recorder: LangfuseRecorder,
		traceId: string,
		name: string,
	) => {
		const scores = scoreNamed(recorder, traceId, name);
		if (scores.length > 1) throw new Error(`${name} was scored repeatedly`);
		return scores[0];
	};

	it("scores a prompt without tools once: zero edits, no last tool result, no ask wait", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("scores-no-tools");
			await startPrompt(harness, target);
			await finishPrompt(harness, target, { settledTwice: true });
			const trace = onlyTraceId(recorder, "scores-no-tools");
			expect(autoScoreValue(recorder, trace, "edit_write_call_count")).toEqual(
				expect.objectContaining({ value: 0 }),
			);
			expect(scoreNamed(recorder, trace, "last_tool_is_error")).toEqual([]);
			expect(scoreNamed(recorder, trace, "ask_user_wait_ms")).toEqual([]);
			expect(autoScoreValue(recorder, trace, "tool_call_count")?.value).toBe(0);
			expect(traceMetadata(recorder, trace, "askUserWait")).toBeUndefined();
		});
	});

	it("takes the last tool result from transcript order, not completion order", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("scores-reverse");
			await startPrompt(harness, target);
			await startTool(harness, target, "call-a", "read");
			await startTool(harness, target, "call-b", "bash");
			// The failing tool finishes first; the healthy one finishes last.
			await endTool(harness, target, "call-b", "bash", true);
			await endTool(harness, target, "call-a", "read", false);
			await finishPrompt(harness, target, {
				transcript: [
					{ toolCallId: "call-a", isError: false },
					{ toolCallId: "call-b", isError: true },
				],
			});
			const trace = onlyTraceId(recorder, "scores-reverse");
			expect(autoScoreValue(recorder, trace, "last_tool_is_error")).toEqual(
				expect.objectContaining({ value: 1, dataType: "BOOLEAN" }),
			);
		});
	});

	it("reports a healthy last tool after an earlier failed one as not an error", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("scores-recovered-tool");
			await startPrompt(harness, target);
			await startTool(harness, target, "call-a", "bash");
			await endTool(harness, target, "call-a", "bash", true);
			await startTool(harness, target, "call-b", "bash");
			await endTool(harness, target, "call-b", "bash", false);
			await finishPrompt(harness, target, {
				transcript: [
					{ toolCallId: "call-a", isError: true },
					{ toolCallId: "call-b", isError: false },
				],
			});
			const trace = onlyTraceId(recorder, "scores-recovered-tool");
			expect(autoScoreValue(recorder, trace, "last_tool_is_error")?.value).toBe(
				0,
			);
		});
	});

	it("counts failed, blocked, and repeated edit/write attempts once per tool call", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("scores-edits");
			await startPrompt(harness, target);
			// A failed edit, announced twice and with a duplicated execution start.
			await startTool(harness, target, "edit-1", "edit", { path: "a.ts" });
			await harness.emit(target, "tool_call", {
				toolCallId: "edit-1",
				toolName: "edit",
				input: { path: "a.ts" },
			});
			await harness.emit(target, "tool_execution_start", {
				toolCallId: "edit-1",
				toolName: "edit",
				args: { path: "a.ts" },
			});
			await endTool(harness, target, "edit-1", "edit", true);
			await harness.emit(target, "tool_execution_end", {
				toolCallId: "edit-1",
				toolName: "edit",
				result: { content: [] },
				isError: true,
			});
			// A write blocked before execution: only its result is delivered.
			await harness.emit(target, "tool_result", {
				toolCallId: "write-1",
				toolName: "write",
				input: { path: "b.ts" },
				content: [{ type: "text", text: "blocked by policy" }],
				isError: true,
			});
			// A successful write, and a non-edit tool that must not count.
			await startTool(harness, target, "write-2", "write", { path: "c.ts" });
			await endTool(harness, target, "write-2", "write", false);
			await startTool(harness, target, "read-1", "read");
			await endTool(harness, target, "read-1", "read", false);
			await finishPrompt(harness, target, {
				transcript: [
					{ toolCallId: "edit-1", isError: true },
					{ toolCallId: "write-1", isError: true },
					{ toolCallId: "write-2", isError: false },
					{ toolCallId: "read-1", isError: false },
				],
			});
			const trace = onlyTraceId(recorder, "scores-edits");
			expect(
				autoScoreValue(recorder, trace, "edit_write_call_count")?.value,
			).toBe(3);
			expect(autoScoreValue(recorder, trace, "tool_call_count")?.value).toBe(4);
		});
	});

	it("keeps recovered provider failures and aborts separate from the tool signal", async () => {
		await withHarness(async (harness, recorder) => {
			const recovered = harness.session("scores-recovered-run");
			await startPrompt(harness, recovered);
			await startTool(harness, recovered, "call-a", "bash");
			await endTool(harness, recovered, "call-a", "bash", false);
			await harness.emit(recovered, "agent_end", {
				messages: [
					{
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "provider overloaded",
					},
				],
			});
			await finishPrompt(harness, recovered, {
				transcript: [{ toolCallId: "call-a", isError: false }],
			});
			const recoveredTrace = onlyTraceId(recorder, "scores-recovered-run");
			expect(
				autoScoreValue(recorder, recoveredTrace, "last_tool_is_error")?.value,
			).toBe(0);
			expect(
				autoScoreValue(recorder, recoveredTrace, "session_had_errors")?.value,
			).toBe(0);

			// Installed Pi reports an aborted run on agent_settled; the locked
			// types lack the field, and a missing or false flag changes nothing.
			const aborted = harness.session("scores-aborted");
			await startPrompt(harness, aborted);
			await finishPrompt(harness, aborted, { aborted: true });
			const calm = harness.session("scores-not-aborted");
			await startPrompt(harness, calm);
			await finishPrompt(harness, calm, { aborted: false });
			const absent = harness.session("scores-flag-absent");
			await startPrompt(harness, absent);
			await finishPrompt(harness, absent);
			const hadErrors = (id: string) =>
				autoScoreValue(
					recorder,
					onlyTraceId(recorder, id),
					"session_had_errors",
				)?.value;
			expect(hadErrors("scores-aborted")).toBe(1);
			expect(hadErrors("scores-not-aborted")).toBe(0);
			expect(hadErrors("scores-flag-absent")).toBe(0);
			expect(
				traceMetadata(
					recorder,
					onlyTraceId(recorder, "scores-aborted"),
					"stopReason",
				),
			).toBe("aborted");
		});
	});

	it("scores a run that no before_agent_start announced", async () => {
		await withHarness(async (harness, recorder) => {
			const target = harness.session("scores-unannounced");
			await harness.emit(target, "session_start", { reason: "startup" });
			await harness.emit(target, "agent_start", {});
			await harness.emit(target, "turn_start", { turnIndex: 0 });
			await startTool(harness, target, "write-1", "write");
			await endTool(harness, target, "write-1", "write", true);
			await finishPrompt(harness, target, {
				transcript: [{ toolCallId: "write-1", isError: true }],
				settledTwice: true,
			});
			const trace = onlyTraceId(recorder, "scores-unannounced");
			expect(
				autoScoreValue(recorder, trace, "edit_write_call_count")?.value,
			).toBe(1);
			expect(autoScoreValue(recorder, trace, "last_tool_is_error")?.value).toBe(
				1,
			);
		});
	});
});

describe("tool-result details in exported turn input", () => {
	const piEditResult = {
		role: "toolResult",
		toolCallId: "edit-call",
		toolName: "edit",
		content: [{ type: "text", text: "TURNIN-visible result" }],
		details: {
			diff: "+ TURNIN-PRIVATE-SOURCE",
			patch: "@@ TURNIN-PRIVATE-PATCH",
			firstChangedLine: 7,
		},
		isError: false,
		timestamp: 1_700_000_000_000,
	};

	/** Exported `agent.turn` input after one tool result reaches the next request. */
	async function exportedTurnInput(settings: Record<string, unknown>) {
		let input = "";
		await withHarness(async (harness, recorder) => {
			Object.assign(harness.settingsValues, settings);
			const target = harness.session("turn-input-details");
			await startPrompt(harness, target);
			await harness.emit(target, "message_end", { message: piEditResult });
			await harness.emit(target, "before_provider_request", {
				payload: { model: "feedback-model" },
			});
			await finishPrompt(harness, target);
			const span = exportedSpans(recorder).find(
				(candidate) => candidate.name === "agent.turn",
			);
			input =
				attributeString(span as OtlpSpan, "langfuse.observation.input") ?? "";
		});
		return input;
	}

	it("exports the tool-result details only while tool output is captured", async () => {
		const full = await exportedTurnInput({ "capture-policy": "full-debug" });
		expect(full).toContain("TURNIN-PRIVATE-SOURCE");
		expect(full).toContain("TURNIN-PRIVATE-PATCH");

		for (const settings of [
			{ "capture-policy": "conversations" },
			{ "capture-policy": "prompts-only" },
			{ "capture-policy": "full-debug", "capture-tool-output": false },
			{
				"capture-policy": "conversations",
				"redaction-enabled": false,
			},
		]) {
			const exported = await exportedTurnInput(settings);
			expect(exported).not.toContain("TURNIN-PRIVATE-SOURCE");
			expect(exported).not.toContain("TURNIN-PRIVATE-PATCH");
			expect(exported).not.toContain("TURNIN-visible result");
			expect(exported).toContain("edit-call");
		}
	});
});

describe("pi-ask dialog wait through the registered extension", () => {
	const SECRET_QUESTION = "question-text-must-not-be-stored";
	const SECRET_ANSWER = "answer-text-must-not-be-stored";

	const started = (
		flowId: string,
		toolCallId: string | undefined,
		createdAt: number,
	) => ({
		version: 1,
		flowId,
		toolCallId,
		source: "tool",
		questions: [{ id: "q", prompt: SECRET_QUESTION, options: [] }],
		createdAt,
	});
	const completed = (
		flowId: string,
		toolCallId: string | undefined,
		completedAt: number,
		result: Record<string, unknown> = {},
	) => ({
		version: 1,
		flowId,
		toolCallId,
		source: "tool",
		result: {
			cancelled: false,
			answers: { q: { values: [SECRET_ANSWER] } },
			...result,
		},
		completedAt,
	});

	/** Date is faked so tool spans and dialog events share one deterministic clock. */
	async function withClock(run: () => Promise<void>) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000_000);
		try {
			await run();
		} finally {
			vi.useRealTimers();
		}
	}
	const at = (offsetMs: number) => 1_000_000 + offsetMs;

	const waitScore = (recorder: LangfuseRecorder, traceId: string) =>
		scoreNamed(recorder, traceId, "ask_user_wait_ms");

	it("measures the open dialog, not tool setup or the whole tool span, and stores no dialog content", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const target = harness.session("ask-dialog");
				await startPrompt(harness, target);
				await startTool(harness, target, "ask-1", "ask_user");
				vi.setSystemTime(at(2_000));
				harness.askEvent("started", started("tool:ask-1", "ask-1", at(2_000)));
				vi.setSystemTime(at(7_000));
				harness.askEvent(
					"completed",
					completed("tool:ask-1", "ask-1", at(7_000)),
				);
				vi.setSystemTime(at(9_000));
				await endTool(harness, target, "ask-1", "ask_user");
				await finishPrompt(harness, target, {
					transcript: [{ toolCallId: "ask-1", isError: false }],
				});
				const trace = onlyTraceId(recorder, "ask-dialog");
				expect(waitScore(recorder, trace)).toEqual([
					expect.objectContaining({ value: 5_000 }),
				]);
				expect(traceMetadata(recorder, trace, "askUserWait")).toMatchObject({
					status: "measured",
					waitMs: 5_000,
					flowCount: 1,
				});
				const promptSpan = exportedSpans(recorder).find(
					(span) => span.name === "agent.prompt" && span.traceId === trace,
				);
				expect(
					attributeString(
						promptSpan as OtlpSpan,
						"langfuse.trace.metadata.askUserWaitStatus",
					),
				).toBe("measured");
				expect(
					attributeString(
						promptSpan as OtlpSpan,
						"langfuse.trace.metadata.askUserWaitMs",
					),
				).toBe("5000");
				expect(toolSpanMetadata(recorder, "ask_user", "durationMs")).toBe(
					9_000,
				);
				expect(toolSpanMetadata(recorder, "ask_user", "askUserWait")).toEqual({
					status: "measured",
					waitMs: 5_000,
					flowCount: 1,
					incompleteFlowCount: 0,
					ambiguousFlowCount: 0,
					cancelledFlowCount: 0,
					flows: [
						{
							flowId: "tool:ask-1",
							source: "tool",
							status: "measured",
							durationMs: 5_000,
							cancelled: false,
						},
					],
				});
				const everything = JSON.stringify(recorder.records);
				expect(everything).not.toContain(SECRET_QUESTION);
				expect(everything).not.toContain(SECRET_ANSWER);
			});
		});
	});

	it("keeps cancelled dialogs measured and labels the cancellation", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const target = harness.session("ask-cancel");
				await startPrompt(harness, target);
				await startTool(harness, target, "ask-1", "ask_user");
				harness.askEvent("started", started("tool:ask-1", "ask-1", at(100)));
				harness.askEvent(
					"completed",
					completed("tool:ask-1", "ask-1", at(1_600), {
						cancelled: true,
						cancelReason: "aborted",
					}),
				);
				await endTool(harness, target, "ask-1", "ask_user", true);
				await finishPrompt(harness, target);
				const trace = onlyTraceId(recorder, "ask-cancel");
				expect(waitScore(recorder, trace)).toEqual([
					expect.objectContaining({ value: 1_500 }),
				]);
				expect(
					toolSpanMetadata(recorder, "ask_user", "askUserWait"),
				).toMatchObject({
					status: "measured",
					cancelledFlowCount: 1,
					flows: [
						expect.objectContaining({
							cancelled: true,
							cancelReason: "aborted",
						}),
					],
				});
			});
		});
	});

	it("separates a measured zero from missing or incomplete instrumentation", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const run = async (
					name: string,
					events: Array<() => void>,
				): Promise<string> => {
					const target = harness.session(name);
					await startPrompt(harness, target);
					await startTool(harness, target, `${name}-call`, "ask_user");
					for (const event of events) event();
					await endTool(harness, target, `${name}-call`, "ask_user");
					await finishPrompt(harness, target);
					return onlyTraceId(recorder, name);
				};
				const flow = (name: string) => `tool:${name}-call`;
				const call = (name: string) => `${name}-call`;

				const none = await run("ask-none", []);
				const zero = await run("ask-zero", [
					() =>
						harness.askEvent(
							"started",
							started(flow("ask-zero"), call("ask-zero"), at(50)),
						),
					() =>
						harness.askEvent(
							"completed",
							completed(flow("ask-zero"), call("ask-zero"), at(50)),
						),
				]);
				const noEnd = await run("ask-no-end", [
					() =>
						harness.askEvent(
							"started",
							started(flow("ask-no-end"), call("ask-no-end"), at(50)),
						),
				]);
				const noStart = await run("ask-no-start", [
					() =>
						harness.askEvent(
							"completed",
							completed(flow("ask-no-start"), call("ask-no-start"), at(900)),
						),
				]);
				const backwards = await run("ask-backwards", [
					() =>
						harness.askEvent(
							"started",
							started(flow("ask-backwards"), call("ask-backwards"), at(900)),
						),
					() =>
						harness.askEvent(
							"completed",
							completed(flow("ask-backwards"), call("ask-backwards"), at(100)),
						),
				]);
				const malformed = await run("ask-malformed", [
					() => harness.askEvent("started", { version: 2, flowId: "x" }),
					() => harness.askEvent("started", null),
					() => harness.askEvent("completed", { version: 1, flowId: 7 }),
				]);

				expect(traceMetadata(recorder, none, "askUserWait")).toBeUndefined();
				expect(waitScore(recorder, none)).toEqual([]);
				expect(waitScore(recorder, zero)).toEqual([
					expect.objectContaining({ value: 0 }),
				]);
				expect(traceMetadata(recorder, zero, "askUserWait")).toMatchObject({
					status: "measured",
					waitMs: 0,
				});
				for (const trace of [noEnd, noStart, backwards]) {
					expect(waitScore(recorder, trace)).toEqual([]);
					expect(traceMetadata(recorder, trace, "askUserWait")).toMatchObject({
						status: "incomplete",
						incompleteFlowCount: 1,
					});
				}
				expect(waitScore(recorder, malformed)).toEqual([]);
				expect(
					traceMetadata(recorder, malformed, "askUserWait"),
				).toBeUndefined();
			});
		});
	});

	it("deduplicates repeated events and counts overlapping flows once", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const target = harness.session("ask-overlap");
				await startPrompt(harness, target);
				await startTool(harness, target, "ask-1", "ask_user");
				await startTool(harness, target, "ask-2", "ask_user");
				// Flow one covers 2000-8000 and flow two 5000-11000: the union is 9000.
				harness.askEvent("started", started("tool:ask-1", "ask-1", at(2_000)));
				harness.askEvent("started", started("tool:ask-2", "ask-2", at(5_000)));
				// Repeats, with different times, must not move recorded boundaries.
				harness.askEvent("started", started("tool:ask-1", "ask-1", at(2_000)));
				harness.askEvent("started", started("tool:ask-1", "ask-1", at(3_000)));
				harness.askEvent(
					"completed",
					completed("tool:ask-1", "ask-1", at(8_000)),
				);
				harness.askEvent(
					"completed",
					completed("tool:ask-1", "ask-1", at(8_500)),
				);
				// The second flow's completion arrives before its start was reordered in.
				harness.askEvent(
					"completed",
					completed("tool:ask-2", "ask-2", at(11_000)),
				);
				harness.askEvent("started", started("tool:ask-2", "ask-2", at(5_000)));
				// A flow that never reaches the tool (e.g. /answer) has no tool call id.
				harness.askEvent("started", started("flow:answer-1", undefined, at(0)));
				harness.askEvent(
					"completed",
					completed("flow:answer-1", undefined, at(60_000)),
				);
				await endTool(harness, target, "ask-1", "ask_user");
				await endTool(harness, target, "ask-2", "ask_user");
				await finishPrompt(harness, target);
				const trace = onlyTraceId(recorder, "ask-overlap");
				expect(waitScore(recorder, trace)).toEqual([
					expect.objectContaining({ value: 9_000 }),
				]);
				expect(traceMetadata(recorder, trace, "askUserWait")).toMatchObject({
					status: "measured",
					waitMs: 9_000,
					flowCount: 2,
				});
			});
		});
	});

	it("keeps missing or invalid timestamps unknown instead of using receipt time", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const run = async (
					name: string,
					events: Array<() => void>,
				): Promise<string> => {
					const target = harness.session(name);
					await startPrompt(harness, target);
					await startTool(harness, target, `${name}-call`, "ask_user");
					for (const event of events) event();
					vi.setSystemTime(at(5_000));
					await endTool(harness, target, `${name}-call`, "ask_user");
					await finishPrompt(harness, target);
					vi.setSystemTime(at(0));
					return onlyTraceId(recorder, name);
				};
				const flowOf = (name: string) => `tool:${name}-call`;
				const callOf = (name: string) => `${name}-call`;
				const pair = (
					name: string,
					startedAt: unknown,
					completedAt: unknown,
				) => [
					() =>
						harness.askEvent("started", {
							...started(flowOf(name), callOf(name), 0),
							createdAt: startedAt,
						}),
					() =>
						harness.askEvent("completed", {
							...completed(flowOf(name), callOf(name), 0),
							completedAt,
						}),
				];
				const incomplete = async (
					name: string,
					start: unknown,
					end: unknown,
				) => {
					const trace = await run(name, pair(name, start, end));
					expect(waitScore(recorder, trace)).toEqual([]);
					expect(traceMetadata(recorder, trace, "askUserWait")).toMatchObject({
						status: "incomplete",
						incompleteFlowCount: 1,
					});
					expect(
						toolSpanMetadata(recorder, "ask_user", "askUserWait"),
					).toBeDefined();
				};

				await incomplete("ask-absent", undefined, undefined);
				await incomplete("ask-nan", Number.NaN, Number.NaN);
				await incomplete("ask-infinite", Number.NEGATIVE_INFINITY, Infinity);
				await incomplete("ask-text", "1000100", null);
				await incomplete("ask-start-only", at(10), undefined);
				await incomplete("ask-end-only", undefined, at(10));

				// A later valid repeat supplies the boundary a first invalid event lacked.
				const name = "ask-recovered";
				const recovered = await run(name, [
					...pair(name, Number.NaN, undefined),
					...pair(name, at(100), at(600)),
					...pair(name, at(300), at(900)),
				]);
				expect(waitScore(recorder, recovered)).toEqual([
					expect.objectContaining({ value: 500 }),
				]);
			});
		});
	});

	it("does not attribute a flow whose tool call id is active in several sessions", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const first = harness.session("ask-ambiguous-a");
				const second = harness.session("ask-ambiguous-b");
				const third = harness.session("ask-unique-c");
				for (const target of [first, second, third]) {
					await startPrompt(harness, target);
				}
				await startTool(harness, first, "shared-call", "ask_user");
				await startTool(harness, second, "shared-call", "ask_user");
				await startTool(harness, third, "own-call", "ask_user");
				harness.askEvent(
					"started",
					started("tool:shared-call", "shared-call", at(100)),
				);
				harness.askEvent(
					"completed",
					completed("tool:shared-call", "shared-call", at(900)),
				);
				harness.askEvent(
					"started",
					started("tool:own-call", "own-call", at(200)),
				);
				harness.askEvent(
					"completed",
					completed("tool:own-call", "own-call", at(1_200)),
				);
				for (const [target, call] of [
					[first, "shared-call"],
					[second, "shared-call"],
					[third, "own-call"],
				] as const) {
					await endTool(harness, target, call, "ask_user");
					await finishPrompt(harness, target);
				}
				for (const id of ["ask-ambiguous-a", "ask-ambiguous-b"]) {
					const trace = onlyTraceId(recorder, id);
					expect(waitScore(recorder, trace)).toEqual([]);
					expect(traceMetadata(recorder, trace, "askUserWait")).toMatchObject({
						status: "ambiguous",
						ambiguousFlowCount: 1,
						flowCount: 0,
					});
				}
				const unique = onlyTraceId(recorder, "ask-unique-c");
				expect(waitScore(recorder, unique)).toEqual([
					expect.objectContaining({ value: 1_000 }),
				]);
			});
		});
	});

	it("marks both sessions ambiguous when the colliding tool call starts after the first flow event", async () => {
		await withClock(async () => {
			await withHarness(async (harness, recorder) => {
				const first = harness.session("ask-staggered-a");
				const second = harness.session("ask-staggered-b");
				const third = harness.session("ask-staggered-unique");
				for (const target of [first, second, third]) {
					await startPrompt(harness, target);
				}
				await startTool(harness, first, "shared-call", "ask_user");
				await startTool(harness, third, "own-call", "ask_user");
				// Only the first session holds the id, so its start event is unique so far.
				harness.askEvent(
					"started",
					started("tool:shared-call", "shared-call", at(100)),
				);
				// The second session now reuses the id: its start and completion
				// cannot be told apart from the first session's flow.
				await startTool(harness, second, "shared-call", "ask_user");
				harness.askEvent(
					"started",
					started("tool:shared-call", "shared-call", at(500)),
				);
				harness.askEvent(
					"completed",
					completed("tool:shared-call", "shared-call", at(900)),
				);
				// An unrelated unique flow still measures, with repeats deduplicated.
				harness.askEvent(
					"started",
					started("tool:own-call", "own-call", at(200)),
				);
				harness.askEvent(
					"started",
					started("tool:own-call", "own-call", at(250)),
				);
				harness.askEvent(
					"completed",
					completed("tool:own-call", "own-call", at(1_200)),
				);
				for (const [target, call] of [
					[first, "shared-call"],
					[second, "shared-call"],
					[third, "own-call"],
				] as const) {
					await endTool(harness, target, call, "ask_user");
					await finishPrompt(harness, target);
				}
				for (const id of ["ask-staggered-a", "ask-staggered-b"]) {
					const trace = onlyTraceId(recorder, id);
					expect(waitScore(recorder, trace)).toEqual([]);
					expect(traceMetadata(recorder, trace, "askUserWait")).toMatchObject({
						status: "ambiguous",
						ambiguousFlowCount: 1,
					});
				}
				// The second session never observed a flow of its own.
				expect(
					traceMetadata(
						recorder,
						onlyTraceId(recorder, "ask-staggered-b"),
						"askUserWait",
					),
				).toMatchObject({ flowCount: 0 });
				const unique = onlyTraceId(recorder, "ask-staggered-unique");
				expect(waitScore(recorder, unique)).toEqual([
					expect.objectContaining({ value: 1_000 }),
				]);
			});
		});
	});
});
