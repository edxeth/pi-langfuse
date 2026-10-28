import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	linkSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendDiagnostic,
	createNotificationGate,
	diagnosticCause,
} from "./diagnostics-log.js";

const roots: string[] = [];

function tempDir() {
	const root = mkdtempSync(join(tmpdir(), "pi-langfuse-diagnostics-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function makeFifo(path: string) {
	const mkfifo = spawnSync("mkfifo", [path]);
	if (mkfifo.status !== 0) {
		throw new Error("mkfifo is required for this regression test");
	}
}

/** Bound on a child process that should answer at once. */
const CHILD_DEADLINE_MS = 3_000;

describe("diagnostics log", () => {
	it("appends one private JSON line per diagnostic, creating its directory", () => {
		const path = join(tempDir(), "nested", "diagnostics.jsonl");

		appendDiagnostic(path, { message: "first" });
		appendDiagnostic(path, { message: "second" });

		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).message)).toEqual([
			"first",
			"second",
		]);
		const record = JSON.parse(lines[0] ?? "{}");
		expect(typeof record.timestamp).toBe("string");
		expect(record.pid).toBe(process.pid);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("keeps one previous file when the log reaches its size bound", () => {
		const path = join(tempDir(), "diagnostics.jsonl");
		for (let index = 0; index < 20; index += 1) {
			appendDiagnostic(path, { message: `entry ${index}` }, 300);
		}

		expect(statSync(path).size).toBeLessThanOrEqual(300);
		expect(statSync(`${path}.1`).size).toBeGreaterThan(0);
		const last = readFileSync(path, "utf-8").trim().split("\n").at(-1);
		expect(JSON.parse(last ?? "{}").message).toBe("entry 19");
	});

	it("makes an existing log owner-only before writing to it", () => {
		const path = join(tempDir(), "diagnostics.jsonl");
		writeFileSync(path, "");
		chmodSync(path, 0o644);

		appendDiagnostic(path, { message: "private" });

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("refuses a log file that shares its inode with another file", () => {
		const dir = tempDir();
		const target = join(dir, "unrelated.txt");
		writeFileSync(target, "keep\n");
		chmodSync(target, 0o644);
		const path = join(dir, "diagnostics.jsonl");
		linkSync(target, path);

		expect(() => appendDiagnostic(path, { message: "x" })).toThrow(/link/);
		expect(readFileSync(target, "utf-8")).toBe("keep\n");
		expect(statSync(target).mode & 0o777).toBe(0o644);
	});

	it("refuses a FIFO that nothing reads, without blocking", () => {
		const path = join(tempDir(), "diagnostics.jsonl");
		makeFifo(path);

		// A blocking open would freeze the caller for good, so the write runs in
		// a child process with a deadline, not in this test worker.
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`import { appendDiagnostic } from ${JSON.stringify(
					new URL("./diagnostics-log.ts", import.meta.url).href,
				)};
try {
	appendDiagnostic(process.argv[1], { message: "probe" });
	console.log("written");
} catch (error) {
	console.log(error.code ?? error.message);
}`,
				path,
			],
			{ encoding: "utf-8", timeout: CHILD_DEADLINE_MS },
		);

		expect(child.signal).toBeNull();
		expect(child.stdout.trim()).toBe("ENXIO");
		expect(lstatSync(path).isFIFO()).toBe(true);
	});

	it("refuses a FIFO while something reads it, writing nothing", () => {
		const path = join(tempDir(), "diagnostics.jsonl");
		makeFifo(path);
		// With a reader the open succeeds, so the file-type check must refuse.
		const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			expect(() => appendDiagnostic(path, { message: "probe" })).toThrow(
				/not a regular file/,
			);
			expect(readSync(reader, Buffer.alloc(64))).toBe(0);
		} finally {
			closeSync(reader);
		}
	});

	it("never writes through a symlink", () => {
		const dir = tempDir();
		const target = join(dir, "unrelated.txt");
		writeFileSync(target, "keep\n");
		const path = join(dir, "diagnostics.jsonl");
		symlinkSync(target, path);

		expect(() => appendDiagnostic(path, { message: "x" })).toThrow();
		expect(readFileSync(target, "utf-8")).toBe("keep\n");
	});
});

describe("diagnostic notifications", () => {
	it("treats operation wrappers around one nested Langfuse error as one cause", () => {
		const conflict =
			"a runtime with a different configuration is still active; its open prompts must finish";
		expect(
			diagnosticCause(
				`Langfuse: Failed to start generation: Langfuse: ${conflict}`,
			),
		).toBe(conflict);
		expect(
			diagnosticCause(`Failed to create tool span: Langfuse: ${conflict}`),
		).toBe(conflict);
		// A wrapper around a plain reason is its own cause.
		expect(
			diagnosticCause("Failed to send Langfuse score: request failed"),
		).toBe("Failed to send Langfuse score: request failed");
	});

	it("gives repeated failures of one outage one cause, whatever their timings say", () => {
		const exhausted = (attempt: number, needs: number, left: number) =>
			`Langfuse OTLP export failed: HTTP 503 on attempt ${attempt}; next retry needs ${needs}ms but only ${left}ms of the 10000ms deadline remain`;
		expect(diagnosticCause(exhausted(5, 2000, 1734))).toBe(
			diagnosticCause(exhausted(6, 2000, 211)),
		);
		expect(
			diagnosticCause(
				"Langfuse OTLP export failed: span 1a2b3c4d5e6f7a8b of trace 0123456789abcdef0123456789abcdef is 4100000 bytes",
			),
		).toBe(
			diagnosticCause(
				"Langfuse OTLP export failed: span ffffeeeeddddcccc of trace fedcba9876543210fedcba9876543210 is 3600001 bytes",
			),
		);
		// A different status is a different cause.
		expect(
			diagnosticCause("Failed to send Langfuse score (HTTP 401)"),
		).not.toBe(diagnosticCause("Failed to send Langfuse score (HTTP 503)"));
	});

	it("shows each cause once per window and again after it", () => {
		let now = 1_000;
		const gate = createNotificationGate(60_000, () => now);

		expect(gate("cause A")).toBe(true);
		expect(gate("cause A")).toBe(false);
		expect(gate("cause B")).toBe(true);
		now += 60_000;
		expect(gate("cause A")).toBe(true);
	});
});
