import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigFilePath, resolveConfig } from "./config.js";
import { DEFAULT_SETTINGS } from "./settings.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

describe("resolveConfig", () => {
	beforeEach(() => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		// Clear environment variables that might interfere
		delete process.env.LANGFUSE_PUBLIC_KEY;
		delete process.env.LANGFUSE_SECRET_KEY;
		delete process.env.LANGFUSE_BASE_URL;
		delete process.env.LANGFUSE_HOST;
		delete process.env.PI_LANGFUSE_REDACTION;
		delete process.env.PI_LANGFUSE_UNREDACTED;
		delete process.env.PI_LANGFUSE_REDACTION_SECRETS;
		delete process.env.PI_LANGFUSE_RAW_PROVIDER_REQUEST;
		delete process.env.PI_LANGFUSE_CAPTURE_POLICY;
		delete process.env.PI_LANGFUSE_RAW_TRACE;
		delete process.env.PI_LANGFUSE_RAW_TRACE_DIR;
		delete process.env.PI_LANGFUSE_CAPTURE_PROMPT;
		delete process.env.PI_LANGFUSE_CAPTURE_SYSTEM_PROMPT;
		delete process.env.PI_LANGFUSE_CAPTURE_PROVIDER_INPUT;
		delete process.env.PI_LANGFUSE_CAPTURE_ASSISTANT_OUTPUT;
		delete process.env.PI_LANGFUSE_CAPTURE_TOOL_INPUT;
		delete process.env.PI_LANGFUSE_CAPTURE_TOOL_OUTPUT;
		delete process.env.PI_LANGFUSE_CAPTURE_METADATA;
		delete process.env.PI_LANGFUSE_PAYLOAD_MAX_STRING_CHARS;
		delete process.env.PI_LANGFUSE_PAYLOAD_MAX_TOOL_CHARS;
		delete process.env.PI_LANGFUSE_PAYLOAD_MAX_DEPTH;
		delete process.env.PI_LANGFUSE_PAYLOAD_MAX_ARRAY_ITEMS;
		delete process.env.PI_LANGFUSE_PAYLOAD_MAX_OBJECT_KEYS;
		delete process.env.PI_LANGFUSE_PAYLOAD_MAX_NODES;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_LANGFUSE_CONFIG;
		delete process.env.PI_LANGFUSE_EXPORT_LICENSE;
		delete process.env.PI_LANGFUSE_EXPORT_CONSENT;
	});
	it("loads the config file from PI_LANGFUSE_CONFIG when set", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-default";
		process.env.PI_LANGFUSE_CONFIG = "/tmp/custom-dir/pi-langfuse.json";
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockImplementation(((path: unknown) => {
			if (path === "/tmp/custom-dir/pi-langfuse.json") {
				return JSON.stringify({
					publicKey: "pk-custom",
					secretKey: "sk-custom",
					host: "http://localhost:3200",
				});
			}
			return JSON.stringify({ publicKey: "pk-default" });
		}) as never);

		expect(getConfigFilePath()).toBe("/tmp/custom-dir/pi-langfuse.json");
		const config = resolveConfig({});
		expect(config.publicKey).toBe("pk-custom");
		expect(config.secretKey).toBe("sk-custom");
		expect(config.host).toBe("http://localhost:3200");
	});

	it("uses the default config path when PI_LANGFUSE_CONFIG is unset", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-default";

		expect(getConfigFilePath()).toBe(
			"/tmp/agent-default/langfuse/pi-langfuse.json",
		);
	});

	it("should use default settings when no input is provided", () => {
		const config = resolveConfig({});
		expect(config.enabled).toBe(DEFAULT_SETTINGS.enabled);
		expect(config.host).toBe(DEFAULT_SETTINGS["base-url"]);
		expect(config.capturePolicy).toBe("full-debug");
		expect(config.payloadMaxStringChars).toBe(Infinity);
		expect(config.payloadMaxNodes).toBe(Infinity);
	});

	it("should override defaults with settings", () => {
		const config = resolveConfig({
			enabled: false,
			"base-url": "https://custom.langfuse.com",
		});
		expect(config.enabled).toBe(false);
		expect(config.host).toBe("https://custom.langfuse.com");
	});

	it("should parse tags correctly", () => {
		const config = resolveConfig({
			"default-tags": "tag1, tag2, tag3",
		});
		expect(config.defaultTags).toEqual(["tag1", "tag2", "tag3"]);
	});

	it("should clamp numeric values", () => {
		const config = resolveConfig({
			"trace-input-max-chars": 10, // below min (200)
		});
		expect(config.traceInputMaxChars).toBe(200);

		const config2 = resolveConfig({
			"trace-input-max-chars": 50000, // above max (20000)
		});
		expect(config2.traceInputMaxChars).toBe(20000);
	});

	it("enables redaction by default and supports explicit env opt-out", () => {
		expect(resolveConfig({}).redactionEnabled).toBe(true);

		process.env.PI_LANGFUSE_UNREDACTED = "1";
		expect(resolveConfig({}).redactionEnabled).toBe(false);
	});

	it("does not let env unredacted override settings redaction", () => {
		process.env.PI_LANGFUSE_UNREDACTED = "1";

		expect(resolveConfig({ "redaction-enabled": true }).redactionEnabled).toBe(
			true,
		);
	});

	it("parses additional redaction secrets from config/env", () => {
		process.env.PI_LANGFUSE_REDACTION_SECRETS = "one-secret, two-secret";

		expect(resolveConfig({}).redactionAdditionalSecrets).toEqual([
			"one-secret",
			"two-secret",
		]);
	});

	it("allows settings to enable raw traces", () => {
		const config = resolveConfig({
			"raw-trace-enabled": true,
			"raw-trace-dir": "/tmp/pi-langfuse-raw",
		});

		expect(config.rawTraceEnabled).toBe(true);
		expect(config.rawTraceDir).toBe("/tmp/pi-langfuse-raw");
	});

	it("defaults raw traces under the active agent directory", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-test";

		expect(resolveConfig({}).rawTraceDir).toBe(
			"/tmp/pi-agent-test/langfuse/raw-traces",
		);
	});

	it("lets env opt into full raw provider requests for one process", () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ rawTraceProviderRequestMode: "summary" }),
		);
		process.env.PI_LANGFUSE_RAW_PROVIDER_REQUEST = "full";

		expect(resolveConfig({}).rawTraceProviderRequestMode).toBe("full");
	});

	it("keeps tracing of unpersisted sessions off by default, switchable by file or environment", () => {
		try {
			expect(resolveConfig({}).skipUnpersistedSessions).toBe(true);

			process.env.PI_LANGFUSE_SKIP_UNPERSISTED = "0";
			expect(resolveConfig({}).skipUnpersistedSessions).toBe(false);

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({ skipUnpersistedSessions: true }),
			);
			expect(resolveConfig({}).skipUnpersistedSessions).toBe(true);
		} finally {
			delete process.env.PI_LANGFUSE_SKIP_UNPERSISTED;
		}
	});

	it("writes no raw traces unless a source enables them", () => {
		try {
			expect(resolveConfig({}).rawTraceEnabled).toBe(false);

			process.env.PI_LANGFUSE_RAW_TRACE = "1";
			expect(resolveConfig({}).rawTraceEnabled).toBe(true);
		} finally {
			delete process.env.PI_LANGFUSE_RAW_TRACE;
		}
	});

	it("takes default tags from settings, then the config file, then the environment", () => {
		try {
			expect(resolveConfig({}).defaultTags).toEqual([]);
			process.env.PI_LANGFUSE_TAGS = "env-a, env-b";
			expect(resolveConfig({}).defaultTags).toEqual(["env-a", "env-b"]);

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({ defaultTags: "file-a" }),
			);
			expect(resolveConfig({}).defaultTags).toEqual(["file-a"]);
			expect(
				resolveConfig({ "default-tags": "set-a, set-b" }).defaultTags,
			).toEqual(["set-a", "set-b"]);
		} finally {
			delete process.env.PI_LANGFUSE_TAGS;
		}
	});

	it("declares no export license and unknown consent by default", () => {
		const config = resolveConfig({});

		expect(config.exportLicense).toBe("");
		expect(config.exportConsent).toBe("unknown");
	});

	it("reads export declarations from the config file before the environment", () => {
		process.env.PI_LANGFUSE_EXPORT_LICENSE = "env-license";
		process.env.PI_LANGFUSE_EXPORT_CONSENT = "denied";
		expect(resolveConfig({})).toMatchObject({
			exportLicense: "env-license",
			exportConsent: "denied",
		});

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				exportLicense: "file-license",
				exportConsent: "granted",
			}),
		);
		expect(resolveConfig({})).toMatchObject({
			exportLicense: "file-license",
			exportConsent: "granted",
		});
	});

	it.each([
		[
			"a consent array",
			{ exportConsent: ["granted"] },
			"exportConsentError",
			"an array",
		],
		[
			"an empty consent array",
			{ exportConsent: [] },
			"exportConsentError",
			"an array",
		],
		["a null consent", { exportConsent: null }, "exportConsentError", "null"],
		["a numeric consent", { exportConsent: 1 }, "exportConsentError", "number"],
		["a license object", { exportLicense: {} }, "exportLicenseError", "object"],
		["a null license", { exportLicense: null }, "exportLicenseError", "null"],
	])(
		"reports %s instead of coercing it",
		(_name, file, errorKey, described) => {
			process.env.PI_LANGFUSE_EXPORT_CONSENT = "granted";
			process.env.PI_LANGFUSE_EXPORT_LICENSE = "env-license";
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(file));

			const config = resolveConfig({});

			// A present wrong-typed file value outranks the environment and is
			// never turned into "granted", "[object Object]", or a default.
			expect(config[errorKey as "exportConsentError"]).toContain(
				"must be a string",
			);
			expect(config[errorKey as "exportConsentError"]).toMatch(
				new RegExp(`, not ${described}$`),
			);
			expect(config.exportConsent).not.toBe("[object Object]");
			expect(config.exportLicense).not.toBe("[object Object]");
			if (errorKey === "exportConsentError") {
				expect(config.exportConsent).toBe("unknown");
			} else {
				expect(config.exportLicense).toBe("");
			}
			// Unrelated live configuration still resolves.
			expect(config.identityError).toBeUndefined();
			expect(config.enabled).toBeDefined();
		},
	);

	it("reports no declaration error for missing, blank, or string values", () => {
		expect(resolveConfig({})).not.toHaveProperty("exportConsentError");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ exportConsent: "  ", exportLicense: "" }),
		);
		const config = resolveConfig({});
		expect(config).not.toHaveProperty("exportConsentError");
		expect(config).not.toHaveProperty("exportLicenseError");
		expect(config.exportConsent).toBe("unknown");
	});

	it("resolves capture policies, overrides, and bounded payload budgets by precedence", () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				capturePolicy: "conversations",
				capturePrompt: false,
				payloadMaxStringChars: 20,
				payloadMaxNodes: 30,
			}),
		);
		process.env.PI_LANGFUSE_CAPTURE_POLICY = "prompts-only";
		process.env.PI_LANGFUSE_CAPTURE_PROMPT = "true";
		process.env.PI_LANGFUSE_PAYLOAD_MAX_STRING_CHARS = "unlimited";
		process.env.PI_LANGFUSE_PAYLOAD_MAX_NODES = "40";

		const config = resolveConfig({
			"capture-policy": "metadata-only",
			"capture-prompt": false,
			"payload-max-string-chars": 12,
		});

		expect(config.capturePolicy).toBe("metadata-only");
		expect(config.capturePrompt).toBe(false);
		expect(config.payloadMaxStringChars).toBe(12);
		expect(config.payloadMaxNodes).toBe(30);

		vi.mocked(fs.existsSync).mockReturnValue(false);
		const envConfig = resolveConfig({});
		expect(envConfig.capturePolicy).toBe("prompts-only");
		expect(envConfig.capturePrompt).toBe(true);
		expect(envConfig.payloadMaxStringChars).toBe(Infinity);
		expect(envConfig.payloadMaxNodes).toBe(40);

		process.env.PI_LANGFUSE_CAPTURE_POLICY = "typo";
		process.env.PI_LANGFUSE_PAYLOAD_MAX_NODES = "typo";
		const malformedConfig = resolveConfig({});
		expect(malformedConfig.capturePolicy).toBe("metadata-only");
		expect(malformedConfig.payloadMaxNodes).toBe(0);
	});
});

