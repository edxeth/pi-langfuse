import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_POLICIES } from "./capture-policy.js";
import registerExtension from "./index.js";
import { drainRawTraceQueue } from "./raw-trace.js";
import {
	getLastRuntimeError,
	recordRuntimeError,
} from "./runtime-diagnostics.js";

/**
 * Operator-facing reports and announcements, driven through the registered
 * extension with real settings, the real configuration resolver, and real
 * files: a fresh config file path per test, so a pseudonymous test persists
 * its identity salt in a temporary directory beneath the pinned test home.
 * The resolver always fills the identity and capture-policy fields, so the
 * reports' fallbacks for a configuration without them are not reachable here
 * and have no test.
 */
type ExtensionArg = Parameters<typeof registerExtension>[0];
type Handler = (...args: unknown[]) => unknown;

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

function commandHandler(name: string): Handler {
	const call = pi.registerCommand.mock.calls.find((entry) => entry[0] === name);
	if (!call) throw new Error(`${name} is not registered`);
	return (call[1] as { handler: Handler }).handler;
}

/** Default values the extension published to the settings panel. */
function publishedDefaults(key: string) {
	const registrations = pi.events.emit.mock.calls.filter(
		(call) => call[0] === "pi-extension-settings:register",
	);
	const nodes = registrations.at(-1)?.[1].nodes as Record<
		string,
		{ default: unknown }
	>;
	return nodes[key]?.default;
}

const pinnedConfigPath = process.env.PI_LANGFUSE_CONFIG;
const pinnedPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
const pinnedSecretKey = process.env.LANGFUSE_SECRET_KEY;
let configDir = "";
let settingsValues: Record<string, unknown> = {};

/** Back to the value the test bootstrap pinned, which may be absent. */
function restoreEnv(key: string, pinned: string | undefined) {
	if (pinned === undefined) delete process.env[key];
	else process.env[key] = pinned;
}

beforeEach(() => {
	configDir = mkdtempSync(join(homedir(), "pi-langfuse-reports-"));
	process.env.PI_LANGFUSE_CONFIG = join(configDir, "pi-langfuse.json");
	settingsValues = { enabled: false };
	pi.events.on.mockReset();
	pi.events.emit.mockReset();
	pi.events.emit.mockImplementation(
		(event: string, probe: { values?: unknown }) => {
			if (event === "extension:settings:get") probe.values = settingsValues;
		},
	);
	pi.on.mockReset();
	pi.registerCommand.mockReset();
});

afterEach(async () => {
	const stop = pi.on.mock.calls.find((call) => call[0] === "session_shutdown");
	if (stop) await (stop[1] as Handler)({}, undefined);
	restoreEnv("PI_LANGFUSE_CONFIG", pinnedConfigPath);
	restoreEnv("LANGFUSE_PUBLIC_KEY", pinnedPublicKey);
	restoreEnv("LANGFUSE_SECRET_KEY", pinnedSecretKey);
	rmSync(configDir, { recursive: true, force: true });
});

async function privacyReportFor(values: Record<string, unknown> = {}) {
	settingsValues = { ...settingsValues, ...values };
	await registerExtension(pi as unknown as ExtensionArg);
	const notify = vi.fn();
	await commandHandler("langfuse-privacy")("show", { ui: { notify } });
	expect(notify).toHaveBeenCalledTimes(1);
	return String(notify.mock.calls[0]?.[0]);
}

describe("/langfuse-privacy report", () => {
	it("reports the default capture policy and raw identity", async () => {
		const report = await privacyReportFor();

		expect(report).toContain("Capture policy: full-debug");
		expect(report.split("\n")).toContain("Identity: raw");
	});

	it("reports an invalid identity setting as blocking telemetry and raw traces", async () => {
		const report = await privacyReportFor({ "identity-mode": "typo" });

		expect(report).toContain(
			"Identity: blocked, telemetry and raw traces are off (identity-mode setting must be one of raw, pseudonymous)",
		);
	});

	it.each([
		[true, "kept"],
		[false, "hashed"],
	])(
		"reports pseudonymous identity with repository identity kept=%s",
		async (keep, word) => {
			const report = await privacyReportFor({
				"identity-mode": "pseudonymous",
				"identity-keep-repo": keep,
			});

			expect(report).toContain(
				`Identity: pseudonymous (repository identity ${word}); reduces direct identifiers, not anonymization`,
			);
		},
	);
});

describe("settings panel defaults", () => {
	it("publishes raw identity with repository identity hidden", async () => {
		await registerExtension(pi as unknown as ExtensionArg);

		expect(publishedDefaults("identity-mode")).toBe("raw");
		expect(publishedDefaults("identity-keep-repo")).toBe(false);
	});

	it("publishes the configured identity fields", async () => {
		settingsValues = {
			...settingsValues,
			"identity-mode": "pseudonymous",
			"identity-keep-repo": true,
		};

		await registerExtension(pi as unknown as ExtensionArg);

		expect(publishedDefaults("identity-mode")).toBe("pseudonymous");
		expect(publishedDefaults("identity-keep-repo")).toBe(true);
	});
});

