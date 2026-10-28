import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setPriority, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/bench-overhead.mjs loads extension code outside Vitest, so its own
 * guards are all that keep a benchmark away from real destinations. A real
 * benchmark run loads a probe extension that attempts each prohibited
 * operation once, next to the allowed ones.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchScript = join(repoRoot, "scripts", "bench-overhead.mjs");
/** Bound on one benchmark run; it normally takes about a second. */
const BENCH_RUN_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = BENCH_RUN_TIMEOUT_MS + 10_000;
const LOWEST_PRIORITY = 19;

const PROBE_CONFIG = `import { readFileSync } from "node:fs";

export function resolveConfig() {
	const { host } = JSON.parse(readFileSync(process.env.PI_LANGFUSE_CONFIG ?? "", "utf-8"));
	return { host, localAutostart: false };
}
`;

const PROBE_EXTENSION = `import { execSync, spawnSync } from "node:child_process";
import { openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default function register(pi: { on(event: string, handler: () => Promise<void>): void }) {
	pi.on("session_start", async () => {
		const home = process.env.HOME ?? "";
		const outside = process.env.BENCH_PROBE_OUTSIDE_DIR ?? "";
		const { host } = JSON.parse(readFileSync(process.env.PI_LANGFUSE_CONFIG ?? "", "utf-8"));
		const outcomes: Record<string, string> = {};
		async function attempt(name: string, action: () => unknown) {
			try {
				await action();
				outcomes[name] = "allowed";
			} catch (error) {
				outcomes[name] = error instanceof Error ? error.message : String(error);
			}
		}
		await attempt("fetch the fake server", async () => {
			const response = await fetch(\`\${host}/api/public/health\`);
			if (!response.ok) throw new Error(\`status \${response.status}\`);
		});
		await attempt("fetch elsewhere", () => fetch(process.env.BENCH_PROBE_FORBIDDEN_URL ?? ""));
		await attempt("run git", () => {
			const result = spawnSync("git", ["--version"]);
			if (result.status !== 0) throw new Error(\`git exited \${result.status}\`);
		});
		await attempt("run another program", () => spawnSync("touch", [join(outside, "spawned")]));
		await attempt("run git with a shell", () =>
			spawnSync("git", ["--version;", "touch", join(outside, "shell-option")], { shell: true }),
		);
		await attempt("run a shell command that ends in git", () =>
			execSync(\`touch \${join(outside, "shell-command")}; \${join(outside, "missing", "git")}\`, { stdio: "ignore" }),
		);
		await attempt("write inside", () => writeFileSync(join(home, "inside.txt"), "x"));
		await attempt("write outside", () => writeFileSync(join(outside, "written"), "x"));
		await attempt("open outside for append", () => openSync(join(outside, "opened"), "a"));
		await attempt("write outside by file URL", () =>
			writeFileSync(pathToFileURL(join(outside, "by-url")), "x"),
		);
		await attempt("rename to outside", () =>
			renameSync(join(home, "inside.txt"), join(outside, "renamed")),
		);
		process.stderr.write(\`probe \${JSON.stringify(outcomes)}\\n\`);
	});
}
`;

const PROHIBITED = [
	"fetch elsewhere",
	"run another program",
	"run git with a shell",
	"run a shell command that ends in git",
	"write outside",
	"open outside for append",
	"write outside by file URL",
	"rename to outside",
];

type BenchRun = {
	exitCode: number | null;
	outcomes: Record<string, string>;
	guardBlocks: string[];
};

async function runBench(
	repo: string,
	env: Record<string, string>,
): Promise<BenchRun> {
	const child = spawn(
		process.execPath,
		[benchScript, "--repo", repo, "--scenario", "burst"],
		{
			cwd: repoRoot,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	// Lowest scheduling priority, so the rest of the suite keeps its CPU.
	if (child.pid !== undefined) setPriority(child.pid, LOWEST_PRIORITY);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), BENCH_RUN_TIMEOUT_MS);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	}).finally(() => clearTimeout(timer));
	const probeLine = stderr
		.split("\n")
		.find((line) => line.startsWith("probe "));
	if (!probeLine) {
		throw new Error(
			`the benchmark ran no probe (exit ${exitCode}); stderr: ${stderr}`,
		);
	}
	return {
		exitCode,
		outcomes: JSON.parse(probeLine.slice("probe ".length)),
		guardBlocks: JSON.parse(stdout).guardBlocks,
	};
}

describe("benchmark isolation guards", () => {
	let root: string;
	let outside: string;
	let forbidden: Server | undefined;
	const forbiddenRequests: string[] = [];
	let run: BenchRun;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-langfuse-bench-guards-"));
		outside = join(root, "outside");
		const probeRepo = join(root, "probe-repo");
		mkdirSync(outside);
		mkdirSync(join(probeRepo, "src"), { recursive: true });
		writeFileSync(join(probeRepo, "src", "config.ts"), PROBE_CONFIG);
		writeFileSync(join(probeRepo, "src", "index.ts"), PROBE_EXTENSION);
		const server = createServer((request, response) => {
			forbiddenRequests.push(`${request.method} ${request.url}`);
			response.end("{}");
		});
		forbidden = server;
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const { port } = server.address() as AddressInfo;
		run = await runBench(probeRepo, {
			BENCH_PROBE_FORBIDDEN_URL: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
			BENCH_PROBE_OUTSIDE_DIR: outside,
		});
	}, HOOK_TIMEOUT_MS);

	afterAll(async () => {
		const server = forbidden;
		if (server) await new Promise((done) => server.close(done));
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses each prohibited operation, lists it, and exits 1", () => {
		for (const name of PROHIBITED) {
			expect(run.outcomes[name], name).toMatch(/^bench: blocked /);
		}
		expect(run.guardBlocks).toHaveLength(PROHIBITED.length);
		expect(run.exitCode).toBe(1);
	});

	it("leaves nothing at a refused destination", () => {
		expect(forbiddenRequests).toEqual([]);
		expect(readdirSync(outside)).toEqual([]);
	});

	it("still allows the fake server, git, and writes inside its temp directory", () => {
		expect(run.outcomes["fetch the fake server"]).toBe("allowed");
		expect(run.outcomes["run git"]).toBe("allowed");
		expect(run.outcomes["write inside"]).toBe("allowed");
	});
});
