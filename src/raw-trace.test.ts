import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
	appendRawTrace,
	defaultRawTraceDir,
	drainRawTraceQueue,
	rawTracePathForSession,
} from "./raw-trace.js";
import {
	captureProviderRequest,
	providerRequestTraceRecord,
	summarizeRawProviderRequestContents,
} from "./telemetry-helpers.js";

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

	it("writes nothing when raw traces are off, or when the session has no file", () => {
		const record = {
			type: "tool_result_first_seen",
			timestamp: "2026-05-01T00:00:00.000Z",
			toolCallId: "call_1",
		};
		const offDir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-off-test-"));
		const noFileDir = mkdtempSync(
			join(tmpdir(), "pi-langfuse-raw-nofile-test-"),
		);
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";

		appendRawTrace(
			{ rawTraceEnabled: false, rawTraceDir: offDir, redactionEnabled: true },
			sessionFile,
			record,
		);
		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: noFileDir, redactionEnabled: true },
			undefined,
			record,
		);
		appendRawTrace(
			{ rawTraceEnabled: true, rawTraceDir: noFileDir, redactionEnabled: true },
			"",
			record,
		);
		drainRawTraceQueue();

		expect(readdirSync(offDir)).toEqual([]);
		expect(readdirSync(noFileDir)).toEqual([]);
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

	it("keeps the final shaped provider summary within its serialized UTF-8 budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-summary-test-"));
		const config: Config = {
			enabled: false,
			publicKey: "pk-test",
			secretKey: "sk-test-secret-value",
			host: "http://localhost",
			userId: "test-user",
			defaultTags: [],
			release: "",
			environment: "",
			traceInputMaxChars: 2_000,
			traceOutputMaxChars: 2_000,
			toolArgsMaxChars: 500,
			toolOutputMaxChars: 2_000,
			captureToolProgress: true,
			captureMessageUpdates: false,
			skipUnpersistedSessions: false,
			captureProviderPayload: false,
			providerPayloadMaxChars: 50_000,
			redactionEnabled: true,
			redactionAdditionalSecrets: ["RAW-COMPACT-CONFIGURED-SECRET"],
			rawTraceEnabled: true,
			rawTraceDir: dir,
			rawTraceProviderRequestMode: "summary",
			localAutostart: false,
			localAutostartDir: "/tmp/langfuse",
			localAutostartHealthUrl: "http://localhost:3100",
			localAutostartTimeoutMs: 200,
			capturePolicy: "full-debug",
		};
		const messages = Array.from({ length: 55 }, (_, index) => ({
			role: "user",
			content:
				"raw message " +
				index +
				": " +
				"ordinary context words ".repeat(20) +
				(index === 54 ? " RAW-COMPACT-CONFIGURED-SECRET" : ""),
		}));
		const systemInstruction = "separate system instruction 🙂 ".repeat(30);
		const capture = captureProviderRequest({
			model: "summary-model",
			system: systemInstruction,
			messages,
		});
		const summary = summarizeRawProviderRequestContents(
			config,
			capture.contents,
			undefined,
			capture.systemInstruction,
		);
		const record = providerRequestTraceRecord({
			captureMode: "summary",
			turnIndex: 0,
			model: "summary-model",
			requestSource: "payload.messages",
			capture,
			systemInstruction: summary.systemPrompt,
			payloadCaptured: false,
			payloadSummary: undefined,
			messagesSummary: summary.messagesSummary,
			messagesSummaryOmitted: summary.messagesSummaryOmitted,
		});
		const sessionFile =
			"/tmp/pi-agent/sessions/--raw-summary--/raw-summary-session.jsonl";

		appendRawTrace(config, sessionFile, {
			...record,
			timestamp: new Date().toISOString(),
		});
		drainRawTraceQueue();

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("provider summary raw path was not created");
		const saved = JSON.parse(readFileSync(rawPath, "utf-8").trim()) as Record<
			string,
			unknown
		>;
		const serializedSummary = JSON.stringify(saved.messagesSummary);
		expect(
			Buffer.byteLength(
				JSON.stringify({
					systemPrompt: saved.systemPrompt,
					messagesSummary: saved.messagesSummary,
				}),
				"utf-8",
			),
		).toBeLessThanOrEqual(4_096);
		expect(Buffer.byteLength(serializedSummary, "utf-8")).toBeLessThanOrEqual(
			4_096,
		);
		expect(Buffer.byteLength(serializedSummary, "utf-8")).toBeLessThan(
			capture.estimatedBytes ?? Infinity,
		);
		expect(saved.estimatedBytes).toBe(capture.estimatedBytes);
		expect(saved.systemPrompt).toContain("separate system instruction");
		expect(JSON.stringify(saved.messagesSummary)).not.toContain(
			"separate system instruction",
		);
		expect(saved.messagesSummaryOmitted).toBeGreaterThan(0);
		expect(serializedSummary).not.toContain("RAW-COMPACT-CONFIGURED-SECRET");
	});
});

