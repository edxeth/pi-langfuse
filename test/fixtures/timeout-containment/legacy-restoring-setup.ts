import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Positive control: the pre-fix bootstrap shape. It pins a temporary sandbox
 * for the duration of the file, then restores the original user environment
 * in `afterAll` while the worker can still run code. Any late async work then
 * resolves the ORIGINAL home, config, and credentials. The containment test
 * runs this only against a fake original environment, to prove the harness
 * detects the escape that `test/setup.ts` must prevent.
 */
const keys = [
	"HOME",
	"USERPROFILE",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_LANGFUSE_CONFIG",
	"PI_LANGFUSE_RAW_TRACE_DIR",
	"LANGFUSE_PUBLIC_KEY",
	"LANGFUSE_SECRET_KEY",
	"LANGFUSE_BASE_URL",
];
const original = new Map(keys.map((key) => [key, process.env[key]]));
const runDir = mkdtempSync(join(tmpdir(), "pi-langfuse-legacy-"));
mkdirSync(join(runDir, "agent"), { recursive: true });

for (const key of keys) delete process.env[key];
process.env.HOME = runDir;
process.env.USERPROFILE = runDir;
process.env.PI_CODING_AGENT_DIR = join(runDir, "agent");
process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-isolation";
process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-isolation";
process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:9";

afterAll(() => {
	rmSync(runDir, { recursive: true, force: true });
	for (const key of keys) {
		const value = original.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
