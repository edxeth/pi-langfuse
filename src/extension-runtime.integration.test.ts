import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "./index.js";
import { shutdownClient } from "./langfuse-client.js";
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

function exportedScores(bodies: string[]) {
	return bodies.flatMap((body) => {
		const payload = parsePayload(body);
		return (payload?.batch ?? [])
			.filter((item) => item.type === "score-create" && item.body)
			.map((item) => item.body as Record<string, unknown>);
	});
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
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				bodies.push(Buffer.concat(chunks).toString("utf8"));
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
				attributeString(firstGeneration, "langfuse.observation.output"),
			).toBe("streamed answer");
			expect(
				attributeString(
					firstGeneration,
					"langfuse.observation.metadata.thinking",
				),
			).toBe("thinking ");
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
			expect(exportedScores(bodies)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "input_tokens",
						value: 4,
						traceId: promptSpan.traceId,
						observationId: firstGeneration.spanId,
					}),
					expect.objectContaining({
						name: "output_tokens",
						value: 6,
						traceId: promptSpan.traceId,
						observationId: firstGeneration.spanId,
					}),
					expect.objectContaining({
						name: "total_cost",
						value: 0.1,
						traceId: promptSpan.traceId,
						observationId: firstGeneration.spanId,
					}),
				]),
			);
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
