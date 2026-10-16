import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `export-cli.ts` is the `pi-langfuse-export` entry point: importing it runs
 * the command. These tests import it in-process, with argv, console, stderr
 * and `process.exit` replaced, so its real behavior is exercised and measured.
 */
class CliExit extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

const originalPath = process.env.PATH;
const originalExitCode = process.exitCode;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	delete process.env.TRUFFLEHOG_BIN;
	process.exitCode = originalExitCode;
});

async function runCli(args: string[]) {
	vi.resetModules();
	const stdout: string[] = [];
	const stderr: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		stdout.push(parts.join(" "));
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr.push(String(chunk));
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new CliExit(code);
	}) as never);
	const originalArgv = process.argv;
	process.argv = ["node", "export-cli.js", ...args];
	process.exitCode = undefined;
	let exitedWith: number | undefined;
	try {
		await import("./export-cli.js");
	} catch (error) {
		if (!(error instanceof CliExit)) throw error;
		exitedWith = error.code;
	} finally {
		process.argv = originalArgv;
	}
	return {
		stdout: stdout.join("\n"),
		stderr: stderr.join(""),
		exitedWith,
		exitCode: process.exitCode,
	};
}

function rawLayout() {
	const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-cli-test-"));
	const rawDir = join(root, "raw", "--project--");
	mkdirSync(rawDir, { recursive: true });
	writeFileSync(
		join(rawDir, "trace.jsonl"),
		'{"type":"tool_result","text":"hello"}\n',
	);
	return {
		raw: join(root, "raw"),
		out: join(root, "export"),
		sessions: join(root, "sessions"),
	};
}

describe("pi-langfuse-export command", () => {
	it.each(["--help", "-h"])("prints usage and exits 0 for %s", async (flag) => {
		const result = await runCli([flag]);

		expect(result.exitedWith).toBe(0);
		expect(result.stdout).toContain("pi-langfuse-export");
		expect(result.stdout).toContain("--format <name>");
		expect(result.stdout).toContain("--consent <value>");
		expect(result.stderr).toBe("");
	});

	it("reports progress on stderr and a JSON summary on stdout for a legacy export", async () => {
		const paths = rawLayout();

		const result = await runCli([
			"--raw-only",
			"--raw-dir",
			paths.raw,
			"--out",
			paths.out,
			"--no-trufflehog",
		]);

		const summary = JSON.parse(result.stdout);
		expect(summary).toMatchObject({
			status: "approved",
			outDir: paths.out,
			summary: { files: 1, approved: 1, rejected: 0 },
		});
		expect(summary.training).toBeUndefined();
		expect(result.stderr).toMatch(/ discover - discovering JSONL files\n/);
		expect(result.stderr).toMatch(
			/ copy 1\/1 raw-trace --project--\/trace\.jsonl - redacting 1\/1\n/,
		);
		expect(result.stderr).toMatch(/ done 1\/1 - done: 1 approved, 0 rejected/);
		expect(result.stderr).not.toContain("Export failed");
		expect(result.exitCode).toBeUndefined();
	});

	it("reports a refused export on stderr and exits non-zero", async () => {
		const paths = rawLayout();

		const result = await runCli([
			"--raw-dir",
			paths.raw,
			"--out",
			paths.out,
			"--format",
			"jsonl",
		]);

		expect(result.stderr).toContain(
			"Export failed: export refused: --format must be one of openai-chat, anthropic-messages, sharegpt",
		);
		expect(JSON.parse(result.stdout)).toMatchObject({
			status: "failed",
			error: { code: "invalid-export-option" },
		});
		expect(result.exitCode).toBe(2);
	});

	it("prints training warnings and fails a rejected review export", async () => {
		const paths = rawLayout();
		// No scanner on PATH: review records need a completed scan.
		process.env.PATH = "";
		delete process.env.TRUFFLEHOG_BIN;

		const result = await runCli([
			"--raw-only",
			"--raw-dir",
			paths.raw,
			"--sessions-dir",
			paths.sessions,
			"--out",
			paths.out,
			"--format",
			"openai-chat",
		]);

		expect(result.stderr).toContain(
			"Warning: Pseudonymous is not anonymous: code, commits, relative paths, and business content can still identify people or repositories.",
		);
		expect(result.stderr).toContain(
			"Warning: The external TruffleHog scan did not complete cleanly; no review records were kept.",
		);
		const summary = JSON.parse(result.stdout);
		expect(summary.status).toBe("rejected");
		expect(summary.training).toMatchObject({
			format: "openai-chat",
			consent: "unknown",
			accepted: 0,
		});
		expect(result.exitCode).toBe(2);
	});
});
