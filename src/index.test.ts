import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
		delete process.env.PI_CODING_AGENT_DIR;
	});

	async function captureRawProviderRequestRecords(options: {
		mode?: "full" | "off";
		messages: Array<{ role: string; content: string }>;
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
		await getHandler("before_provider_request")({
			payload: { model: "test-model", messages: options.messages },
		});

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