describe("configuration announcements at session start", () => {
	const ctx = {
		hasUI: false,
		sessionManager: { getSessionFile: () => "/tmp/announce/session.jsonl" },
	};

	async function announce(values: Record<string, unknown>) {
		settingsValues = { ...settingsValues, ...values };
		await registerExtension(pi as unknown as ExtensionArg);
		// A leftover error from an earlier test must not satisfy an assertion.
		recordRuntimeError("before announcement");
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await handlerFor("session_start")({ reason: "test" }, ctx);
		vi.restoreAllMocks();
		return getLastRuntimeError()?.message;
	}

	const MISSING_KEYS =
		"Configure Langfuse public/secret key in settings, pi-langfuse.json, or LANGFUSE_* env vars to enable tracing";

	it.each([
		["public", { "public-key": "", "secret-key": "sk-present" }],
		["secret", { "public-key": "pk-present", "secret-key": "" }],
	])(
		"announces tracing that is on but missing its %s key",
		async (_name, keys) => {
			// The pinned synthetic environment credentials would fill a blank key.
			delete process.env.LANGFUSE_PUBLIC_KEY;
			delete process.env.LANGFUSE_SECRET_KEY;

			expect(await announce({ enabled: true, ...keys })).toBe(MISSING_KEYS);
		},
	);

	it("announces an invalid identity setting even while tracing is off", async () => {
		expect(await announce({ enabled: false, "identity-mode": "typo" })).toBe(
			"Identity configuration blocks telemetry and raw traces: identity-mode setting must be one of raw, pseudonymous",
		);
	});
});

/** A command context whose notifications are recorded with their level. */
function commandContext(extra: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; level: unknown }> = [];
	const ctx = {
		ui: {
			notify: (message: string, level?: unknown) =>
				notifications.push({ message, level }),
		},
		sessionManager: { getSessionFile: () => undefined },
		isIdle: () => true,
		...extra,
	};
	return { ctx, notifications };
}

describe("/langfuse:toggle", () => {
	it.each([
		["an explicit on", "on", false, "Langfuse tracing enabled → "],
		[
			"no argument while tracing is off",
			"",
			false,
			"Langfuse tracing enabled → ",
		],
		["no argument while tracing is on", "", true, "Langfuse tracing disabled"],
		[
			"an explicit off while tracing is on",
			"off",
			true,
			"Langfuse tracing disabled",
		],
	])("applies %s", async (_name, args, enabledBefore, expected) => {
		settingsValues = {
			enabled: enabledBefore,
			"base-url": "http://127.0.0.1:9",
		};
		await registerExtension(pi as unknown as ExtensionArg);
		const { ctx, notifications } = commandContext();

		await commandHandler("langfuse:toggle")(args, ctx);

		const last = notifications.at(-1);
		expect(last?.level).toBe("info");
		expect(last?.message).toContain(expected);
		if (expected.endsWith("→ "))
			expect(last?.message).toContain("http://127.0.0.1:9");
	});
});

describe("/langfuse-status", () => {
	it.each([
		["idle", true, "active run: no"],
		["busy", false, "active run: yes"],
	])(
		"reports a %s Pi without a tracked prompt",
		async (_name, idle, expected) => {
			await registerExtension(pi as unknown as ExtensionArg);
			const { ctx, notifications } = commandContext({ isIdle: () => idle });

			await commandHandler("langfuse-status")("", ctx);

			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.message.split("\n")).toContain(expected);
		},
	);
});

describe("/langfuse-privacy arguments", () => {
	it("names the valid policies for an unknown argument and changes nothing", async () => {
		await registerExtension(pi as unknown as ExtensionArg);
		const { ctx, notifications } = commandContext();

		await commandHandler("langfuse-privacy")("bogus", ctx);
		await commandHandler("langfuse-privacy")("show", ctx);

		expect(notifications[0]).toEqual({
			message: `Usage: /langfuse-privacy [${CAPTURE_POLICIES.join("|")}]`,
			level: "warning",
		});
		expect(notifications[1]?.message).toContain("Capture policy: full-debug");
	});

	it("reports a failed refresh with the secret masked, after the policy was stored", async () => {
		const secret = "sk-lf-refresh-failure-secret";
		settingsValues = { enabled: false, "secret-key": secret };
		await registerExtension(pi as unknown as ExtensionArg);
		let stale = false;
		const session = commandContext({
			hasUI: false,
			ui: {
				notify: () => undefined,
				setStatus: () => {
					if (stale) throw new Error(`stale context for ${secret}`);
				},
			},
			sessionManager: { getSessionFile: () => "/tmp/refresh-failure/s.jsonl" },
		});
		await handlerFor("session_start")({ reason: "test" }, session.ctx);
		stale = true;
		const command = commandContext();

		await commandHandler("langfuse-privacy")("metadata-only", command.ctx);

		const last = command.notifications.at(-1);
		expect(last?.level).toBe("error");
		expect(last?.message).toContain(
			"Capture policy refresh failed: stale context for ",
		);
		expect(last?.message).not.toContain(secret);
		expect(getLastRuntimeError()?.message).toContain("stale context for ");
	});
});

