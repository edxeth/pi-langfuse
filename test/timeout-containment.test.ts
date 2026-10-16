import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setPriority, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Timeout containment, proven in child Vitest runs.
 *
 * Vitest does not cancel a test's promise when the test times out: it runs the
 * cleanup hooks and moves on while the abandoned continuation keeps running in
 * the same worker. A bootstrap that restores the user's real environment in
 * `afterAll` therefore lets that continuation resolve real config, credentials,
 * and raw-trace directories (the incident this file guards).
 *
 * Each child runs with a FAKE original user environment: a canary home whose
 * config and settings point at a canary loopback server and canary raw-trace
 * directory. The child gets a scrubbed environment (allowlist only) so even the
 * pre-fix behavior can reach nothing but the canary. A held-open hook runs the
 * abandoned continuation after every setup hook has finished:
 *
 * - positive control: the pre-fix restoring bootstrap writes to the canary,
 *   which proves this harness can observe the escape;
 * - `test/setup.ts` keeps the same late activity inside its own sandbox and
 *   leaves the canary unchanged.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const fixtureDir = "test/fixtures/timeout-containment";
const childConfig = join(repoRoot, fixtureDir, "vitest.child.config.ts");
const CHILD_RUN_TIMEOUT_MS = 90_000;
const LOWEST_PRIORITY = 19;
const TEST_TIMEOUT_MS = 120_000;
const CANARY_PUBLIC_KEY = "pk-lf-canary-config";
const CANARY_SECRET_KEY = "sk-lf-canary-config";

type Canary = {
	root: string;
	home: string;
	agentDir: string;
	rawTraceDir: string;
	configPath: string;
	url: string;
	requests: string[];
	server: Server;
};

type Probe = Record<string, unknown>;

const ownedRoots: string[] = [];
const ownedServers: Server[] = [];

