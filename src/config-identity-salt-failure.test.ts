import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canTrace, resolveConfig } from "./config.js";

/**
 * The salt is persisted beside the other config keys. These tests make the
 * real filesystem refuse that, with no fake in between, and prove the
 * configuration fails closed each time.
 */
describe("pseudonymous identity when the salt cannot be persisted", () => {
	const settings = {
		enabled: true,
		"public-key": "pk-lf-test",
		"secret-key": "sk-lf-test",
		"identity-mode": "pseudonymous",
	} as const;
	const pinnedConfigPath = process.env.PI_LANGFUSE_CONFIG;
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(homedir(), "pi-langfuse-salt-failure-"));
	});

	afterEach(() => {
		if (pinnedConfigPath === undefined) delete process.env.PI_LANGFUSE_CONFIG;
		else process.env.PI_LANGFUSE_CONFIG = pinnedConfigPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		[
			"the config path is a directory",
			(base: string) => {
				const path = join(base, "pi-langfuse.json");
				mkdirSync(path);
				return path;
			},
			"EISDIR",
		],
		[
			"a parent of the config path is a file",
			(base: string) => {
				const parent = join(base, "not-a-directory");
				writeFileSync(parent, "");
				return join(parent, "pi-langfuse.json");
			},
			"EEXIST",
		],
	])("fails closed when %s", (_name, prepare, code) => {
		const configPath = prepare(dir);
		process.env.PI_LANGFUSE_CONFIG = configPath;

		const config = resolveConfig(settings);

		expect(config.identityError).toContain(
			`identity salt unavailable for ${configPath}`,
		);
		expect(config.identityError).toContain(code);
		// The failure's own message is reported, not its "Error: " rendering.
		expect(config.identityError).toMatch(
			/^pi-langfuse identity salt unavailable for /,
		);
		expect(config.identityMode).toBe("pseudonymous");
		expect(config.identityKeepRepo).toBe(false);
		expect(config.identitySalt).toBeUndefined();
		expect(canTrace(config)).toBe(false);
	});
});
