import * as fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
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
		delete process.env.PI_CODING_AGENT_DIR;
	});
	it("should use default settings when no input is provided", () => {
		const config = resolveConfig({});
		expect(config.enabled).toBe(DEFAULT_SETTINGS.enabled);
		expect(config.host).toBe(DEFAULT_SETTINGS["base-url"]);
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
});
