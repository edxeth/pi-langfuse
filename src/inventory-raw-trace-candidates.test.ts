import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

it("rejects an empty inventory root instead of reading the current directory", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-langfuse-inventory-"));
	try {
		const script = fileURLToPath(
			new URL("../scripts/inventory-raw-trace-candidates.mjs", import.meta.url),
		);
		const result = spawnSync(process.execPath, [script, ""], {
			cwd: directory,
			encoding: "utf8",
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("<raw-trace-directory>");
		expect(readdirSync(directory)).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * The script runs when imported, so these tests import it in-process with
 * argv and console replaced. The real script is measured and exercised; the
 * subprocess test above checks the actual command line.
 */
describe("inventory script in-process", () => {
	const originalExitCode = process.exitCode;

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = originalExitCode;
	});

	async function inventory(args: string[]) {
		vi.resetModules();
		const out: string[] = [];
		const err: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
			out.push(parts.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
			err.push(parts.join(" "));
		});
		const originalArgv = process.argv;
		process.argv = ["node", "inventory.mjs", ...args];
		process.exitCode = undefined;
		try {
			// @ts-expect-error The script is plain JavaScript with no declarations.
			await import("../scripts/inventory-raw-trace-candidates.mjs");
		} finally {
			process.argv = originalArgv;
		}
		return {
			out: out.join("\n"),
			err: err.join("\n"),
			exitCode: process.exitCode,
		};
	}

	it("prints usage for --help without an error status", async () => {
		const result = await inventory(["--help"]);

		expect(result.out).toContain(
			"Usage: node scripts/inventory-raw-trace-candidates.mjs",
		);
		expect(result.out).toContain("It never deletes files.");
		expect(result.err).toBe("");
		expect(result.exitCode).toBeUndefined();
	});

	it.each([[[]], [["--other"]], [["one", "two"]]])(
		"rejects the arguments %j with usage and status 1",
		async (args) => {
			const result = await inventory(args);

			expect(result.out).toBe("");
			expect(result.err).toContain("Usage:");
			expect(result.exitCode).toBe(1);
		},
	);

	it("lists only name-pattern candidate directories with recursive .jsonl counts", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-inventory-root-"));
		try {
			const elsewhere = mkdtempSync(
				join(tmpdir(), "pi-langfuse-inventory-else-"),
			);
			const touch = (...parts: string[]) => {
				mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
				writeFileSync(join(root, ...parts), "{}\n");
			};
			touch("--tmp-a", "one.jsonl");
			touch("--tmp-a", "nested", "deep", "two.jsonl");
			touch("--tmp-a", "notes.json");
			touch("e1-run", "three.jsonl");
			touch("auto", "four.jsonl");
			touch("down", "five.jsonl");
			mkdirSync(join(root, "floating"));
			touch("--project--", "real.jsonl");
			touch("elephant", "six.jsonl");
			writeFileSync(join(root, "--tmp-file"), "not a directory");
			writeFileSync(join(elsewhere, "linked.jsonl"), "{}\n");
			symlinkSync(elsewhere, join(root, "e2-link"));
			symlinkSync(
				join(elsewhere, "linked.jsonl"),
				join(root, "--tmp-a", "link.jsonl"),
			);

			const result = await inventory([root]);

			const report = JSON.parse(result.out);
			expect(report.rawTraceDir).toBe(root);
			expect(report.candidates).toEqual([
				{ directory: "--tmp-a", jsonlFiles: 2 },
				{ directory: "auto", jsonlFiles: 1 },
				{ directory: "down", jsonlFiles: 1 },
				{ directory: "e1-run", jsonlFiles: 1 },
				{ directory: "floating", jsonlFiles: 0 },
			]);
			expect(report.candidateDirectories).toBe(5);
			expect(report.jsonlFiles).toBe(5);
			expect(report.warning).toContain("No files were changed.");
			expect(result.exitCode).toBeUndefined();
			rmSync(elsewhere, { recursive: true, force: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