describe("persisted raw provider summary after final shaping", () => {
	const SUMMARY_MAX_BYTES = 4_096;
	const PREVIEW_MAX_CHARS = 200;
	const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;
	const LONE_SURROGATE =
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

	function summaryConfig(overrides: Partial<Config> = {}): Config {
		return {
			enabled: false,
			publicKey: "pk-test",
			secretKey: "sk-test-secret-value",
			host: "http://localhost",
			userId: "test-user",
			defaultTags: [],
			release: "",
			environment: "",
			traceInputMaxChars: 2_000,
			traceOutputMaxChars: 2_000,
			toolArgsMaxChars: 500,
			toolOutputMaxChars: 2_000,
			captureToolProgress: true,
			captureMessageUpdates: false,
			skipUnpersistedSessions: false,
			captureProviderPayload: false,
			providerPayloadMaxChars: 50_000,
			redactionEnabled: true,
			redactionAdditionalSecrets: [],
			rawTraceEnabled: true,
			rawTraceDir: mkdtempSync(join(tmpdir(), "pi-langfuse-final-summary-")),
			rawTraceProviderRequestMode: "summary",
			localAutostart: false,
			localAutostartDir: "/tmp/langfuse",
			localAutostartHealthUrl: "http://localhost:3100",
			localAutostartTimeoutMs: 200,
			capturePolicy: "full-debug",
			...overrides,
		};
	}

	/** Run the summary builder and the real writer, then read the persisted JSONL. */
	function persistSummary(
		config: Config,
		messages: unknown[],
		options: { systemInstruction?: string; mode?: "summary" | "full" } = {},
	) {
		const capture = captureProviderRequest({
			model: "summary-model",
			...(options.systemInstruction
				? { system: options.systemInstruction }
				: {}),
			messages,
		});
		const summary = summarizeRawProviderRequestContents(
			config,
			capture.contents,
			undefined,
			capture.systemInstruction,
		);
		const record = providerRequestTraceRecord({
			captureMode: options.mode ?? "summary",
			turnIndex: 0,
			model: "summary-model",
			requestSource: "payload.messages",
			capture,
			systemInstruction:
				options.mode === "full"
					? capture.systemInstruction
					: summary.systemPrompt,
			payloadCaptured: false,
			payloadSummary: undefined,
			messagesSummary: summary.messagesSummary,
			messagesSummaryOmitted: summary.messagesSummaryOmitted,
		});
		const sessionFile = `/tmp/pi-agent/sessions/--final-summary--/${Math.random()
			.toString(16)
			.slice(2)}.jsonl`;
		appendRawTrace(config, sessionFile, {
			...record,
			timestamp: new Date().toISOString(),
		});
		drainRawTraceQueue();
		const rawPath = rawTracePathForSession(sessionFile, config.rawTraceDir);
		if (!rawPath) throw new Error("final summary raw path was not created");
		return {
			capture,
			summaryBeforeWriter: summary,
			saved: JSON.parse(readFileSync(rawPath, "utf-8").trim()) as Record<
				string,
				unknown
			>,
		};
	}

	const previews = (saved: Record<string, unknown>) =>
		(saved.messagesSummary as Array<{ role: string; content?: string }>).map(
			(message) => message.content ?? "",
		);
	const combinedBytes = (saved: Record<string, unknown>) =>
		Buffer.byteLength(
			JSON.stringify({
				...(saved.systemPrompt !== undefined
					? { systemPrompt: saved.systemPrompt }
					: {}),
				messagesSummary: saved.messagesSummary,
			}),
			"utf-8",
		);
	function expectBounded(saved: Record<string, unknown>) {
		expect(combinedBytes(saved)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
		for (const preview of [
			...previews(saved),
			...(typeof saved.systemPrompt === "string" ? [saved.systemPrompt] : []),
		]) {
			expect(Array.from(preview).length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
			expect(preview).not.toMatch(LONE_SURROGATE);
		}
	}

	// Cutting the preview right after the digits makes an SSN-shaped token that
	// the writer's own redaction pass replaces with a longer marker.
	const boundaryMessages = () =>
		Array.from({ length: 20 }, () => ({
			role: "user",
			content: `${"words ".repeat(31)}  111-22-3333XXXX`,
		}));

	it("keeps previews and the combined bytes bounded when truncation exposes a redaction", () => {
		const config = summaryConfig();
		const messages = boundaryMessages();
		const { saved, summaryBeforeWriter } = persistSummary(config, messages);

		// The pre-writer budget holds, so only the final shaped summary can fail.
		expect(
			Buffer.byteLength(
				JSON.stringify({
					messagesSummary: summaryBeforeWriter.messagesSummary,
				}),
				"utf-8",
			),
		).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
		expectBounded(saved);
		expect(JSON.stringify(saved)).not.toMatch(SSN_SHAPE);
		expect(JSON.stringify(saved)).toContain("[REDACTED:");
		// Every message is either kept or counted as omitted.
		const kept = (saved.messagesSummary as unknown[]).filter(
			(_, index) => saved.messagesSummaryOmitted === 0 || index > 0,
		).length;
		expect(kept + (saved.messagesSummaryOmitted as number)).toBe(
			messages.length,
		);
	});

	it("preserves Unicode, omissions, and the omission marker when the writer shrinks the summary", () => {
		const config = summaryConfig();
		const messages = Array.from({ length: 30 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `${"🙂 wörds ".repeat(25)}  111-22-3333XXXX #${index}`,
		}));
		const { saved } = persistSummary(config, messages, {
			systemInstruction: `${"système 🙂 ".repeat(20)}  111-22-3333XXXX`,
		});

		expectBounded(saved);
		expect(JSON.stringify(saved)).not.toMatch(SSN_SHAPE);
		const items = saved.messagesSummary as Array<{
			role: string;
			content: string;
		}>;
		const omitted = saved.messagesSummaryOmitted as number;
		expect(omitted).toBeGreaterThanOrEqual(10);
		expect(items[0]).toEqual({
			role: "system",
			content: `[${omitted} earlier message(s) omitted]`,
		});
		expect(items.length - 1 + omitted).toBe(messages.length);
		// Retained messages are the latest ones, in order.
		const retained = items.slice(1).map((item) => item.content);
		expect(retained.at(-1)).toContain("🙂 wörds");
		expect(items.slice(1).map((item) => item.role)).toEqual(
			messages.slice(omitted).map((message) => message.role),
		);
	});

	it("applies capture policy and identity normalization before enforcing the bounds", () => {
		const home = "/home/summary-person";
		const config = summaryConfig({
			capturePolicy: "conversations",
			identityMode: "pseudonymous",
			identitySalt: "c".repeat(64),
			identityHome: home,
			redactionAdditionalSecrets: [`${home}/exact-secret-literal-1234`],
		});
		const messages = Array.from({ length: 20 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "tool",
			content: `${home}/project ${"tail ".repeat(36)}  111-22-3333XXXX ${home}/exact-secret-literal-1234`,
		}));
		const { saved } = persistSummary(config, messages);
		const text = JSON.stringify(saved);

		expectBounded(saved);
		expect(text).not.toContain(home);
		expect(text).not.toContain("exact-secret-literal-1234");
		expect(text).not.toMatch(SSN_SHAPE);
		expect(text).toContain("~/project");
	});

	it("stays bounded wherever the cut lands among secret-shaped tokens", () => {
		const config = summaryConfig();
		for (let padding = 0; padding < 40; padding += 1) {
			const messages = Array.from({ length: 20 }, (_, index) => ({
				role: "user",
				content: `${"x".repeat(padding)} ${"111-22-3333XXXX 4111 1111 1111 1111Y ".repeat(8)} #${index}`,
			}));
			const { saved } = persistSummary(config, messages);
			expectBounded(saved);
			expect(JSON.stringify(saved)).not.toMatch(SSN_SHAPE);
		}
	});

	it("keeps full provider request mode and an in-budget summary unchanged", () => {
		const config = summaryConfig({ rawTraceProviderRequestMode: "full" });
		const long = `${"full mode keeps every character ".repeat(30)}111-22-3333XXXX`;
		const full = persistSummary(config, [{ role: "user", content: long }], {
			mode: "full",
		}).saved;
		const messages = full.messages as Array<{ content: string }>;
		expect(Array.from(messages[0]?.content ?? "").length).toBeGreaterThan(
			PREVIEW_MAX_CHARS,
		);
		expect(full).not.toHaveProperty("messagesSummary");

		const small = persistSummary(summaryConfig(), [
			{ role: "user", content: "short question" },
			{ role: "assistant", content: "short answer" },
		]).saved;
		expect(small.messagesSummary).toEqual([
			{ role: "user", content: "short question" },
			{ role: "assistant", content: "short answer" },
		]);
		expect(small.messagesSummaryOmitted).toBe(0);
	});

	it("does not bound the summary when redaction cannot expand it", () => {
		const config = summaryConfig({ redactionEnabled: false });
		const { saved, summaryBeforeWriter } = persistSummary(
			config,
			boundaryMessages(),
		);
		expect(saved.messagesSummary).toEqual(summaryBeforeWriter.messagesSummary);
		expectBounded(saved);
	});
});