afterAll(async () => {
	for (const server of ownedServers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const root of ownedRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function createCanary(): Promise<Canary> {
	const root = mkdtempSync(join(tmpdir(), "pi-langfuse-containment-"));
	ownedRoots.push(root);
	const requests: string[] = [];
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			requests.push(`${request.method} ${request.url}`);
			response.writeHead(200, { "content-type": "application/json" });
			response.end("{}");
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	ownedServers.push(server);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const home = join(root, "original-home");
	const agentDir = join(home, ".pi", "agent");
	const rawTraceDir = join(agentDir, "langfuse", "raw-traces");
	const configPath = join(agentDir, "langfuse", "pi-langfuse.json");
	mkdirSync(rawTraceDir, { recursive: true });
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	writeFileSync(
		configPath,
		`${JSON.stringify({
			publicKey: CANARY_PUBLIC_KEY,
			secretKey: CANARY_SECRET_KEY,
			host: url,
			rawTraceEnabled: true,
		})}\n`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			"extensions:settings": {
				"pi-langfuse": {
					enabled: true,
					"public-key": CANARY_PUBLIC_KEY,
					"secret-key": CANARY_SECRET_KEY,
					"base-url": url,
					"raw-trace-enabled": true,
				},
			},
		})}\n`,
	);
	return {
		root,
		home,
		agentDir,
		rawTraceDir,
		configPath,
		url,
		requests,
		server,
	};
}

/** Path, size, and content hash of every file below `dir`. */
function snapshotTree(dir: string): string[] {
	const entries: string[] = [];
	const walk = (current: string) => {
		for (const name of readdirSync(current).sort()) {
			const path = join(current, name);
			if (statSync(path).isDirectory()) {
				entries.push(`${path}/`);
				walk(path);
			} else {
				const hash = createHash("sha256")
					.update(readFileSync(path))
					.digest("hex");
				entries.push(`${path} ${hash}`);
			}
		}
	};
	walk(dir);
	return entries;
}

function childEnvironment(
	canary: Canary,
	childTmp: string,
	extra: Record<string, string>,
): Record<string, string> {
	const path = process.env.PATH;
	if (!path) throw new Error("PATH is required to start the child Vitest run");
	const env: Record<string, string> = {
		PATH: path,
		HOME: canary.home,
		USERPROFILE: canary.home,
		TMPDIR: childTmp,
		PI_CODING_AGENT_DIR: canary.agentDir,
		LANGFUSE_PUBLIC_KEY: CANARY_PUBLIC_KEY,
		LANGFUSE_SECRET_KEY: CANARY_SECRET_KEY,
		LANGFUSE_BASE_URL: canary.url,
		RUN_LANGFUSE_E2E: "0",
		CI: "1",
		NO_COLOR: "1",
		...extra,
	};
	// Verify every destination and credential BEFORE the child starts: a path
	// must be owned, the only URL must be the canary, and the credentials must
	// be the canary labels.
	for (const [key, value] of Object.entries(env)) {
		if (
			/^(HOME|USERPROFILE|TMPDIR|PI_CODING_AGENT_DIR|CONTAINMENT_PROBE_DIR)$/.test(
				key,
			)
		) {
			if (!value.startsWith(canary.root + sep)) {
				throw new Error(`child ${key} is not under the owned canary root`);
			}
		}
		if (/URL|HOST/.test(key) && value !== canary.url) {
			throw new Error(`child ${key} is not the owned canary URL`);
		}
	}
	if (!env.LANGFUSE_PUBLIC_KEY?.includes("canary")) {
		throw new Error("child credentials are not canary credentials");
	}
	return env;
}

/** The late-work probes each fixture file writes. */
const probeNames: Record<string, string[]> = {
	"late-activity": ["late-activity"],
	"late-prompt": ["late-prompt"],
	"startup-timeout": ["startup-timeout"],
};

type ChildRun = {
	/** What each fixture's late callback observed, by fixture name. */
	probes: Record<string, Probe>;
	/** Failure messages of every fixture test (all must be timeouts). */
	testMessages: string;
	/** Parent of every sandbox the child workers created. */
	sandboxPrefix: string;
};

async function runChild(
	canary: Canary,
	setup: "real" | "legacy",
	fixtures: string[],
): Promise<ChildRun> {
	const childRoot = join(canary.root, `child-${setup}`);
	const childTmp = join(childRoot, "tmp");
	const probeDir = join(childRoot, "probes");
	mkdirSync(childTmp, { recursive: true });
	mkdirSync(probeDir, { recursive: true });
	const resultFile = join(childRoot, "result.json");
	const env = childEnvironment(canary, childTmp, {
		CONTAINMENT_SETUP: setup,
		CONTAINMENT_PROBE_DIR: probeDir,
	});

	const child = spawn(
		process.execPath,
		[
			vitestEntry,
			"run",
			"--root",
			repoRoot,
			"--config",
			childConfig,
			// One worker at a time: this run shares the machine with the rest of
			// the suite and must not starve its time-bounded tests.
			"--no-file-parallelism",
			"--reporter=json",
			`--outputFile=${resultFile}`,
			...fixtures.map((name) => `${fixtureDir}/${name}.child.ts`),
		],
		{ cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	// Lowest scheduling priority, set before the child forks its workers (they
	// inherit it), so the other suites' time-bounded tests keep their CPU.
	if (child.pid !== undefined) setPriority(child.pid, LOWEST_PRIORITY);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_RUN_TIMEOUT_MS);
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => resolve());
	});
	clearTimeout(timer);

	const probes: Record<string, Probe> = {};
	for (const name of readdirSync(probeDir)) {
		probes[name.replace(/\.json$/, "")] = JSON.parse(
			readFileSync(join(probeDir, name), "utf8"),
		) as Probe;
	}
	const results = JSON.parse(readFileSync(resultFile, "utf8")) as {
		testResults: Array<{
			assertionResults: Array<{ status: string; failureMessages: string[] }>;
		}>;
	};
	const assertions = results.testResults.flatMap(
		(file) => file.assertionResults,
	);
	const context = `child run output:\n${output}`;
	// Every fixture test must fail by timing out: that is the premise.
	expect(
		assertions.map((assertion) => assertion.status),
		context,
	).toEqual(assertions.map(() => "failed"));
	expect(Object.keys(probes).sort(), context).toEqual(
		fixtures.flatMap((name) => probeNames[name] ?? []).sort(),
	);
	return {
		probes,
		testMessages: assertions
			.flatMap((assertion) => assertion.failureMessages)
			.join("\n"),
		sandboxPrefix: join(childTmp, "pi-langfuse-vitest-"),
	};
}

function expectInsideSandbox(value: unknown, sandboxPrefix: string) {
	expect(typeof value).toBe("string");
	expect((value as string).startsWith(sandboxPrefix)).toBe(true);
}

describe("positive control: the restoring bootstrap", () => {
	let canary: Canary;
	let before: string[];
	let run: ChildRun;

	beforeAll(async () => {
		canary = await createCanary();
		before = snapshotTree(canary.home);
		run = await runChild(canary, "legacy", ["late-activity"]);
	}, TEST_TIMEOUT_MS);

	it("lets late work reach the original config, credentials, host, and raw-trace directory", () => {
		const probe = run.probes["late-activity"];
		expect(run.testMessages).toContain("Test timed out");
		expect(probe?.sandboxRemovedBeforeLateWork).toBe(true);
		expect(probe?.home).toBe(canary.home);
		expect(probe?.configPath).toBe(canary.configPath);
		expect(probe?.rawTraceDir).toBe(canary.rawTraceDir);
		expect(probe?.host).toBe(canary.url);
		expect(probe?.publicKey).toBe("canary");
		expect(probe?.secretKey).toBe("canary");
		expect(probe?.requestOutcome).toBe("status 200");
		expect(canary.requests).toEqual(["POST /api/public/ingestion"]);
		expect(snapshotTree(canary.home)).not.toEqual(before);
		expect(
			existsSync(join(canary.rawTraceDir, "--unknown--", "late.jsonl")),
		).toBe(true);
	});
});

describe("late work after a test timeout under test/setup.ts", () => {
	let canary: Canary;
	let before: string[];
	let run: ChildRun;

	beforeAll(async () => {
		canary = await createCanary();
		before = snapshotTree(canary.home);
		run = await runChild(canary, "real", [
			"late-activity",
			"late-prompt",
			"startup-timeout",
		]);
	}, TEST_TIMEOUT_MS);

	it("keeps late config, credentials, host, and raw-trace writes in the sandbox", () => {
		const probe = run.probes["late-activity"];
		expect(run.testMessages).toContain("Test timed out");
		// The late callback really ran after the sandbox was cleaned up.
		expect(probe?.sandboxRemovedBeforeLateWork).toBe(true);
		expectInsideSandbox(probe?.sandboxHome, run.sandboxPrefix);
		expect(probe?.home).toBe(probe?.sandboxHome);
		expect(probe?.homedir).toBe(probe?.sandboxHome);
		expectInsideSandbox(probe?.configPath, run.sandboxPrefix);
		expectInsideSandbox(probe?.rawTraceDir, run.sandboxPrefix);
		expectInsideSandbox(probe?.rawTracePath, run.sandboxPrefix);
		expect(probe?.rawTraceWritten).toBe(true);
		// Synthetic credentials and the closed loopback host, not the canary.
		expect(probe?.publicKey).toBe("test-isolation");
		expect(probe?.secretKey).toBe("test-isolation");
		expect(probe?.host).toBe("http://127.0.0.1:9");
		expect(String(probe?.requestOutcome)).toMatch(/^failed /);
	});

	it("discards a createRuntimeCase startup that outlives its timed-out test", () => {
		const probe = run.probes["startup-timeout"];
		expect(String(probe?.startup)).toMatch(
			/^rejected: .*closed before startup finished/,
		);
		expect(probe?.latePrompt).toBeUndefined();
		expect(probe?.sessionStartObserved).toBe(false);
		expect(probe?.leftoverCaseDirs).toEqual([]);
		expectInsideSandbox(probe?.home, run.sandboxPrefix);
		expectInsideSandbox(probe?.agentDir, run.sandboxPrefix);
		expect(probe?.baseUrl).toBe("http://127.0.0.1:9");
		expect(probe?.publicKey).toBe("test-isolation");
	});

	it("refuses a late prompt on a case its timed-out test already tore down", () => {
		const probe = run.probes["late-prompt"];
		expect(String(probe?.latePrompt)).toMatch(/^refused: .*is closed/);
		expect(probe?.recorderRecords).toBe(0);
		expect(probe?.rawTraceRecords).toBe(0);
		expectInsideSandbox(probe?.home, run.sandboxPrefix);
		expectInsideSandbox(probe?.agentDir, run.sandboxPrefix);
		expect(probe?.baseUrl).toBe("http://127.0.0.1:9");
		expect(probe?.publicKey).toBe("test-isolation");
	});

	it("leaves the canary original environment untouched", () => {
		expect(canary.requests).toEqual([]);
		expect(snapshotTree(canary.home)).toEqual(before);
	});
});
