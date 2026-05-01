import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRawTrace, rawTracePathForSession } from "./raw-trace.js";

describe("raw trace writer", () => {
	it("mirrors Pi session project directory and filename", () => {
		const path = rawTracePathForSession(
			"/home/devkit/.local/share/tia/pi-agent/sessions/--tmp-project--/2026-05-01T00-00-00Z_abc.jsonl",
			"/raw-root",
		);

		expect(path).toBe(
			"/raw-root/--tmp-project--/2026-05-01T00-00-00Z_abc.jsonl",
		);
	});

	it("appends lossless JSONL records when enabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile =
			"/tmp/pi-agent/sessions/--work--/2026-05-01T00-00-00Z_abc.jsonl";

		appendRawTrace({ rawTraceEnabled: true, rawTraceDir: dir }, sessionFile, {
			type: "tool_result_first_seen",
			timestamp: "2026-05-01T00:00:00.000Z",
			toolCallId: "call_1",
			content: [{ type: "text", text: "important raw output" }],
		});

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

	it("does not write when disabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-raw-trace-test-"));
		const sessionFile = "/tmp/pi-agent/sessions/--work--/session.jsonl";

		appendRawTrace({ rawTraceEnabled: false, rawTraceDir: dir }, sessionFile, {
			type: "provider_request",
			timestamp: "2026-05-01T00:00:00.000Z",
		});

		expect(rawTracePathForSession(sessionFile, dir)).toBe(
			join(dir, "--work--", "session.jsonl"),
		);
	});
});
