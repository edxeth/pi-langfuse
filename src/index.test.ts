import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "./index.js";

type ExtensionArg = Parameters<typeof registerExtension>[0];
type EventHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;

describe("index (extension entry)", () => {
	const mockPi = {
		events: {
			on: vi.fn(),
			emit: vi.fn(),
		},
		on: vi.fn(),
		registerCommand: vi.fn(),
		model: { id: "test-model", provider: "test-provider" },
	};

	beforeEach(() => {
		vi.resetAllMocks();
		mockPi.events.emit.mockImplementation(() => undefined);
		delete process.env.PI_LANGFUSE_RAW_TRACE;
		delete process.env.PI_LANGFUSE_RAW_TRACE_DIR;
		delete process.env.PI_LANGFUSE_REDACTION_SECRETS;
		delete process.env.PI_LANGFUSE_SKIP_UNPERSISTED;
		delete process.env.PI_LANGFUSE_RAW_PROVIDER_REQUEST;
		delete process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD;
		delete process.env.PI_LANGFUSE_CAPTURE_POLICY;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(async () => {
		const sessionShutdownCall = mockPi.on.mock.calls.find(
			(call) => call[0] === "session_shutdown",
		);
		if (sessionShutdownCall) {
			await (sessionShutdownCall[1] as EventHandler)({}, undefined);
		}
	});

	async function captureRawProviderRequestRecords(options: {
		mode?: "full" | "off";
		messages?: Array<Record<string, unknown>>;
		contextMessages?: Array<{ role: string; content: unknown }>;
		payload?: unknown;
		drive?: (
			send: (eventName: string, event: unknown) => Promise<void>,
		) => Promise<void>;
	}) {
		const rawTraceDir = mkdtempSync(join(tmpdir(), "pi-langfuse-index-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(
			join(tmpdir(), "pi-langfuse-agent-test-"),
		);
		process.env.PI_LANGFUSE_RAW_TRACE = "1";
		process.env.PI_LANGFUSE_RAW_TRACE_DIR = rawTraceDir;
		process.env.PI_LANGFUSE_SKIP_UNPERSISTED = "0";
		if (options.mode) {
			process.env.PI_LANGFUSE_RAW_PROVIDER_REQUEST = options.mode;
		}

		mockPi.events.emit.mockImplementation((event, probe) => {
			if (event === "extension:settings:get") {
				probe.values = {
					enabled: false,
					"redaction-enabled": true,
				};
			}
		});

		await registerExtension(mockPi as unknown as ExtensionArg);
		const getHandler = (eventName: string) => {
			const call = mockPi.on.mock.calls.find((item) => item[0] === eventName);
			if (!call) throw new Error(`${eventName} handler not registered`);
			return call[1] as EventHandler;
		};

		await getHandler("before_agent_start")(
			{
				prompt: "Patch it",
				systemPrompt: "You are Pi",
				systemPromptOptions: { cwd: "/tmp/work" },
			},
			{
				model: { id: "test-model", provider: "test-provider" },
				sessionManager: { getSessionFile: () => sessionFile },
			},
		);
		await getHandler("turn_start")({ turnIndex: 0 });
		if (options.contextMessages) {
			await getHandler("context")({ messages: options.contextMessages });
		}
		const send = async (eventName: string, event: unknown) => {
			await getHandler(eventName)(event);
		};
		if (options.drive) {
			await options.drive(send);
		} else {
			await send("before_provider_request", {
				payload: options.payload ?? {
					model: "test-model",
					messages: options.messages ?? [],
				},
			});
		}

		return readFileSync(join(rawTraceDir, "--work--", "session.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("should update state on session_start", async () => {
		await registerExtension(mockPi as unknown as ExtensionArg);

		// Find the session_start handler
		const sessionStartCall = mockPi.on.mock.calls.find(
			(call) => call[0] === "session_start",
		);
		expect(sessionStartCall).toBeDefined();
		if (!sessionStartCall)
			throw new Error("session_start handler not registered");
		const sessionStartHandler = sessionStartCall[1] as EventHandler;

		const mockCtx = {
			sessionManager: {
				getSessionFile: () => "/path/to/test-session.jsonl",
			},
		};

		await sessionStartHandler({ reason: "test-reason" }, mockCtx);
		// Internal state isn't exported, but we can verify it doesn't throw and
		// we could potentially verify downstream effects if we mocked more.
	});

	it("should show Langfuse status in the footer status line on session_start", async () => {
		mockPi.events.emit.mockImplementation((event, probe) => {
			if (event === "extension:settings:get") {
				probe.values = {
					enabled: true,
					"public-key": "pk-test",
					"secret-key": "sk-test",
					"base-url": "http://localhost:3100",
				};
			}
		});
		await registerExtension(mockPi as unknown as ExtensionArg);

		const sessionStartCall = mockPi.on.mock.calls.find(
			(call) => call[0] === "session_start",
		);
		if (!sessionStartCall)
			throw new Error("session_start handler not registered");
		const sessionStartHandler = sessionStartCall[1] as EventHandler;
		const setStatus = vi.fn();

		await sessionStartHandler(
			{ reason: "test-reason" },
			{
				ui: { setStatus },
				sessionManager: {
					getSessionFile: () => "/path/to/test-session.jsonl",
				},
			},
		);

		expect(setStatus).toHaveBeenCalledWith("pi-langfuse:status", "Langfuse 🟢");
	});

	it("does not print when tracing is disabled", async () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		mockPi.events.emit.mockImplementation((event, probe) => {
			if (event === "extension:settings:get") {
				probe.values = { enabled: false };
			}
		});

		await registerExtension(mockPi as unknown as ExtensionArg);

		expect(consoleLog).not.toHaveBeenCalledWith(
			"📊 Langfuse: Tracing disabled in extension settings",
		);
		consoleLog.mockRestore();
	});

	it("sanitizes raw traces at the extension event boundary", async () => {
		const rawTraceDir = mkdtempSync(join(tmpdir(), "pi-langfuse-index-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(
			join(tmpdir(), "pi-langfuse-agent-test-"),
		);
		process.env.PI_LANGFUSE_RAW_TRACE = "1";
		process.env.PI_LANGFUSE_RAW_TRACE_DIR = rawTraceDir;
		process.env.PI_LANGFUSE_REDACTION_SECRETS = "custom-super-secret-987654321";
		process.env.PI_LANGFUSE_SKIP_UNPERSISTED = "0";

		mockPi.events.emit.mockImplementation((event, probe) => {
			if (event === "extension:settings:get") {
				probe.values = {
					enabled: false,
					"redaction-enabled": true,
				};
			}
		});

		await registerExtension(mockPi as unknown as ExtensionArg);
		const beforeAgentStartCall = mockPi.on.mock.calls.find(
			(call) => call[0] === "before_agent_start",
		);
		if (!beforeAgentStartCall)
			throw new Error("before_agent_start handler not registered");
		const beforeAgentStartHandler = beforeAgentStartCall[1] as EventHandler;

		await beforeAgentStartHandler(
			{
				prompt:
					"Use sk-lf-live-secret-1234567890 and custom-super-secret-987654321",
				systemPrompt: "LANGFUSE_SECRET_KEY=sk-lf-live-secret-1234567890",
				systemPromptOptions: { cwd: "/tmp/work" },
			},
			{
				model: { id: "test-model", provider: "test-provider" },
				sessionManager: { getSessionFile: () => sessionFile },
			},
		);

		const expectedPath = join(rawTraceDir, "--work--", "session.jsonl");
		if (!existsSync(expectedPath)) {
			throw new Error(
				`raw trace not written; entries=${readdirSync(rawTraceDir)}`,
			);
		}
		const content = readFileSync(expectedPath, "utf-8");
		expect(content).not.toContain("sk-lf-live-secret-1234567890");
		expect(content).not.toContain("custom-super-secret-987654321");
		expect(content).toContain("[REDACTED:langfuse-secret-key:");
		expect(content).toContain("[REDACTED:configured-secret:");
	});

	it("writes provider_request summaries by default in raw traces", async () => {
		const messages = [
			{ role: "system", content: "You are Pi" },
			{ role: "user", content: "Patch it" },
			{
				role: "tool_result",
				content: "very large output that should not be copied in full",
			},
		];
		const records = await captureRawProviderRequestRecords({ messages });
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			type: "provider_request",
			captureMode: "summary",
			messageCount: 3,
			fullMessagesOmitted: true,
		});
		expect(providerRequest).not.toHaveProperty("messages");
		expect(providerRequest?.messagesSummary).toEqual(messages);
		expect(typeof providerRequest?.estimatedBytes).toBe("number");
	});

	it("keeps full provider_request messages when explicitly enabled", async () => {
		const messages = [
			{ role: "system", content: "You are Pi" },
			{ role: "user", content: "Patch it" },
			{ role: "tool_result", content: "exact tool output" },
		];
		const records = await captureRawProviderRequestRecords({
			mode: "full",
			messages,
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			type: "provider_request",
			captureMode: "full",
			messages,
		});
		expect(providerRequest).not.toHaveProperty("messagesSummary");
	});

	it("omits provider_request records when explicitly disabled", async () => {
		const records = await captureRawProviderRequestRecords({
			mode: "off",
			messages: [{ role: "user", content: "Patch it" }],
		});

		expect(records.some((record) => record.type === "provider_request")).toBe(
			false,
		);
		expect(records.some((record) => record.type === "agent_prompt_start")).toBe(
			true,
		);
	});

	it("attributes Responses provider_request records to the payload input instead of the context fallback", async () => {
		const input = [
			{ role: "system", content: "INPUT-system prompt" },
			{
				role: "user",
				content: [{ type: "input_text", text: "INPUT-user turn" }],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "read",
				arguments: '{"path":"/tmp/tool-args"}',
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: "tool output",
			},
			{ type: "reasoning", summary: [] },
		];
		const records = await captureRawProviderRequestRecords({
			contextMessages: [
				{ role: "system", content: "CTX-system prompt" },
				{ role: "user", content: "CTX-user turn" },
			],
			payload: { model: "grok-4.7", input, stream: true },
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			type: "provider_request",
			captureMode: "summary",
			requestSource: "payload.input",
			messageCount: 5,
			fullMessagesOmitted: true,
		});
		const summaryJson = JSON.stringify(providerRequest?.messagesSummary);
		expect(summaryJson).toContain("INPUT-");
		expect(summaryJson).not.toContain("CTX-");
		// Tool and reasoning contents are not expanded into the summary.
		expect(summaryJson).not.toContain("/tmp/tool-args");
		expect(summaryJson).not.toContain("tool output");
	});

	it("attributes string-shaped Responses input records to the payload input", async () => {
		const records = await captureRawProviderRequestRecords({
			payload: { model: "grok-4.7", input: "STRING-plain prompt" },
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			requestSource: "payload.input",
			messageCount: 1,
			fullMessagesOmitted: true,
		});
		const summaryJson = JSON.stringify(providerRequest?.messagesSummary);
		expect(summaryJson).toContain("STRING-plain prompt");
		expect(providerRequest?.messagesSummary).toEqual([
			{ role: "user", content: "STRING-plain prompt" },
		]);
	});

	it("never presents the context fallback as a captured wire request", async () => {
		const contextMessages = [{ role: "user", content: "CTX-context only" }];

		const summaryRecords = await captureRawProviderRequestRecords({
			contextMessages,
			payload: { model: "test-model" },
		});
		const summaryRecord = summaryRecords.find(
			(record) => record.type === "provider_request",
		);
		expect(summaryRecord?.requestSource).toBe("context");
		// Wire metrics are only set for contents observed in the payload; the
		// fallback is a diagnostic summary of earlier context.
		expect(summaryRecord?.messageCount).toBeUndefined();
		expect(summaryRecord).not.toHaveProperty("estimatedBytes");
		expect(summaryRecord).not.toHaveProperty("fullMessagesOmitted");
		expect(JSON.stringify(summaryRecord?.messagesSummary)).toContain(
			"CTX-context only",
		);

		const fullRecords = await captureRawProviderRequestRecords({
			mode: "full",
			contextMessages,
			payload: { model: "test-model" },
		});
		const fullRecord = fullRecords.find(
			(record) => record.type === "provider_request",
		);
		expect(fullRecord?.requestSource).toBe("context");
		expect(fullRecord).not.toHaveProperty("messages");
		expect(fullRecord?.messageCount).toBeUndefined();
		expect(fullRecord).not.toHaveProperty("estimatedBytes");
	});

	it("records unknown payloads without provenance or wire metrics", async () => {
		const records = await captureRawProviderRequestRecords({
			payload: { model: "test-model", temperature: 0.5 },
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			type: "provider_request",
			captureMode: "summary",
		});
		// No recognizable contents and no context: the record claims no source,
		// no wire metrics, no captured or summarized contents, and — with
		// payload capture disabled — no payload summary text.
		expect(providerRequest?.requestSource).toBeUndefined();
		expect(providerRequest?.messageCount).toBeUndefined();
		expect(providerRequest).not.toHaveProperty("estimatedBytes");
		expect(providerRequest).not.toHaveProperty("fullMessagesOmitted");
		expect(providerRequest).not.toHaveProperty("payloadSummary");
		expect(providerRequest?.messagesSummary).toBeUndefined();
	});

	it("records the request model from the payload, falling back to the session model", async () => {
		const records = await captureRawProviderRequestRecords({
			drive: async (send) => {
				await send("before_provider_request", {
					payload: {
						model: "grok-4.7",
						messages: [{ role: "user", content: "PAYLOAD-MODEL request" }],
					},
				});
				await send("before_provider_request", {
					payload: {
						messages: [{ role: "user", content: "SESSION-MODEL request" }],
					},
				});
			},
		});
		const providerRequests = records.filter(
			(record) => record.type === "provider_request",
		);

		expect(providerRequests).toHaveLength(2);
		// The payload model wins; without one, the session model is recorded.
		expect(providerRequests[0]?.model).toBe("grok-4.7");
		expect(providerRequests[1]?.model).toBe("test-model");
	});

	it("ignores provider requests that reference an unknown turn", async () => {
		const records = await captureRawProviderRequestRecords({
			drive: async (send) => {
				await send("before_provider_request", {
					turnIndex: 9,
					payload: {
						model: "test-model",
						messages: [{ role: "user", content: "ORPHAN request" }],
					},
				});
			},
		});

		expect(
			records.filter((record) => record.type === "provider_request"),
		).toHaveLength(0);
	});

	it("carries the bounded payload summary when payload capture is enabled", async () => {
		process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD = "1";
		const records = await captureRawProviderRequestRecords({
			messages: [{ role: "user", content: "SUMMARY-payload marker" }],
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			payloadCaptured: true,
			requestSource: "payload.messages",
			messageCount: 1,
		});
		const payloadSummary = String(providerRequest?.payloadSummary);
		expect(payloadSummary).toContain("SUMMARY-payload marker");
	});

	it("applies tool-output capture policy to flattened provider summaries", async () => {
		process.env.PI_LANGFUSE_CAPTURE_POLICY = "conversations";
		process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD = "1";
		const records = await captureRawProviderRequestRecords({
			messages: [
				{ role: "user", content: "POLICY-user turn" },
				{
					role: "tool",
					tool_call_id: "call_1",
					content: "POLICY-tool output",
				},
			],
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		// Both flattened summary strings must exclude tool output: after
		// serialization their internal roles are lost, so the policy has to
		// hold at summary build time.
		const recordJson = JSON.stringify(providerRequest);
		expect(recordJson).not.toContain("POLICY-tool output");
		expect(recordJson).toContain("POLICY-user turn");
	});

	it("does not let a malformed payload interrupt request tracing", async () => {
		const records = await captureRawProviderRequestRecords({
			payload: null,
			drive: async (send) => {
				await send("before_provider_request", {
					payload: {
						model: "hostile-model",
						get messages(): Array<{ role: string; content: string }> {
							throw new Error("malformed payload");
						},
					},
				});
				await send("before_provider_request", {
					payload: {
						model: "test-model",
						messages: [{ role: "user", content: "recovered" }],
					},
				});
			},
		});

		// The malformed payload produced no record; the next request still does.
		const providerRequests = records.filter(
			(record) => record.type === "provider_request",
		);
		expect(providerRequests).toHaveLength(1);
		expect(providerRequests[0]).toMatchObject({
			model: "test-model",
			requestSource: "payload.messages",
			messageCount: 1,
		});
	});

	// Regression: nullish entries inside content arrays crashed payload
	// summarization, and beforeProviderRequest's diagnostic catch silently
	// dropped the whole provider_request record. Recording must survive.
	it("still records provider requests whose content parts include nullish entries", async () => {
		const records = await captureRawProviderRequestRecords({
			drive: async (send) => {
				await send("before_provider_request", {
					payload: {
						model: "test-model",
						messages: [
							{
								role: "user",
								content: [null, { type: "text", text: "NULLISH-chat text" }],
							},
						],
					},
				});
				await send("before_provider_request", {
					payload: {
						model: "test-model",
						input: [
							{
								role: "user",
								content: [
									undefined,
									{
										type: "input_text",
										text: "NULLISH-input text",
									},
								],
							},
						],
					},
				});
			},
		});
		const providerRequests = records.filter(
			(record) => record.type === "provider_request",
		);

		// Each payload still produces its record with the surviving text
		// summarized and provenance and wire metrics intact.
		expect(providerRequests).toHaveLength(2);
		expect(providerRequests[0]).toMatchObject({
			model: "test-model",
			requestSource: "payload.messages",
			messageCount: 1,
		});
		expect(providerRequests[1]).toMatchObject({
			model: "test-model",
			requestSource: "payload.input",
			messageCount: 1,
		});
		const summaries = JSON.stringify(
			providerRequests.map((record) => record.messagesSummary),
		);
		expect(summaries).toContain("NULLISH-chat text");
		expect(summaries).toContain("NULLISH-input text");
	});

	it("captures Responses input items as the wire request in full mode", async () => {
		const input = [
			{ role: "system", content: "INPUT-system prompt" },
			{
				role: "user",
				content: [{ type: "input_text", text: "INPUT-user turn" }],
			},
		];
		const records = await captureRawProviderRequestRecords({
			mode: "full",
			contextMessages: [{ role: "user", content: "CTX-context only" }],
			payload: { model: "grok-4.7", input },
		});
		const providerRequest = records.find(
			(record) => record.type === "provider_request",
		);

		expect(providerRequest).toMatchObject({
			type: "provider_request",
			captureMode: "full",
			requestSource: "payload.input",
			messageCount: 2,
		});
		const messagesJson = JSON.stringify(providerRequest?.messages);
		expect(messagesJson).toContain("INPUT-");
		expect(messagesJson).not.toContain("CTX-");
	});

	it("should update model on model_select", async () => {
		await registerExtension(mockPi as unknown as ExtensionArg);

		const modelSelectCall = mockPi.on.mock.calls.find(
			(call) => call[0] === "model_select",
		);
		expect(modelSelectCall).toBeDefined();
		if (!modelSelectCall)
			throw new Error("model_select handler not registered");
		const modelSelectHandler = modelSelectCall[1] as EventHandler;

		await modelSelectHandler({
			model: { id: "new-model", provider: "new-provider" },
		});
	});
});