describe("local autostart precedence", () => {
	const originalAutostart = process.env.PI_LANGFUSE_AUTOSTART;

	function configFile(content: Record<string, unknown> | undefined) {
		vi.mocked(fs.existsSync).mockReturnValue(content !== undefined);
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(content ?? {}));
	}

	function autostart(
		env: string | undefined,
		file: Record<string, unknown> | undefined,
	) {
		if (env === undefined) delete process.env.PI_LANGFUSE_AUTOSTART;
		else process.env.PI_LANGFUSE_AUTOSTART = env;
		configFile(file);
		return resolveConfig({}).localAutostart;
	}

	afterEach(() => {
		if (originalAutostart === undefined) {
			delete process.env.PI_LANGFUSE_AUTOSTART;
		} else {
			process.env.PI_LANGFUSE_AUTOSTART = originalAutostart;
		}
	});

	it.each([
		["0 over a file that enables it", "0", { localAutostart: true }, false],
		["1 over a file that disables it", "1", { localAutostart: false }, true],
		["1 with no file", "1", undefined, true],
		[
			"a file value when the variable is unset",
			undefined,
			{ localAutostart: true },
			true,
		],
		["a file that disables it", undefined, { localAutostart: false }, false],
		["a file that does not mention it", undefined, {}, false],
		["off when nothing configures it", undefined, undefined, false],
		[
			"a file value when the variable is neither 0 nor 1",
			"yes",
			{ localAutostart: true },
			true,
		],
	])("resolves %s", (_name, env, file, expected) => {
		expect(autostart(env, file)).toBe(expected);
	});

	it("gives the health check a 2,000 ms default deadline", () => {
		// The self-hosted health endpoint answers in a steady ~205 ms; a deadline
		// below that would start Docker Compose against a healthy stack.
		configFile({ localAutostart: true });
		expect(resolveConfig({}).localAutostartTimeoutMs).toBe(2_000);
	});
});
