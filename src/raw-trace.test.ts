import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendRawTrace,
	defaultRawTraceDir,
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

		const rawPath = rawTracePathForSession(sessionFile, dir);
		if (!rawPath) throw new Error("raw trace path was not created");
		const content = readFileSync(rawPath, "utf-8");
		expect(content).not.toContain("sk-lf-test-secret-1234567890");
		expect(content).toContain("[REDACTED:langfuse-secret-key:");
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