describe("/langfuse:export notification level", () => {
	const SECRET = "sk-lf-export-secret-1234567890";

	async function exportSummary(content: string) {
		const root = mkdtempSync(join(configDir, "export-"));
		mkdirSync(join(root, "sessions", "--project--"), { recursive: true });
		writeFileSync(
			join(root, "sessions", "--project--", "session.jsonl"),
			`${content}\n`,
		);
		await registerExtension(pi as unknown as ExtensionArg);
		const { ctx, notifications } = commandContext();

		await commandHandler("langfuse:export")(
			`--sessions-only --sessions-dir ${join(root, "sessions")} --out ${join(root, "out")} --no-trufflehog`,
			ctx,
		);

		return notifications.find((item) =>
			item.message.startsWith("Redacted export:"),
		);
	}

	it("stays informational when every file is approved", async () => {
		expect(
			await exportSummary(`{"type":"message","content":"${SECRET}"}`),
		).toEqual({ message: "Redacted export: 1/1 approved", level: "info" });
	});

	it("warns when a file is rejected for a secret that redaction cannot remove", async () => {
		// A secret used as an object key survives value redaction; only the
		// residual scan notices it.
		expect(await exportSummary(`{"${SECRET}":1}`)).toEqual({
			message: "Redacted export: 0/1 approved",
			level: "warning",
		});
	});
});

describe("settings changes", () => {
	it.each([
		"pi-extension-settings:pi-langfuse:changed",
		"extension:settings:changed:pi-langfuse",
	])(
		"drops a command's override when the settings panel reports %s",
		async (eventName) => {
			settingsValues = { enabled: true };
			await registerExtension(pi as unknown as ExtensionArg);
			const { ctx } = commandContext();
			await commandHandler("langfuse:toggle")("off", ctx);
			expect(publishedDefaults("enabled")).toBe(false);
			const listener = pi.events.on.mock.calls.find(
				(call) => call[0] === eventName,
			)?.[1] as Handler | undefined;
			if (!listener) throw new Error(`${eventName} is not listened to`);

			listener();

			await vi.waitFor(() => expect(publishedDefaults("enabled")).toBe(true));
		},
	);
});

describe("session events without a tracked session", () => {
	it("ignores a session start that names no session", async () => {
		settingsValues = { enabled: false, "identity-mode": "typo" };
		await registerExtension(pi as unknown as ExtensionArg);
		// A leftover error from an earlier test must not satisfy the assertion.
		recordRuntimeError("before session start");

		await handlerFor("session_start")({ reason: "test" }, undefined);

		// A started session would announce the invalid identity setting.
		expect(getLastRuntimeError()?.message).toBe("before session start");
	});

	it("writes no raw trace for a session that is not persisted", async () => {
		const rawTraceDir = join(configDir, "raw-traces");
		settingsValues = {
			enabled: false,
			"raw-trace-enabled": true,
			"raw-trace-dir": rawTraceDir,
		};
		await registerExtension(pi as unknown as ExtensionArg);
		const { ctx } = commandContext({
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "unpersisted-session",
			},
		});

		await handlerFor("session_start")({ reason: "startup" }, ctx);
		drainRawTraceQueue();

		expect(readdirSync(configDir)).not.toContain("raw-traces");
	});

	it("accepts a shutdown for a context that never started", async () => {
		await registerExtension(pi as unknown as ExtensionArg);

		await expect(
			handlerFor("session_shutdown")({}, { sessionManager: {} }),
		).resolves.toBeUndefined();
	});

	it("stops notifying a command's Pi UI once an unknown shutdown ends all sessions", async () => {
		await registerExtension(pi as unknown as ExtensionArg);
		const { ctx, notifications } = commandContext({ hasUI: true });
		// The first command remembers the UI; the second one's refresh binds it.
		await commandHandler("langfuse:toggle")("off", ctx);
		await commandHandler("langfuse:toggle")("off", ctx);
		const before = notifications.length;
		recordRuntimeError("failure while the UI is bound");
		expect(notifications.length).toBe(before + 1);

		await handlerFor("session_shutdown")({}, { sessionManager: {} });
		recordRuntimeError("failure after shutdown");

		expect(notifications.length).toBe(before + 1);
	});
});
