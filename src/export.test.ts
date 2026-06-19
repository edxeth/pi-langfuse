import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { exportRedactedData } from "./export.js";

const baseConfig: Config = {
	enabled: false,
	publicKey: "",
	secretKey: "sk-lf-test-secret-1234567890",
	host: "http://localhost:3100",
	userId: "tester",
	defaultTags: [],
	release: "",
	environment: "",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: true,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: ["custom-super-secret-987654321"],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

describe("redacted export", () => {
	it("creates local-only redacted session and raw-trace derivatives", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-test-"));
		const sessions = join(root, "sessions", "--project--");
		const raw = join(root, "raw", "--project--");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(raw, { recursive: true });
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"LANGFUSE_SECRET_KEY=sk-lf-test-secret-1234567890 custom-super-secret-987654321"}\n',
			{ flag: "w" },
		);
		writeFileSync(
			join(raw, "trace.jsonl"),
			'{"type":"tool_result","authorization":"Bearer abcdefghijklmnopqrstuvwxyz123456"}\n',
			{ flag: "w" },
		);

		const report = exportRedactedData(
			baseConfig,
			`--sessions-dir ${join(root, "sessions")} --raw-dir ${join(root, "raw")} --out ${out} --no-trufflehog`,
		);

		expect(report.summary).toMatchObject({
			files: 2,
			approved: 2,
			rejected: 0,
		});
		const exportedSession = readFileSync(
			join(out, "sessions", "--project--", "session.jsonl"),
			"utf-8",
		);
		const exportedRaw = readFileSync(
			join(out, "raw-traces", "--project--", "trace.jsonl"),
			"utf-8",
		);
		const combined = `${exportedSession}\n${exportedRaw}`;
		expect(combined).not.toContain("sk-lf-test-secret-1234567890");
		expect(combined).not.toContain("custom-super-secret-987654321");
		expect(combined).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz123456");
		expect(combined).toContain("[REDACTED:langfuse-secret-key:");
		expect(combined).toContain("[REDACTED:configured-secret:");
		expect(combined).toContain("[REDACTED:authorization:");
		const reportText = readFileSync(join(out, "report.json"), "utf-8");
		expect(reportText).toContain('"approved": 2');
		expect(reportText).not.toContain(root);
		expect(readFileSync(join(out, "approved.jsonl"), "utf-8")).toContain(
			'"status":"approved"',
		);
		expect(readFileSync(join(out, "rejected.jsonl"), "utf-8")).toBe("\n");
		expect(readFileSync(join(out, "training-index.jsonl"), "utf-8")).toContain(
			'"format":"redacted-jsonl-derivative"',
		);
	});

	it("rejects exports when TruffleHog scan fails", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-test-"));
		const bin = join(root, "bin");
		const sessions = join(root, "sessions", "--project--");
		const out = join(root, "export");
		mkdirSync(bin, { recursive: true });
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(bin, "trufflehog"),
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo trufflehog-test; exit 0; fi\necho scan failed >&2\nexit 2\n',
		);
		chmodSync(join(bin, "trufflehog"), 0o755);
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe content"}\n',
		);

		const originalPath = process.env.PATH;
		process.env.PATH = bin;
		process.env.TRUFFLEHOG_BIN = join(bin, "trufflehog");
		try {
			const report = exportRedactedData(
				baseConfig,
				`--sessions-only --sessions-dir ${join(root, "sessions")} --out ${out}`,
			);
			expect(report.summary).toMatchObject({
				files: 1,
				approved: 0,
				rejected: 1,
			});
			expect(report.trufflehog).toMatchObject({
				enabled: true,
				available: true,
				exitCode: 2,
				findings: 0,
			});
			expect(report.trufflehog?.warning).toContain("exited with status 2");
		} finally {
			process.env.PATH = originalPath;
			delete process.env.TRUFFLEHOG_BIN;
		}
	});

	it("rejects exports when TruffleHog is required but unavailable", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-test-"));
		const sessions = join(root, "sessions", "--project--");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe content"}\n',
		);

		const originalPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const report = exportRedactedData(
				baseConfig,
				`--sessions-only --sessions-dir ${join(root, "sessions")} --out ${out} --require-trufflehog`,
			);
			expect(report.summary).toMatchObject({
				files: 1,
				approved: 0,
				rejected: 1,
			});
			expect(report.trufflehog).toMatchObject({
				enabled: true,
				required: true,
				available: false,
			});
		} finally {
			process.env.PATH = originalPath;
			delete process.env.TRUFFLEHOG_BIN;
		}
	});

	it("strips absolute source path prefixes from exported content", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-path-test-"));
		const sessions = join(root, "sessions", "--project--");
		const raw = join(root, "raw", "--project--");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(raw, { recursive: true });

		const sessionContent = JSON.stringify({
			type: "session",
			cwd: `${root}/my-project`,
		});
		const rawContent = JSON.stringify({
			type: "tool_execution_start",
			sessionFile: `${root}/sessions/--project--/s.jsonl`,
			args: { command: `cd ${root}/my-project && npm test` },
		});

		writeFileSync(join(sessions, "session.jsonl"), `${sessionContent}\n`);
		writeFileSync(join(raw, "trace.jsonl"), `${rawContent}\n`);

		exportRedactedData(
			baseConfig,
			`--sessions-dir ${join(root, "sessions")} --raw-dir ${join(root, "raw")} --out ${out} --no-trufflehog`,
		);

		const exportedSession = readFileSync(
			join(out, "sessions", "--project--", "session.jsonl"),
			"utf-8",
		);
		const exportedRaw = readFileSync(
			join(out, "raw-traces", "--project--", "trace.jsonl"),
			"utf-8",
		);

		// Absolute paths should be replaced with [PATH_ROOT]
		const combined = `${exportedSession}\n${exportedRaw}`;
		expect(combined).not.toContain(root);
		expect(combined).toContain("[PATH_ROOT]");
		expect(combined).toContain("[PATH_ROOT]/my-project");
		expect(combined).toContain("cd [PATH_ROOT]/my-project && npm test");

		// report.json should not contain the absolute path either
		const reportText = readFileSync(join(out, "report.json"), "utf-8");
		expect(reportText).not.toContain(root);
	});

	it("always redacts in export regardless of redactionEnabled config", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langforce-unred-test-"));
		const sessions = join(root, "sessions", "--test--");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });

		writeFileSync(
			join(sessions, "session.jsonl"),
			`${JSON.stringify({ secret: "sk-lf-test-secret-1234567890 Bearer abcdefghijklmnopqrstuvwxyz1234567890" })}\n`,
		);

		const unredactedConfig: Config = {
			...baseConfig,
			redactionEnabled: false,
		};

		exportRedactedData(
			unredactedConfig,
			`--sessions-only --sessions-dir ${join(root, "sessions")} --out ${out} --no-trufflehog`,
		);

		const exported = readFileSync(
			join(out, "sessions", "--test--", "session.jsonl"),
			"utf-8",
		);
		expect(exported).not.toContain("sk-lf-test-secret-1234567890");
		expect(exported).not.toContain(
			"Bearer abcdefghijklmnopqrstuvwxyz1234567890",
		);
		expect(exported).toContain("[REDACTED:");
	});
});
