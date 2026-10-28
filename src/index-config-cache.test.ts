import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "./index.js";
import { drainRawTraceQueue } from "./raw-trace.js";

// Pass-through spies: every file operation stays real, and the test counts
// how often the configuration file is read.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

type ExtensionArg = Parameters<typeof registerExtension>[0];
type Handler = (event: unknown, ctx?: unknown) => unknown;

const pi = {
	events: { on: vi.fn(), emit: vi.fn() },
	on: vi.fn(),
	registerCommand: vi.fn(),
	model: { id: "test-model", provider: "test-provider" },
};

function handlerFor(event: string): Handler {
	const call = pi.on.mock.calls.find((entry) => entry[0] === event);
	if (!call) throw new Error(`${event} is not registered`);
	return call[1] as Handler;
}

const pinnedConfigPath = process.env.PI_LANGFUSE_CONFIG;
let root = "";
let configPath = "";

function writeConfig(values: Record<string, unknown>) {
	writeFileSync(configPath, JSON.stringify(values));
}

function configReads() {
	return vi
		.mocked(fs.readFileSync)
		.mock.calls.filter(([path]) => path === configPath).length;
}

beforeEach(() => {
	root = mkdtempSync(join(homedir(), "pi-langfuse-config-cache-"));
	configPath = join(root, "pi-langfuse.json");
	process.env.PI_LANGFUSE_CONFIG = configPath;
	// Raw traces only: prompts and turns are tracked without any network.
	writeConfig({
		enabled: false,
		rawTraceEnabled: true,
		rawTraceDir: join(root, "raw"),
	});
	pi.events.on.mockReset();
	pi.events.emit.mockReset();
	pi.events.emit.mockImplementation(
		(event: string, probe: { values?: unknown }) => {
			if (event === "extension:settings:get") probe.values = {};
		},
	);
	pi.on.mockReset();
	pi.registerCommand.mockReset();
	vi.mocked(fs.readFileSync).mockClear();
});

afterEach(async () => {
	const stop = pi.on.mock.calls.find((call) => call[0] === "session_shutdown");
	if (stop) await (stop[1] as Handler)({}, undefined);
	if (pinnedConfigPath === undefined) delete process.env.PI_LANGFUSE_CONFIG;
	else process.env.PI_LANGFUSE_CONFIG = pinnedConfigPath;
	rmSync(root, { recursive: true, force: true });
});

const ctx = () => ({
	hasUI: false,
	sessionManager: {
		getSessionFile: () => join(root, "sessions", "--work--", "session.jsonl"),
	},
});

async function startPrompt(prompt: string) {
	await handlerFor("before_agent_start")(
		{ prompt, systemPrompt: "", systemPromptOptions: { cwd: root } },
		ctx(),
	);
	await handlerFor("agent_start")({}, ctx());
	await handlerFor("turn_start")({ turnIndex: 0 }, ctx());
}

async function streamDeltas(count: number) {
	const message = { role: "assistant", content: [] };
	await handlerFor("message_start")({ message }, ctx());
	for (let index = 0; index < count; index += 1) {
		await handlerFor("message_update")(
			{ message, assistantMessageEvent: { type: "text_delta", delta: "x" } },
			ctx(),
		);
	}
}

describe("configuration reuse across events", () => {
	it("reads the configuration file once per prompt, not once per streamed event", async () => {
		await registerExtension(pi as unknown as ExtensionArg);
		await handlerFor("session_start")({}, ctx());
		await startPrompt("first");
		const readsAtPromptStart = configReads();

		await streamDeltas(200);
		await handlerFor("tool_execution_start")(
			{ toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
			ctx(),
		);
		await handlerFor("tool_execution_end")(
			{
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [] },
				isError: false,
			},
			ctx(),
		);

		expect(configReads() - readsAtPromptStart).toBe(0);
	});

	it("applies a configuration file edit at the next prompt", async () => {
		await registerExtension(pi as unknown as ExtensionArg);
		await handlerFor("session_start")({}, ctx());
		await startPrompt("first");
		await handlerFor("agent_settled")({}, ctx());

		// The edit turns raw traces off; the next prompt must stop writing them.
		writeConfig({ enabled: false, rawTraceEnabled: false });
		const rawFile = join(root, "raw", "--work--", "session.jsonl");
		drainRawTraceQueue();
		const before = fs.readFileSync(rawFile, "utf-8");
		await startPrompt("second");
		drainRawTraceQueue();

		expect(fs.readFileSync(rawFile, "utf-8")).toBe(before);
	});
});
