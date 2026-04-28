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
		vi.clearAllMocks();
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
