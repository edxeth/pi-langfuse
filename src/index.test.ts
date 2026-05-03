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
		delete process.env.PI_CODING_AGENT_DIR;
	});

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
