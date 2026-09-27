import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendRawTrace,
	defaultRawTraceDir,
	drainRawTraceQueue,
	rawTracePathForSession,
} from "./raw-trace.js";

describe("raw trace writer", () => {
	it("defaults under the active agent directory", () => {
		const original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-test";
		try {
			expect(defaultRawTraceDir()).toBe(
				"/tmp/pi-agent-test/langfuse/raw-traces",
			);
		} finally {
			if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = original;
		}
	});

	it("mirrors Pi session project directory and filename", () => {
		const path = rawTracePathForSession(
			"/home/devkit/.local/share/tia/pi-agent/sessions/--tmp-project--/2026-05-01T00-00-00Z_abc.jsonl",
			"/raw-root",
		);

		expect(path).toBe(
			"/raw-root/--tmp-project--/2026-05-01T00-00-00Z_abc.jsonl",
		);
	});

	it("stores sessions without a project directory under the unknown namespace", () => {
		expect(
			rawTracePathForSession(
				"/tmp/pi-agent/sessions/session.jsonl",
				"/raw-root",
			),
		).toBe("/raw-root/--unknown--/session.jsonl");

		expect(rawTracePathForSession("/tmp/session.jsonl", "/raw-root")).toBe(
			"/raw-root/--unknown--/session.jsonl",
		);
	});

	it("appends JSONL records when enabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile =
			"/tmp/pi-agent/sessions/--work--/2026-05-01T00-00-00Z_abc.jsonl";

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
				toolCallId: "call_1",
				content: [{ type: "text", text: "important raw output" }],
			},
		);
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		expect(rawPath).toBeDefined();
		if (!rawPath) throw new Error("raw trace path was not created");
		const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			type: "tool_result_first_seen",
			toolCallId: "call_1",
			content: [{ type: "text", text: "important raw output" }],
		});
	});

	it("redacts secrets before appending records", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";

		appendRawTrace(
			{
				rawTraceEnabled: true,
				rawTraceDir: dir,
				redactionEnabled: true,
				secretKey: "sk-lf-test-secret-1234567890",
			},
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
				content: [
					{
						type: "text",
						text: "LANGFUSE_SECRET_KEY=sk-lf-test-secret-1234567890",
					},
				],
			},
		);
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("raw trace path was not created");
		const content = readFileSync(rawPath, "utf-8");
		expect(content).not.toContain("sk-lf-test-secret-1234567890");
		expect(content).toContain("[REDACTED:langfuse-secret-key:");
	});

	it("redacts JSON-quoted secrets inside record content", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
				content: [
					{ type: "text", text: 'deploy ok {"password":"SuperSecret9"} done' },
				],
			},
		);
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("raw trace path was not created");
		const content = readFileSync(rawPath, "utf-8");
		expect(content).not.toContain("SuperSecret9");
		expect(content).toContain("[REDACTED:password:");
	});

	it("creates trace files and directories with private modes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{ type: "provider_request", timestamp: "2026-05-01T00:00:00.000Z" },
		);
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("raw trace path was not created");
		expect(statSync(rawPath).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(rawPath)).mode & 0o777).toBe(0o700);
	});

	it("tightens permissions of pre-existing trace files before appending", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("expected a raw trace path");
		mkdirSync(dirname(rawPath), { recursive: true });
		writeFileSync(rawPath, '{"type":"provider_request"}\n');
		chmodSync(rawPath, 0o644);

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
			},
		);
		drainRawTraceQueue();

		const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(statSync(rawPath).mode & 0o777).toBe(0o600);
	});

	it("refuses to write through symlinked trace paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("expected a raw trace path");
		mkdirSync(dirname(rawPath), { recursive: true });
		const unrelatedTarget = join(dir, "unrelated-user-file.txt");
		writeFileSync(unrelatedTarget, "do not touch\n");
		symlinkSync(unrelatedTarget, rawPath);

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
			},
		);
		drainRawTraceQueue();

		expect(readFileSync(unrelatedTarget, "utf-8")).toBe("do not touch\n");
		expect(lstatSync(rawPath).isSymbolicLink()).toBe(true);
	});

	it("refuses FIFO and other non-regular trace targets without blocking", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("expected a raw trace path");
		mkdirSync(dirname(rawPath), { recursive: true });
		const mkfifo = spawnSync("mkfifo", [rawPath]);
		if (mkfifo.status !== 0) {
			throw new Error("mkfifo is required for this regression test");
		}

		// A readerless FIFO must not block the synchronous flush queue.
		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{ type: "provider_request", timestamp: "2026-05-01T00:00:00.000Z" },
		);
		drainRawTraceQueue();

		expect(lstatSync(rawPath).isFIFO()).toBe(true);
	});

	it("refuses to modify hardlinked trace targets", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("expected a raw trace path");
		mkdirSync(dirname(rawPath), { recursive: true });
		const victim = join(dir, "victim-user-file.txt");
		writeFileSync(victim, "user bytes\n");
		chmodSync(victim, 0o644);
		linkSync(victim, rawPath);

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
			},
		);
		drainRawTraceQueue();

		// Same inode: neither the bytes nor the mode may change.
		expect(readFileSync(victim, "utf-8")).toBe("user bytes\n");
		expect(statSync(victim).nlink).toBe(2);
		expect(statSync(victim).mode & 0o777).toBe(0o644);
	});

	it("refuses session paths that escape the trace directory", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const traceDir = join(base, "trace-dir");
		const sessionFile = `${traceDir}/sessions/../../outside.jsonl`;

		expect(rawTracePathForSession(sessionFile, traceDir)).toBeUndefined();

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: traceDir, redactionEnabled: true },
			sessionFile,
			{ type: "provider_request", timestamp: "2026-05-01T00:00:00.000Z" },
		);
		drainRawTraceQueue();

		expect(existsSync(join(base, "outside.jsonl"))).toBe(false);
	});

	it("normalizes contained session paths with dot segments", () => {
		expect(
			rawTracePathForSession("/x/sessions/--proj--/./s1.jsonl", "/raw-root"),
		).toBe("/raw-root/--proj--/s1.jsonl");
	});

	it("refuses trace parent components that are symlinks", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-outside-"));
		const sentinel = join(outsideDir, "keep.txt");
		writeFileSync(sentinel, "do not touch\n");
		symlinkSync(outsideDir, join(dir, "--proj--"));
		const sessionFile = `${dir}/sessions/--proj--/s1.jsonl`;

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
			},
		);
		drainRawTraceQueue();

		expect(readFileSync(sentinel, "utf-8")).toBe("do not touch\n");
		expect(existsSync(join(outsideDir, "s1.jsonl"))).toBe(false);
	});

	it("redacts unresolvable quoted secrets before writing raw traces", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		const depth6 = '{"password":"SuperSecret9"}'.replace(
			/"/g,
			`${"\\".repeat(63)}"`,
		);

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
				content: [{ type: "text", text: `deploy ok ${depth6} done` }],
			},
		);
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("raw trace path was not created");
		const content = readFileSync(rawPath, "utf-8");
		expect(content).not.toContain("SuperSecret9");
		expect(content).toContain("[REDACTED:password:");
	});

	it("omits whitespace-prefixed and ambiguous deep values before writing raw traces", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";
		const wrap = (value: string) =>
			`x${"\\".repeat(7)}{"password"${"\\".repeat(7)}:${"\\".repeat(7)}"${value}"}`;

		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "tool_result_first_seen",
				timestamp: "2026-05-01T00:00:00.000Z",
				content: [
					{ type: "text", text: wrap(" SuperSecret9") },
					{ type: "text", text: wrap("\\\\SuperSecret9") },
				],
			},
		);
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("raw trace path was not created");
		const content = readFileSync(rawPath, "utf-8");
		expect(content).not.toContain("SuperSecret9");
	});

	it("does not write when disabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";

		appendRawTrace(
			{ rawTraceEnabled: false, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "provider_request",
				timestamp: "2026-05-01T00:00:00.000Z",
			},
		);

		expect(rawTracePathForSession(sessionFile, dir)).toBe(
			join(dir, "--work--", "session.jsonl"),
		);
	});

	it("keeps disabled fallback paths under the unknown namespace", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/session.jsonl";

		appendRawTrace(
			{ rawTraceEnabled: false, rawTraceDir: dir, redactionEnabled: true },
			sessionFile,
			{
				type: "provider_request",
				timestamp: "2026-05-01T00:00:00.000Z",
			},
		);

		expect(rawTracePathForSession(sessionFile, dir)).toBe(
			join(dir, "--unknown--", "session.jsonl"),
		);
	});
});
