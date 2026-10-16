import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Per-worker test bootstrap. Vitest runs this file first in every test-file
 * worker and does not cancel a test's promise on timeout: abandoned async work
 * keeps running in the worker after every hook, including `afterAll`, has
 * finished. The sandbox pinned here therefore stays pinned for the lifetime of
 * the worker. Nothing restores the user's HOME, Pi or Langfuse variables, so
 * late work can only resolve sandbox paths, synthetic credentials, and the
 * closed loopback host.
 */
const runLangfuseE2E = process.env.RUN_LANGFUSE_E2E === "1";
const inheritedE2ECredentials = {
	publicKey: process.env.LANGFUSE_PUBLIC_KEY,
	secretKey: process.env.LANGFUSE_SECRET_KEY,
	baseUrl: process.env.LANGFUSE_BASE_URL,
	host: process.env.LANGFUSE_HOST,
};
const hasE2ECredentials =
	Boolean(inheritedE2ECredentials.publicKey) &&
	Boolean(inheritedE2ECredentials.secretKey);

const originalHome = homedir();
const persistentRawTraceDir = join(
	originalHome,
	".pi",
	"agent",
	"langfuse",
	"raw-traces",
);
const persistentRawTraceEntriesBefore = new Set(
	existsSync(persistentRawTraceDir) ? readdirSync(persistentRawTraceDir) : [],
);
const runDir = mkdtempSync(join(tmpdir(), "pi-langfuse-vitest-"));
const runId = randomUUID();
const agentDir = join(runDir, "agent");
const sessionDir = join(runDir, "sessions");
const rawTraceDir = join(runDir, "raw-traces");
const configPath = join(runDir, "pi-langfuse.json");
const persistentTraceProbeDirectory = `--pi-langfuse-test-${runId}--`;
const offlineHost = "http://127.0.0.1:9";

for (const directory of [agentDir, sessionDir, rawTraceDir]) {
	mkdirSync(directory, { recursive: true });
}

// Git exports can redirect fixture repository commands into the checkout.
for (const key of Object.keys(process.env)) {
	if (
		key.startsWith("GIT_") ||
		key.startsWith("LANGFUSE_") ||
		key.startsWith("PI_LANGFUSE_") ||
		key.startsWith("OTEL_EXPORTER_OTLP_") ||
		isPiPathEnvironmentKey(key)
	) {
		delete process.env[key];
	}
}

process.env.HOME = runDir;
process.env.USERPROFILE = runDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
process.env.PI_LANGFUSE_CONFIG = configPath;
process.env.PI_LANGFUSE_RAW_TRACE_DIR = rawTraceDir;
process.env.PI_LANGFUSE_TEST_RUN_DIR = runDir;
process.env.PI_LANGFUSE_TEST_RUN_ID = runId;
process.env.PI_LANGFUSE_AUTOSTART = "0";
process.env.PI_LANGFUSE_RAW_TRACE = "0";

if (runLangfuseE2E && hasE2ECredentials) {
	setIfPresent("LANGFUSE_PUBLIC_KEY", inheritedE2ECredentials.publicKey);
	setIfPresent("LANGFUSE_SECRET_KEY", inheritedE2ECredentials.secretKey);
	setIfPresent("LANGFUSE_BASE_URL", inheritedE2ECredentials.baseUrl);
	setIfPresent("LANGFUSE_HOST", inheritedE2ECredentials.host);
} else {
	if (!runLangfuseE2E) {
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-isolation";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-isolation";
	}
	process.env.LANGFUSE_BASE_URL = offlineHost;
}

assertEnvironmentValue("HOME", runDir);
assertEnvironmentValue("USERPROFILE", runDir);
assertEnvironmentValue("PI_CODING_AGENT_DIR", agentDir);
assertEnvironmentValue("PI_CODING_AGENT_SESSION_DIR", sessionDir);
assertEnvironmentValue("PI_LANGFUSE_CONFIG", configPath);
assertEnvironmentValue("PI_LANGFUSE_RAW_TRACE_DIR", rawTraceDir);
if (runLangfuseE2E && !hasE2ECredentials) {
	assertEnvironmentValue("LANGFUSE_BASE_URL", offlineHost);
} else if (!runLangfuseE2E) {
	assertEnvironmentValue("LANGFUSE_PUBLIC_KEY", "pk-lf-test-isolation");
	assertEnvironmentValue("LANGFUSE_SECRET_KEY", "sk-lf-test-isolation");
	assertEnvironmentValue("LANGFUSE_BASE_URL", offlineHost);
}

afterAll(() => {
	try {
		const persistentRawTraceEntriesAfter = existsSync(persistentRawTraceDir)
			? readdirSync(persistentRawTraceDir)
			: [];
		const newlyAddedEntries = persistentRawTraceEntriesAfter.filter(
			(entry) => !persistentRawTraceEntriesBefore.has(entry),
		);

		// Other Pi processes can write to this shared directory during the suite.
		// Only this run's random probe name can be attributed to these tests.
		if (newlyAddedEntries.includes(persistentTraceProbeDirectory)) {
			throw new Error(
				"A test-owned raw-trace marker appeared in the persistent trace directory",
			);
		}
	} finally {
		// Only the files go. The pinned environment stays, so work that outlives
		// the file recreates sandbox paths at worst and never touches user data.
		rmSync(runDir, { recursive: true, force: true });
	}
});

function isPiPathEnvironmentKey(key: string) {
	return (
		key === "HOME" ||
		key === "USERPROFILE" ||
		key === "PI_CODING_AGENT_DIR" ||
		key === "PI_CODING_AGENT_SESSION_DIR" ||
		key === "PI_PACKAGE_DIR"
	);
}

function assertEnvironmentValue(key: string, expected: string) {
	if (process.env[key] !== expected) {
		throw new Error(`Test isolation did not pin ${key}`);
	}
}

function setIfPresent(key: string, value: string | undefined) {
	if (value !== undefined) process.env[key] = value;
}
