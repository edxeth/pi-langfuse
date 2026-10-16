import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, resolveConfig } from "./config.js";
import { exportRedactedData } from "./export.js";
import { shapeRawTraceRecord } from "./payload-policy.js";

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

	it("redacts JSON-quoted passwords so approval stays truthful", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-json-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "session.jsonl"),
			`${JSON.stringify({
				type: "message",
				content: 'deploy ok {"password":"SuperSecret9"} done',
			})}\n`,
		);

		const report = exportRedactedData(
			baseConfig,
			`--sessions-only --sessions-dir ${join(root, "sessions")} --out ${out} --no-trufflehog`,
		);

		const exported = readFileSync(
			join(out, "sessions", "session.jsonl"),
			"utf-8",
		);
		expect(exported).not.toContain("SuperSecret9");
		expect(exported).toContain("[REDACTED:password:");
		// Redaction cleaned the value, so the derivative is genuinely approvable.
		expect(report.summary).toMatchObject({
			files: 1,
			approved: 1,
			rejected: 0,
		});
	});

	it("keeps argv array boundaries so output directories may contain spaces", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-argv-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "my export");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe content"}\n',
		);

		const report = exportRedactedData(baseConfig, [
			"--sessions-only",
			"--sessions-dir",
			join(root, "sessions"),
			"--out",
			out,
			"--no-trufflehog",
		]);

		// The space-separated directory must stay one destination.
		expect(existsSync(join(root, "my"))).toBe(false);
		expect(existsSync(join(out, "sessions", "session.jsonl"))).toBe(true);
		// The returned report names the real destination, not ".".
		expect(report.outDir).toBe(resolve(out));
		expect(report.summary).toMatchObject({ files: 1, approved: 1 });
	});

	it("honors quoted string arguments with spaces", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-quoted-test-"));
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe content"}\n',
		);

		const report = exportRedactedData(
			baseConfig,
			`--sessions-only --sessions-dir ${sessions} --out '${join(root, "my export")}' --no-trufflehog`,
		);

		expect(
			existsSync(join(root, "my export", "sessions", "session.jsonl")),
		).toBe(true);
		expect(report.outDir).toBe(resolve(join(root, "my export")));
	});

	it("rejects a nonempty export destination without writing or deleting anything", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-dest-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(out, { recursive: true });
		const staleFile = join(out, "stale-previous-run.jsonl");
		writeFileSync(staleFile, "UNREDACTED_MARKER_77\n");
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe content"}\n',
		);

		const report = exportRedactedData(
			baseConfig,
			`--sessions-only --sessions-dir ${sessions} --out ${out} --no-trufflehog`,
		);

		// The stale user file survives untouched and no export artifacts appear.
		expect(readFileSync(staleFile, "utf-8")).toBe("UNREDACTED_MARKER_77\n");
		expect(existsSync(join(out, "report.json"))).toBe(false);
		expect(existsSync(join(out, "sessions"))).toBe(false);
		expect(report.error).toBeDefined();
		expect(report.error?.code).toBe("destination-not-empty");
		expect(report.files).toHaveLength(0);
	});

	it("allows re-export into an empty existing destination", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-empty-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(out, { recursive: true });
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe content"}\n',
		);

		const report = exportRedactedData(
			baseConfig,
			`--sessions-only --sessions-dir ${sessions} --out ${out} --no-trufflehog`,
		);

		expect(report.error).toBeUndefined();
		expect(report.summary).toMatchObject({ files: 1, approved: 1 });
		expect(existsSync(join(out, "report.json"))).toBe(true);
	});

	it("rejects a destination path that is an existing file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-file-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "occupied");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(out, "not a directory\n");

		const report = exportRedactedData(
			baseConfig,
			`--sessions-only --sessions-dir ${sessions} --out ${out} --no-trufflehog`,
		);

		expect(readFileSync(out, "utf-8")).toBe("not a directory\n");
		expect(report.error?.code).toBe("destination-not-a-directory");
	});

	it("rejects a scanner-required export with no files when the scanner is unavailable", () => {
		const root = mkdtempSync(
			join(tmpdir(), "pi-langfuse-export-empty-scan-test-"),
		);
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });

		const originalPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const report = exportRedactedData(
				baseConfig,
				`--sessions-only --sessions-dir ${sessions} --out ${out} --require-trufflehog`,
			);

			// The missing required scanner must fail the export itself, not just
			// the (zero) individual files.
			expect(report.summary).toMatchObject({
				files: 0,
				approved: 0,
				rejected: 0,
			});
			expect(report.status).toBe("rejected");
			expect(report.trufflehog).toMatchObject({
				enabled: true,
				required: true,
				available: false,
			});
			expect(readFileSync(join(out, "REVIEW.md"), "utf-8")).toContain(
				"Status: rejected",
			);
		} finally {
			process.env.PATH = originalPath;
			delete process.env.TRUFFLEHOG_BIN;
		}
	});

	it("approves a scanner-required export with zero files when the scan succeeds", () => {
		const root = mkdtempSync(
			join(tmpdir(), "pi-langfuse-export-scan-ok-test-"),
		);
		const bin = join(root, "bin");
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(bin, { recursive: true });
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(bin, "trufflehog"),
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo trufflehog-test; exit 0; fi\nexit 0\n',
		);
		chmodSync(join(bin, "trufflehog"), 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = bin;
		process.env.TRUFFLEHOG_BIN = join(bin, "trufflehog");
		try {
			const report = exportRedactedData(
				baseConfig,
				`--sessions-only --sessions-dir ${sessions} --out ${out} --require-trufflehog`,
			);

			expect(report.summary).toMatchObject({
				files: 0,
				approved: 0,
				rejected: 0,
			});
			expect(report.status).toBe("approved");
		} finally {
			process.env.PATH = originalPath;
			delete process.env.TRUFFLEHOG_BIN;
		}
	});

	it("redacts truncated and deep-escaped secret tails so approval stays truthful", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-tail-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		const depth6 = '{"password":"SuperSecret9"}'.replace(
			/"/g,
			`${"\\".repeat(63)}"`,
		);
		writeFileSync(
			join(sessions, "session.jsonl"),
			// Second line simulates a truncated file tail: JSON.parse fails and
			// the value ends mid-string with no closing quote anywhere. The
			// third line carries a depth-6 escaped assignment.
			`${JSON.stringify({ type: "message", content: "safe" })}\n${JSON.stringify(
				{
					type: "message",
					content: 'log tail {"password":"SuperSecret9',
				},
			).slice(0, -2)}\n${JSON.stringify({
				type: "message",
				content: `see ${depth6}`,
			})}\n`,
		);

		const report = exportRedactedData(
			baseConfig,
			`--sessions-only --sessions-dir ${join(root, "sessions")} --out ${out} --no-trufflehog`,
		);

		// Fail-closed redaction resolves both lines: the truncated line is
		// hash-replaced via the quoted-value extent found against the outer
		// JSONL quote, and the depth-6 line is structure-preservingly
		// replaced. The derivative is clean and approval is truthful.
		const exported = readFileSync(
			join(out, "sessions", "session.jsonl"),
			"utf-8",
		);
		expect(exported).not.toContain("SuperSecret9");
		expect(exported).toContain("[REDACTED:password:");
		expect(report.summary).toMatchObject({
			files: 1,
			approved: 1,
			rejected: 0,
		});
	});

	it("creates export artifacts with owner-only modes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-export-modes-test-"));
		const sessions = join(root, "sessions");
		const out = join(root, "export");
		mkdirSync(sessions, { recursive: true });
		// The required scanner is unavailable, so the derivative is rejected;
		// export artifacts must not be group/world readable regardless of
		// approval state.
		writeFileSync(
			join(sessions, "session.jsonl"),
			'{"type":"message","content":"safe"}\n',
		);

		const originalPath = process.env.PATH;
		process.env.PATH = "";
		const report = (() => {
			try {
				return exportRedactedData(
					baseConfig,
					`--sessions-only --sessions-dir ${sessions} --out ${out} --require-trufflehog`,
				);
			} finally {
				process.env.PATH = originalPath;
			}
		})();

		expect(report.summary).toMatchObject({
			files: 1,
			approved: 0,
			rejected: 1,
		});
		expect(statSync(out).mode & 0o777).toBe(0o700);
		expect(statSync(join(out, "sessions")).mode & 0o777).toBe(0o700);
		expect(statSync(join(out, "sessions", "session.jsonl")).mode & 0o777).toBe(
			0o600,
		);
		for (const artifact of [
			"report.json",
			"manifest.jsonl",
			"approved.jsonl",
			"rejected.jsonl",
			"training-index.jsonl",
			"REVIEW.md",
		]) {
			expect(statSync(join(out, artifact)).mode & 0o777).toBe(0o600);
		}
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

describe("training format export", () => {
	const SALT = "ab".repeat(32);
	const HOME = "/home/jdoe";
	const SECRET = "sk-lf-test-secret-1234567890";
	const originalEnv = { ...process.env };

	afterEach(() => {
		for (const key of ["PATH", "PI_LANGFUSE_CONFIG"]) {
			const original = originalEnv[key];
			if (original === undefined) delete process.env[key];
			else process.env[key] = original;
		}
		delete process.env.TRUFFLEHOG_BIN;
		vi.restoreAllMocks();
	});

	type FakeScanner = {
		/** Exit status of the scan run; the version probe always succeeds. */
		exit?: number;
		/** Kill the scan process with SIGTERM instead of exiting. */
		signal?: boolean;
		/** One JSON finding line printed on stdout. */
		finding?: boolean;
		/** Lines printed verbatim on stdout, after any finding. */
		stdout?: string[];
		/** Lines printed verbatim on stderr. */
		stderr?: string[];
		/** Print more output than the export's capture buffer holds. */
		flood?: boolean;
		/** Exit status of the version probe; default 0 (the scanner exists). */
		versionExit?: number;
	};

	/**
	 * A faithful fake scanner: answers the version probe, records the arguments
	 * of the scan run and the review records visible to it, and behaves as
	 * configured. The real scanner is never run by these tests.
	 */
	function installScanner(root: string, behavior: FakeScanner = {}) {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		const argsLog = join(root, "scanner-args.txt");
		const seenLog = join(root, "scanner-saw-records.txt");
		const stdoutLines = join(root, "scanner-stdout.txt");
		const stderrLines = join(root, "scanner-stderr.txt");
		writeFileSync(stdoutLines, (behavior.stdout ?? []).join("\n"));
		writeFileSync(stderrLines, (behavior.stderr ?? []).join("\n"));
		writeFileSync(
			join(bin, "trufflehog"),
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo trufflehog-test; exit ${behavior.versionExit ?? 0}; fi
printf '%s\n' "$@" > "${argsLog}"
for last; do :; done
cat "$last"/training-index.*.jsonl > "${seenLog}" 2>/dev/null
${behavior.finding ? `echo '{"DetectorName":"Fake","Raw":"x"}'` : ""}
cat "${stdoutLines}"
cat "${stderrLines}" >&2
${behavior.signal ? "kill -TERM $$" : ""}
${behavior.flood ? "exec head -c 25000000 /dev/zero" : ""}
exit ${behavior.exit ?? 0}
`,
		);
		chmodSync(join(bin, "trufflehog"), 0o755);
		process.env.PATH = `${bin}:${originalEnv.PATH}`;
		process.env.TRUFFLEHOG_BIN = join(bin, "trufflehog");
		return { argsLog, seenLog };
	}

	/** Live capture settings that would leak identity: raw, repo kept, unredacted. */
	const liveConfig: Config = {
		...baseConfig,
		redactionEnabled: false,
		identityMode: "raw",
		identityKeepRepo: true,
		identityHome: HOME,
		userId: "jdoe",
	};

	function layout() {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-training-test-"));
		const configPath = join(root, "config", "pi-langfuse.json");
		// Never the user's real config: salt creation must land under root.
		process.env.PI_LANGFUSE_CONFIG = configPath;
		const dirName = "--home-jdoe-project--";
		// Format exports require a completed scan; tests that vary the scanner
		// install their own over this clean one.
		installScanner(root);
		return {
			root,
			configPath,
			sessions: join(root, "sessions"),
			raw: join(root, "raw"),
			rawDir: join(root, "raw", dirName),
			out: join(root, "export"),
		};
	}

	/** Raw records as the real raw producer's shaping boundary emits them. */
	function shaped(record: Record<string, unknown>) {
		return shapeRawTraceRecord(
			{
				redactionEnabled: false,
				secretKey: "unused",
				redactionAdditionalSecrets: [],
			},
			record,
		);
	}

	function pair(
		turnIndex: number,
		text: string,
		answer: Record<string, unknown> = {},
		user = "please help",
	) {
		return [
			shaped({
				type: "provider_request",
				turnIndex,
				captureMode: "full",
				requestSource: "payload.context",
				messageCount: 2,
				messages: [
					{ role: "system", content: "SYS" },
					{ role: "user", content: [{ type: "text", text: user }] },
				],
			}),
			shaped({
				type: "assistant_output",
				turnIndex,
				text,
				toolCalls: [],
				stopReason: "stop",
				...answer,
			}),
		];
	}

	function writeRaw(dir: string, records: unknown[], name = "session.jsonl") {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(
			file,
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		return file;
	}

	function run(
		paths: ReturnType<typeof layout>,
		extra: string[],
		config: Config = liveConfig,
	) {
		return exportRedactedData(config, [
			"--raw-dir",
			paths.raw,
			"--sessions-dir",
			paths.sessions,
			"--out",
			paths.out,
			...extra,
		]);
	}

	function listTree(root: string): string[] {
		return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? [
						entry.name,
						...listTree(join(root, entry.name)).map((p) => join(entry.name, p)),
					]
				: [entry.name],
		);
	}

	function trainingRecords(out: string, format: string) {
		return readFileSync(join(out, `training-index.${format}.jsonl`), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("writes review records from approved raw derivatives for each format", () => {
		for (const format of ["openai-chat", "anthropic-messages", "sharegpt"]) {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "the answer"));

			const report = run(paths, ["--raw-only", "--format", format]);

			expect(report.status).toBe("approved");
			expect(report.training).toMatchObject({
				format,
				output: `training-index.${format}.jsonl`,
				candidates: 1,
				accepted: 1,
				rejected: 0,
				rejectionReasons: {},
			});
			const [record] = trainingRecords(paths.out, format);
			expect(record).toMatchObject({ format, consent: "unknown", license: "" });
			expect(JSON.stringify(record?.example)).toContain("the answer");
			// The legacy artifacts stay alongside the format file.
			expect(existsSync(join(paths.out, "training-index.jsonl"))).toBe(true);
		}
	});

	it("forces pseudonymous identity and hides names in artifacts whatever live capture says", () => {
		const paths = layout();
		mkdirSync(join(paths.root, "config"), { recursive: true });
		writeFileSync(paths.configPath, JSON.stringify({ identitySalt: SALT }));
		const records = [
			{
				type: "agent_prompt_start",
				cwd: `${HOME}/project`,
				sourceMetadata: {
					repo_name: "acme-private",
					repo_identity: "github.com/acme/private",
				},
			},
			...pair(
				0,
				"answer",
				{},
				`open ${HOME}/project/a.ts with ${SECRET} and salt ${SALT}`,
			),
		];
		const source = writeRaw(paths.rawDir, records);
		const sourceBefore = readFileSync(source, "utf-8");
		writeFileSync(join(paths.root, "sessions-placeholder"), "");
		mkdirSync(join(paths.sessions, "--home-jdoe-project--"), {
			recursive: true,
		});
		writeFileSync(
			join(paths.sessions, "--home-jdoe-project--", "s.jsonl"),
			`${JSON.stringify({ type: "session", cwd: `${HOME}/project` })}\n`,
		);

		const report = run(paths, ["--format", "openai-chat"]);

		expect(report.error).toBeUndefined();
		expect(report.training?.accepted).toBe(1);
		// No artifact name or content carries the user name, secret, or salt.
		const tree = listTree(paths.out);
		expect(tree).toContain(
			join("raw-traces", "--~-project--", "session.jsonl"),
		);
		expect(tree).toContain(join("sessions", "--~-project--", "s.jsonl"));
		expect(tree.join("\n")).not.toContain("jdoe");
		for (const name of tree) {
			const path = join(paths.out, name);
			if (!statSync(path).isFile()) continue;
			const content = readFileSync(path, "utf-8");
			for (const leaked of [
				"jdoe",
				SECRET,
				SALT,
				"acme-private",
				"github.com/acme/private",
			]) {
				expect(content, `${name} leaks ${leaked}`).not.toContain(leaked);
			}
		}
		const [record] = trainingRecords(paths.out, "openai-chat");
		expect(record?.source).toMatchObject({
			path: join("raw-traces", "--~-project--", "session.jsonl"),
		});
		const user = JSON.stringify(record?.example);
		expect(user).toContain("~/project/a.ts");
		expect(user).toContain("[REDACTED:identity-salt]");
		expect(user).toContain("[REDACTED:langfuse-secret-key:");
		// Repository identity is hashed although the live config kept it.
		expect(
			readFileSync(
				join(paths.out, "raw-traces", "--~-project--", "session.jsonl"),
				"utf-8",
			),
		).toMatch(/pseudonym-repo-name-[0-9a-f]{24}/);
		for (const artifact of [
			"manifest.jsonl",
			"approved.jsonl",
			"training-index.jsonl",
		]) {
			expect(readFileSync(join(paths.out, artifact), "utf-8")).toContain(
				"--~-project--",
			);
		}
		// The source file and its directory name are untouched.
		expect(readFileSync(source, "utf-8")).toBe(sourceBefore);
		expect(existsSync(join(paths.raw, "--home-jdoe-project--"))).toBe(true);
		expect(JSON.parse(readFileSync(paths.configPath, "utf-8"))).toEqual({
			identitySalt: SALT,
		});
	});

	it("creates the identity salt in the configured path when none exists", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));
		expect(existsSync(paths.configPath)).toBe(false);

		const report = run(paths, ["--raw-only", "--format", "sharegpt"]);

		expect(report.error).toBeUndefined();
		expect(
			JSON.parse(readFileSync(paths.configPath, "utf-8")).identitySalt,
		).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
	});

	it("does not touch the config or output when the destination is not empty", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));
		mkdirSync(paths.out, { recursive: true });
		writeFileSync(join(paths.out, "keep.txt"), "mine");

		const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(report.error?.code).toBe("destination-not-empty");
		expect(readFileSync(join(paths.out, "keep.txt"), "utf-8")).toBe("mine");
		expect(readdirSync(paths.out)).toEqual(["keep.txt"]);
		expect(existsSync(paths.configPath)).toBe(false);
	});

	it("fails closed without output when the identity salt is unavailable", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));
		mkdirSync(join(paths.root, "config"), { recursive: true });
		writeFileSync(paths.configPath, "{ not json");

		const malformed = run(paths, ["--raw-only", "--format", "openai-chat"]);
		expect(malformed.error?.code).toBe("identity-unavailable");
		expect(readFileSync(paths.configPath, "utf-8")).toBe("{ not json");
		expect(existsSync(paths.out)).toBe(false);

		writeFileSync(paths.configPath, JSON.stringify({ identitySalt: "short" }));
		const invalidSalt = run(paths, ["--raw-only", "--format", "openai-chat"]);
		expect(invalidSalt.error?.code).toBe("identity-unavailable");
		expect(JSON.parse(readFileSync(paths.configPath, "utf-8"))).toEqual({
			identitySalt: "short",
		});
		expect(existsSync(paths.out)).toBe(false);

		const unusable = run(paths, ["--raw-only", "--format", "openai-chat"], {
			...liveConfig,
			identityError: "config is broken",
		});
		expect(unusable.error?.code).toBe("identity-unavailable");
		expect(existsSync(paths.out)).toBe(false);
	});

	it("fails closed when the identity salt cannot be persisted", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));
		// A regular file where the config directory should be: the salt can
		// neither be read nor created.
		const blocker = join(paths.root, "blocker");
		writeFileSync(blocker, "not a directory");
		process.env.PI_LANGFUSE_CONFIG = join(blocker, "pi-langfuse.json");

		const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(report.error).toMatchObject({
			code: "identity-unavailable",
			message: expect.stringContaining(
				"none is available (pi-langfuse identity salt unavailable for",
			),
		});
		expect(readFileSync(blocker, "utf-8")).toBe("not a directory");
		expect(existsSync(paths.out)).toBe(false);
	});

	it.each([
		[["--format"], "invalid-export-option"],
		[["--format", "jsonl"], "invalid-export-option"],
		[
			["--format", "openai-chat", "--consent", "maybe"],
			"invalid-export-option",
		],
		[["--format", "openai-chat", "--consent"], "invalid-export-option"],
		[
			["--format", "openai-chat", "--license", "x".repeat(201)],
			"invalid-export-option",
		],
		[
			["--format", "openai-chat", "--license", "two\nlines"],
			"invalid-export-option",
		],
		[["--format", "openai-chat", "--sessions-only"], "invalid-export-option"],
		// The external scan is mandatory for review records, never skippable.
		[["--format", "openai-chat", "--no-trufflehog"], "invalid-export-option"],
		[["--no-trufflehog", "--format", "openai-chat"], "invalid-export-option"],
		// A value-taking option followed by a recognized option has no value and
		// must not swallow that option (here: the denial).
		[
			["--format", "openai-chat", "--license", "--consent", "denied"],
			"invalid-export-option",
		],
		[
			["--format", "openai-chat", "--out", "--consent", "denied"],
			"invalid-export-option",
		],
		[["--format", "--consent", "denied"], "invalid-export-option"],
		[["--format", "openai-chat", "--raw-dir"], "invalid-export-option"],
		[["--format", "openai-chat", "--consent", "denied"], "consent-denied"],
	])("refuses %j before writing anything", (extra, code) => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));

		const report = run(paths, extra);

		expect(report.error?.code).toBe(code);
		expect(report.status).toBe("failed");
		expect(existsSync(paths.out)).toBe(false);
		expect(existsSync(paths.configPath)).toBe(false);
	});

	it("keeps an explicit empty license valid and still warns", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));

		const report = run(paths, [
			"--raw-only",
			"--format",
			"openai-chat",
			"--license",
			"",
			"--consent",
			"granted",
		]);

		expect(report.error).toBeUndefined();
		expect(report.training).toMatchObject({ accepted: 1, license: "" });
		expect(report.training?.warnings.join("\n")).toContain(
			"No export license is declared",
		);
	});

	it("names the option whose value is missing", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));

		const report = run(paths, [
			"--raw-only",
			"--format",
			"openai-chat",
			"--license",
			"--consent",
			"denied",
		]);

		expect(report.error?.message).toContain("--license requires a value");
		expect(existsSync(paths.out)).toBe(false);
	});

	describe("malformed declarations in the config file", () => {
		function exportWithFile(
			declarations: Record<string, unknown>,
			extra: string[] = [],
		) {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));
			mkdirSync(join(paths.root, "config"), { recursive: true });
			writeFileSync(
				paths.configPath,
				JSON.stringify({ identitySalt: SALT, ...declarations }),
			);
			const report = exportRedactedData(resolveConfig({}), [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
				"--format",
				"openai-chat",
				...extra,
			]);
			return { paths, report };
		}

		it.each([
			["a consent array", { exportConsent: ["granted"] }, "exportConsent"],
			["an empty consent array", { exportConsent: [] }, "exportConsent"],
			["a null consent", { exportConsent: null }, "exportConsent"],
			["a boolean consent", { exportConsent: true }, "exportConsent"],
			["a license object", { exportLicense: {} }, "exportLicense"],
			["a license number", { exportLicense: 7 }, "exportLicense"],
		])("refuses %s without writing anything", (_name, declarations, key) => {
			const { paths, report } = exportWithFile(declarations);

			expect(report.status).toBe("failed");
			expect(report.error?.code).toBe("invalid-export-option");
			expect(report.error?.message).toContain(
				`${key} in the config file must be a string`,
			);
			expect(existsSync(paths.out)).toBe(false);
		});

		it("refuses an unknown consent word instead of defaulting it", () => {
			const { report } = exportWithFile({ exportConsent: "yes" });
			expect(report.error?.code).toBe("invalid-export-option");
		});

		it("lets a flag replace the malformed value it overrides, and only that one", () => {
			const consentFlag = exportWithFile({ exportConsent: ["granted"] }, [
				"--consent",
				"granted",
			]);
			expect(consentFlag.report.error).toBeUndefined();
			expect(consentFlag.report.training?.consent).toBe("granted");

			const wrongFlag = exportWithFile({ exportLicense: {} }, [
				"--consent",
				"granted",
			]);
			expect(wrongFlag.report.error?.message).toContain("exportLicense");
		});

		it("does not affect a legacy export or live telemetry configuration", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));
			mkdirSync(join(paths.root, "config"), { recursive: true });
			writeFileSync(
				paths.configPath,
				JSON.stringify({ exportConsent: ["granted"], exportLicense: {} }),
			);
			const config = resolveConfig({});

			expect(config.identityError).toBeUndefined();
			const report = exportRedactedData(config, [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
			]);
			expect(report.error).toBeUndefined();
			expect(report.status).toBe("approved");
		});

		it("applies the defaults only to genuinely missing declarations", () => {
			const { report } = exportWithFile({});
			expect(report.error).toBeUndefined();
			expect(report.training).toMatchObject({
				consent: "unknown",
				license: "",
			});
		});
	});

	it("warns on undeclared consent and license and never infers either", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));
		const notify = vi.fn();

		const report = exportRedactedData(
			liveConfig,
			[
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
				"--format",
				"openai-chat",
			],
			{ ui: { notify } },
		);

		const warnings = report.training?.warnings.join("\n") ?? "";
		expect(warnings).toContain("No export license is declared");
		expect(warnings).toContain("consent is undeclared");
		expect(warnings).toContain("Pseudonymous is not anonymous");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("No export license is declared"),
			"warning",
		);
		const [record] = trainingRecords(paths.out, "openai-chat");
		expect(record).toMatchObject({ consent: "unknown", license: "" });
		expect(record?.notice).toContain(
			"not a certified provider-upload-ready dataset",
		);
		const review = readFileSync(join(paths.out, "REVIEW.md"), "utf-8");
		expect(review).toContain("Consent declaration: unknown");
		expect(review).toContain("not a certified provider-upload-ready dataset");
	});

	it("records declared consent and license from flags or config, flags winning, and redacts the license text", () => {
		const fromConfig = layout();
		writeRaw(fromConfig.rawDir, pair(0, "answer"));
		const configured = run(
			fromConfig,
			["--raw-only", "--format", "openai-chat"],
			{
				...liveConfig,
				exportConsent: "granted",
				exportLicense: "config-license",
			},
		);
		expect(configured.training).toMatchObject({
			consent: "granted",
			license: "config-license",
		});
		expect(configured.training?.warnings.join("\n")).not.toContain(
			"license is declared",
		);
		expect(configured.training?.warnings.join("\n")).not.toContain(
			"consent is undeclared",
		);

		const fromFlags = layout();
		writeRaw(fromFlags.rawDir, pair(0, "answer"));
		const flagged = run(
			fromFlags,
			[
				"--raw-only",
				"--format",
				"anthropic-messages",
				"--consent",
				"granted",
				"--license",
				`Internal ${SECRET}`,
			],
			{
				...liveConfig,
				exportConsent: "unknown",
				exportLicense: "config-license",
			},
		);
		expect(flagged.training?.consent).toBe("granted");
		expect(flagged.training?.license).not.toContain(SECRET);
		const [record] = trainingRecords(fromFlags.out, "anthropic-messages");
		expect(record?.consent).toBe("granted");
		expect(String(record?.license)).toContain("Internal [REDACTED:");
		expect(String(record?.license)).not.toContain(SECRET);
	});

	it("reports rejection reasons and counts per sample", () => {
		const paths = layout();
		writeRaw(paths.rawDir, [
			...pair(0, "good"),
			...pair(1, "cut", { stopReason: "length" }),
			...pair(2, "aborted", { stopReason: "aborted" }),
			...pair(3, "also cut", { stopReason: "length" }),
		]);

		const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(report.training).toMatchObject({
			candidates: 4,
			accepted: 1,
			rejected: 3,
			rejectionReasons: {
				"stop-reason-aborted": 1,
				"stop-reason-length": 2,
			},
		});
		expect(trainingRecords(paths.out, "openai-chat")).toHaveLength(1);
		expect(readFileSync(join(paths.out, "REVIEW.md"), "utf-8")).toContain(
			"stop-reason-length: 2",
		);
		const written = JSON.parse(
			readFileSync(join(paths.out, "report.json"), "utf-8"),
		);
		expect(written.training.rejectionReasons).toEqual({
			"stop-reason-aborted": 1,
			"stop-reason-length": 2,
		});
	});

	it("rejects legacy and summary raw records instead of fabricating samples", () => {
		const paths = layout();
		const [legacyRequest, legacyAnswer] = pair(0, "legacy answer") as Array<
			Record<string, unknown>
		>;
		delete legacyRequest?.captureProvenance;
		const summary = shaped({
			type: "provider_request",
			turnIndex: 1,
			captureMode: "summary",
			requestSource: "payload.context",
			messagesSummary: [{ role: "user", content: "x" }],
			fullMessagesOmitted: true,
		});
		writeRaw(paths.rawDir, [
			legacyRequest,
			legacyAnswer,
			summary,
			pair(1, "summary answer")[1],
		]);

		const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(report.training?.accepted).toBe(0);
		expect(report.training?.rejectionReasons).toEqual({
			"request-capture-provenance-missing": 1,
			"request-not-full-capture": 1,
		});
		expect(
			readFileSync(
				join(paths.out, "training-index.openai-chat.jsonl"),
				"utf-8",
			),
		).toBe("");
	});

	it("rejects a sample whose generated record carries a secret the copy never saw", () => {
		const paths = layout();
		// A derivative path flows into the record's source reference but is not
		// content the copy redacts; the generated record is scanned again.
		writeRaw(paths.rawDir, pair(0, "answer"), `${SECRET}.jsonl`);

		const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(report.training).toMatchObject({
			accepted: 0,
			rejectionReasons: { "residual-secret": 1 },
		});
		expect(
			readFileSync(
				join(paths.out, "training-index.openai-chat.jsonl"),
				"utf-8",
			),
		).not.toContain(SECRET);
	});

	it("refuses two sources that map to one pseudonymized derivative name", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "a"));
		writeRaw(join(paths.raw, "--~-project--"), pair(0, "b"));

		const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(report.error?.code).toBe("derivative-name-collision");
		expect(existsSync(paths.out)).toBe(false);
	});

	it("keeps the legacy export unchanged without --format", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));

		const report = run(paths, ["--raw-only"]);

		expect(report.training).toBeUndefined();
		expect(listTree(paths.out)).toContain(
			join("raw-traces", "--home-jdoe-project--", "session.jsonl"),
		);
		expect(
			readdirSync(paths.out).filter((name) =>
				name.startsWith("training-index."),
			),
		).toEqual(["training-index.jsonl"]);
		expect(existsSync(paths.configPath)).toBe(false);
	});

	it("creates review records with owner-only modes", () => {
		const paths = layout();
		writeRaw(paths.rawDir, pair(0, "answer"));

		run(paths, ["--raw-only", "--format", "openai-chat"]);

		expect(
			statSync(join(paths.out, "training-index.openai-chat.jsonl")).mode &
				0o777,
		).toBe(0o600);
		expect(
			statSync(join(paths.out, "raw-traces", "--~-project--")).mode & 0o777,
		).toBe(0o700);
	});

	describe("scanner", () => {
		it("scans detection-only and sees the generated review records", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));
			const { argsLog, seenLog } = installScanner(paths.root);

			const report = exportRedactedData(liveConfig, [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
				"--require-trufflehog",
				"--format",
				"openai-chat",
			]);

			const args = readFileSync(argsLog, "utf-8").trim().split("\n");
			expect(args.slice(0, 2)).toEqual(["filesystem", "--json"]);
			expect(args).toContain("--no-verification");
			expect(args).toContain("--no-update");
			expect(args.at(-1)).toBe(paths.out);
			expect(readFileSync(seenLog, "utf-8")).toContain(
				"pi-langfuse.training-example/v1",
			);
			expect(report.status).toBe("approved");
			expect(report.training?.accepted).toBe(1);
			expect(report.training?.warnings.join("\n")).not.toContain(
				"did not complete cleanly",
			);
		});

		it("scans the legacy export detection-only too", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));
			const { argsLog } = installScanner(paths.root);

			exportRedactedData(liveConfig, [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
			]);

			expect(readFileSync(argsLog, "utf-8")).toContain("--no-verification");
		});

		it("drops every review record when the scanner reports a finding", () => {
			const paths = layout();
			writeRaw(paths.rawDir, [...pair(0, "one"), ...pair(1, "two")]);
			installScanner(paths.root, { finding: true });

			const report = exportRedactedData(liveConfig, [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
				"--format",
				"openai-chat",
			]);

			expect(report.status).toBe("rejected");
			expect(report.summary).toMatchObject({ approved: 0, rejected: 1 });
			expect(report.training).toMatchObject({
				accepted: 0,
				rejected: 2,
				rejectionReasons: { "scanner-rejected": 2 },
			});
			expect(
				readFileSync(
					join(paths.out, "training-index.openai-chat.jsonl"),
					"utf-8",
				),
			).toBe("");
		});

		it("drops every review record when a required scanner is unavailable", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "one"));
			process.env.PATH = "";
			process.env.TRUFFLEHOG_BIN = join(paths.root, "missing", "trufflehog");

			const report = exportRedactedData(liveConfig, [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
				"--require-trufflehog",
				"--format",
				"openai-chat",
			]);

			expect(report.status).toBe("rejected");
			expect(report.training?.accepted).toBe(0);
			expect(report.training?.rejectionReasons).toEqual({
				"scanner-rejected": 1,
			});
			expect(
				readFileSync(
					join(paths.out, "training-index.openai-chat.jsonl"),
					"utf-8",
				),
			).toBe("");
		});

		describe("review records require a clean, completed external scan", () => {
			const formatArgs = (
				paths: ReturnType<typeof layout>,
				extra: string[] = [],
			) => [
				"--raw-dir",
				paths.raw,
				"--raw-only",
				"--out",
				paths.out,
				"--format",
				"openai-chat",
				...extra,
			];
			const trainingFile = (paths: ReturnType<typeof layout>) =>
				readFileSync(
					join(paths.out, "training-index.openai-chat.jsonl"),
					"utf-8",
				);

			it.each([
				["a nonzero exit", { exit: 2 }, "exited with status 2"],
				[
					"termination by a signal with no output",
					{ signal: true },
					"did not complete (signal SIGTERM)",
				],
			])(
				"rejects every record after %s, without --require-trufflehog",
				(_name, behavior, warning) => {
					const paths = layout();
					writeRaw(paths.rawDir, [...pair(0, "one"), ...pair(1, "two")]);
					installScanner(paths.root, behavior);

					const report = exportRedactedData(liveConfig, formatArgs(paths));

					expect(report.trufflehog).toMatchObject({
						enabled: true,
						required: true,
						available: true,
					});
					expect(report.trufflehog?.warning).toContain(warning);
					expect(report.status).toBe("rejected");
					expect(report.training).toMatchObject({
						accepted: 0,
						rejectionReasons: { "scanner-rejected": 2 },
					});
					expect(trainingFile(paths)).toBe("");
					expect(report.training?.warnings.join("\n")).toContain(
						"did not complete cleanly",
					);
				},
			);

			it("rejects every record when the scanner is unavailable and --require-trufflehog is not given", () => {
				const paths = layout();
				writeRaw(paths.rawDir, pair(0, "one"));
				process.env.PATH = "";
				process.env.TRUFFLEHOG_BIN = join(paths.root, "missing", "trufflehog");

				const report = exportRedactedData(liveConfig, formatArgs(paths));

				expect(report.trufflehog).toMatchObject({
					required: true,
					available: false,
				});
				expect(report.status).toBe("rejected");
				expect(report.training?.accepted).toBe(0);
				expect(trainingFile(paths)).toBe("");
			});

			it("counts only detector-shaped JSON lines from either output stream", () => {
				const paths = layout();
				writeRaw(paths.rawDir, pair(0, "one"));
				installScanner(paths.root, {
					stdout: [
						'{"level":"info","Raw":"a log line, not a finding"}',
						"{not json",
						"plain text",
						'{"unrelated":1}',
						'  {"SourceMetadata":{}}  ',
						'{"Raw":"x"}',
					],
					stderr: ['{"Redacted":"x"}', '{"DetectorName":"Fake"}'],
				});

				const report = exportRedactedData(liveConfig, formatArgs(paths));

				expect(report.trufflehog).toMatchObject({ exitCode: 0, findings: 4 });
				expect(report.status).toBe("rejected");
				expect(report.training?.accepted).toBe(0);
			});

			it("rejects the records of a scan whose output overflows the capture buffer", () => {
				const paths = layout();
				writeRaw(paths.rawDir, pair(0, "one"));
				installScanner(paths.root, { flood: true });

				const report = exportRedactedData(liveConfig, formatArgs(paths));

				expect(report.trufflehog).toMatchObject({
					enabled: true,
					available: true,
					exitCode: null,
					findings: 0,
				});
				expect(report.trufflehog?.warning).toMatch(
					/^trufflehog scan failed: .*ENOBUFS/,
				);
				expect(report.status).toBe("rejected");
				expect(report.training?.accepted).toBe(0);
			});

			it("keeps the records after a clean exit-0 scan", () => {
				const paths = layout();
				writeRaw(paths.rawDir, pair(0, "one"));

				const report = exportRedactedData(liveConfig, formatArgs(paths));

				expect(report.trufflehog).toMatchObject({ exitCode: 0, findings: 0 });
				expect(report.training?.accepted).toBe(1);
				expect(report.status).toBe("approved");
			});

			it("treats a signal-killed required scan as a failure for a legacy export too", () => {
				const paths = layout();
				writeRaw(paths.rawDir, pair(0, "one"));
				installScanner(paths.root, { signal: true });

				const report = exportRedactedData(liveConfig, [
					"--raw-dir",
					paths.raw,
					"--raw-only",
					"--out",
					paths.out,
					"--require-trufflehog",
				]);

				expect(report.status).toBe("rejected");
				expect(report.summary).toMatchObject({ approved: 0, rejected: 1 });
			});

			it("leaves a legacy export without a scanner flag optional when the scanner is unavailable", () => {
				const paths = layout();
				writeRaw(paths.rawDir, pair(0, "one"));
				process.env.PATH = "";
				process.env.TRUFFLEHOG_BIN = join(paths.root, "missing", "trufflehog");

				const report = exportRedactedData(liveConfig, [
					"--raw-dir",
					paths.raw,
					"--raw-only",
					"--out",
					paths.out,
				]);

				expect(report.status).toBe("approved");
				expect(report.trufflehog).toMatchObject({
					required: false,
					available: false,
				});
			});
		});
	});

	describe("option and context handling", () => {
		function args(paths: ReturnType<typeof layout>, ...extra: string[]) {
			return [
				"--raw-dir",
				paths.raw,
				"--sessions-dir",
				paths.sessions,
				"--out",
				paths.out,
				...extra,
			];
		}

		it("reports a refusal to a context that has no ui or no notify", () => {
			const paths = layout();
			const bad = args(paths, "--format", "jsonl");

			expect(exportRedactedData(liveConfig, bad, {}).error?.code).toBe(
				"invalid-export-option",
			);
			expect(exportRedactedData(liveConfig, bad, { ui: {} }).error?.code).toBe(
				"invalid-export-option",
			);
		});

		it("notifies the context of a refusal as an error", () => {
			const paths = layout();
			const notify = vi.fn();

			const report = exportRedactedData(
				liveConfig,
				args(paths, "--format", "jsonl"),
				{ ui: { notify } },
			);

			expect(report.status).toBe("failed");
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(report.error?.message, "error");
		});

		it("sends progress phases in order, with file counts while copying", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));
			const onProgress = vi.fn();

			exportRedactedData(liveConfig, args(paths, "--raw-only"), { onProgress });

			expect(onProgress.mock.calls.map(([progress]) => progress.phase)).toEqual(
				["discover", "copy", "scan", "scan", "write", "done"],
			);
			expect(onProgress).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "copy", current: 1, total: 1 }),
			);
		});

		it("accepts the explicit --trufflehog flag after --no-trufflehog", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));

			const report = exportRedactedData(
				liveConfig,
				args(paths, "--raw-only", "--no-trufflehog", "--trufflehog"),
			);

			expect(report.trufflehog).toMatchObject({
				enabled: true,
				available: true,
				findings: 0,
			});
		});

		it("ignores tokens it does not know", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));

			const report = exportRedactedData(
				liveConfig,
				args(paths, "--raw-only", "--unknown-flag", "stray"),
			);

			expect(report.status).toBe("approved");
			expect(report.summary.files).toBe(1);
		});

		it("does not change the caller's argument array", () => {
			const paths = layout();
			const argv = args(paths, "--raw-only");
			const before = [...argv];

			exportRedactedData(liveConfig, argv);

			expect(argv).toEqual(before);
		});

		it("takes defaults from the Pi agent directory when a string has no options", () => {
			const paths = layout();
			const agentDir = join(paths.root, "agent");
			writeRaw(join(paths.root, "raw-default", "--p--"), pair(0, "answer"));
			const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			try {
				const report = exportRedactedData(
					{ ...liveConfig, rawTraceDir: join(paths.root, "raw-default") },
					"  ",
				);

				expect(report.status).toBe("approved");
				expect(
					report.outDir.startsWith(join(agentDir, "langfuse", "exports")),
				).toBe(true);
				expect(existsSync(join(report.outDir, "report.json"))).toBe(true);
				expect(report.summary.files).toBe(1);
			} finally {
				if (originalAgentDir === undefined)
					delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
		});

		it("uses a valid configured pseudonymous salt without touching the config file", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));

			const report = run(paths, ["--raw-only", "--format", "openai-chat"], {
				...liveConfig,
				identityMode: "pseudonymous",
				identitySalt: SALT,
			});

			expect(report.training?.accepted).toBe(1);
			expect(existsSync(paths.configPath)).toBe(false);
		});

		it("replaces a configured salt that is not valid with the persisted one", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "answer"));

			const report = run(paths, ["--raw-only", "--format", "openai-chat"], {
				...liveConfig,
				identityMode: "pseudonymous",
				identitySalt: "short",
			});

			expect(report.training?.accepted).toBe(1);
			const stored = JSON.parse(readFileSync(paths.configPath, "utf-8"));
			expect(stored.identitySalt).toMatch(/^[0-9a-f]{64}$/);
		});

		it("rejects a derivative that still holds a secret after redaction", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-langfuse-residual-test-"));
			const sessions = join(root, "sessions");
			mkdirSync(sessions, { recursive: true });
			// Redaction rewrites values; a secret used as an object key survives
			// it, and only the residual scan notices.
			writeFileSync(
				join(sessions, "session.jsonl"),
				`{"${baseConfig.secretKey}":1}\n`,
			);

			const report = exportRedactedData(baseConfig, [
				"--sessions-only",
				"--sessions-dir",
				sessions,
				"--out",
				join(root, "export"),
				"--no-trufflehog",
			]);

			expect(report.status).toBe("rejected");
			expect(report.files).toHaveLength(1);
			expect(report.files[0]?.status).toBe("rejected");
			expect(report.files[0]?.residualFindings.length).toBeGreaterThan(0);
			expect(
				readFileSync(join(root, "export", "rejected.jsonl"), "utf-8"),
			).toContain('"status":"rejected"');
		});

		it("builds review records only from approved derivatives", () => {
			const paths = layout();
			writeRaw(paths.rawDir, pair(0, "good answer"), "good.jsonl");
			// A secret used as an object key survives redaction, so the residual
			// scan rejects this derivative before any sample is built from it.
			writeRaw(
				paths.rawDir,
				[...pair(0, "second answer"), { [SECRET]: 1 }],
				"leaky.jsonl",
			);

			const report = run(paths, ["--raw-only", "--format", "openai-chat"]);

			const statuses = Object.fromEntries(
				report.files.map((file) => [file.path.split("/").pop(), file.status]),
			);
			expect(statuses).toEqual({
				"good.jsonl": "approved",
				"leaky.jsonl": "rejected",
			});
			expect(report.training).toMatchObject({ accepted: 1, candidates: 1 });
			expect(trainingRecords(paths.out, "openai-chat")).toHaveLength(1);
		});

		it("refuses a review export without raw traces before reading any declaration", () => {
			const paths = layout();

			const report = run(
				paths,
				["--sessions-only", "--format", "openai-chat"],
				{ ...liveConfig, exportConsentError: "ignored consent problem" },
			);

			expect(report.error?.message).toContain(
				"cannot be combined with --sessions-only",
			);
		});

		describe("scanner outcome and report details", () => {
			const LICENSE_LIMIT = 200;

			function newLayout(name: string) {
				const root = mkdtempSync(join(tmpdir(), `pi-langfuse-${name}-`));
				process.env.PI_LANGFUSE_CONFIG = join(
					root,
					"config",
					"pi-langfuse.json",
				);
				return root;
			}

			function plainExport(
				root: string,
				extra: string[],
				ctx?: Parameters<typeof exportRedactedData>[2],
			) {
				const raw = join(root, "raw-a", "--project--");
				mkdirSync(raw, { recursive: true });
				writeFileSync(
					join(raw, "trace.jsonl"),
					'{"type":"note","text":"hi"}\n',
				);
				return exportRedactedData(
					baseConfig,
					[
						"--raw-dir",
						join(root, "raw-a"),
						"--raw-only",
						"--out",
						join(root, "export"),
						...extra,
					],
					ctx,
				);
			}

			it("reports a skipped scan as disabled, not required, and finding nothing", () => {
				const root = newLayout("skipped-scan");

				const report = plainExport(root, ["--no-trufflehog"]);

				expect(report.trufflehog).toMatchObject({
					enabled: false,
					required: false,
					available: false,
					findings: 0,
				});
				expect(report.status).toBe("approved");
				expect(
					readFileSync(join(root, "export", "REVIEW.md"), "utf-8"),
				).toContain("TruffleHog: skipped, required=false, findings=0");
			});

			it("treats a scanner whose version probe fails as unavailable and never scans", () => {
				const root = newLayout("probe-fails");
				const { argsLog } = installScanner(root, { versionExit: 3 });

				const report = plainExport(root, ["--trufflehog"]);

				expect(report.trufflehog).toMatchObject({
					enabled: true,
					required: false,
					available: false,
					findings: 0,
				});
				expect(existsSync(argsLog)).toBe(false);
			});

			it("explains a missing optional scanner differently from a missing required one", () => {
				const root = newLayout("missing-scanner");
				process.env.PATH = "";
				process.env.TRUFFLEHOG_BIN = join(root, "missing", "trufflehog");

				const optional = plainExport(root, ["--trufflehog"]);
				rmSync(join(root, "export"), { recursive: true });
				const required = plainExport(root, ["--require-trufflehog"]);

				expect(optional.trufflehog).toMatchObject({
					required: false,
					available: false,
					findings: 0,
				});
				expect(optional.trufflehog?.warning).toContain(
					"built-in residual scan",
				);
				expect(optional.status).toBe("approved");
				expect(required.trufflehog).toMatchObject({
					required: true,
					available: false,
					findings: 0,
				});
				expect(required.trufflehog?.warning).toContain("required");
				expect(required.status).toBe("rejected");
				expect(
					readFileSync(join(root, "export", "REVIEW.md"), "utf-8"),
				).toContain("TruffleHog: unavailable, required=true, findings=0");
			});

			it.each([
				[
					"a clean complete scan",
					{},
					"approved",
					"ran, required=true, findings=0",
				],
				[
					"exactly one finding",
					{ finding: true },
					"rejected",
					"ran, required=true, findings=1",
				],
				[
					"an incomplete scan without findings",
					{ exit: 3 },
					"rejected",
					"ran, required=true, findings=0",
				],
			])("judges a required scan with %s", (_name, behavior, status, line) => {
				const root = newLayout("required-scan");
				installScanner(root, behavior);

				const report = plainExport(root, ["--require-trufflehog"]);

				expect(report.status).toBe(status);
				expect(
					readFileSync(join(root, "export", "REVIEW.md"), "utf-8"),
				).toContain(line);
			});

			it.each([
				["a clean complete scan", {}, "approved"],
				["exactly one finding", { finding: true }, "rejected"],
				["an incomplete scan without findings", { exit: 3 }, "rejected"],
			])(
				"judges a required scan of an export with no files by %s",
				(_name, behavior, status) => {
					const root = newLayout("required-empty");
					mkdirSync(join(root, "raw-a"), { recursive: true });
					installScanner(root, behavior);

					const report = exportRedactedData(baseConfig, [
						"--raw-dir",
						join(root, "raw-a"),
						"--raw-only",
						"--out",
						join(root, "export"),
						"--require-trufflehog",
					]);

					expect(report.files).toEqual([]);
					expect(report.status).toBe(status);
				},
			);

			it("keeps an optional scan's incomplete exit from rejecting the export status", () => {
				const root = newLayout("optional-scan");
				installScanner(root, { exit: 3 });

				const report = plainExport(root, ["--trufflehog"]);

				expect(report.trufflehog).toMatchObject({
					required: false,
					exitCode: 3,
				});
				expect(report.summary).toMatchObject({ approved: 0, rejected: 1 });
			});

			it("scrubs the roots of exactly the sources that were exported", () => {
				const root = newLayout("scrub-roots");
				const sessionsRoot = join(root, "sess-a");
				const rawRoot = join(root, "raw-b");
				mkdirSync(join(sessionsRoot, "--p--"), { recursive: true });
				mkdirSync(join(rawRoot, "--p--"), { recursive: true });
				const line = `${JSON.stringify({
					type: "note",
					text: `in ${sessionsRoot}/x and ${rawRoot}/y`,
				})}\n`;
				writeFileSync(join(sessionsRoot, "--p--", "s.jsonl"), line);
				writeFileSync(join(rawRoot, "--p--", "r.jsonl"), line);
				const exportWith = (flag: string, name: string) => {
					const out = join(root, name);
					exportRedactedData(baseConfig, [
						"--sessions-dir",
						sessionsRoot,
						"--raw-dir",
						rawRoot,
						flag,
						"--out",
						out,
						"--no-trufflehog",
					]);
					return out;
				};

				const sessionsOnly = readFileSync(
					join(
						exportWith("--sessions-only", "out-sessions"),
						"sessions",
						"--p--",
						"s.jsonl",
					),
					"utf-8",
				);
				const rawOnly = readFileSync(
					join(
						exportWith("--raw-only", "out-raw"),
						"raw-traces",
						"--p--",
						"r.jsonl",
					),
					"utf-8",
				);

				expect(sessionsOnly).not.toContain(sessionsRoot);
				expect(sessionsOnly).toContain("[PATH_ROOT]/x");
				expect(rawOnly).not.toContain(rawRoot);
				expect(rawOnly).toContain("[PATH_ROOT]/y");
			});

			it("scrubs the sessions root itself, not just its parent, from session content", () => {
				const root = newLayout("scrub-sessions-root");
				const sessionsRoot = join(root, "sessions");
				mkdirSync(join(sessionsRoot, "--p--"), { recursive: true });
				writeFileSync(
					join(sessionsRoot, "--p--", "s.jsonl"),
					`${JSON.stringify({ type: "note", text: `in ${sessionsRoot}/--p--/x` })}\n`,
				);

				exportRedactedData(baseConfig, [
					"--sessions-dir",
					sessionsRoot,
					"--sessions-only",
					"--out",
					join(root, "export"),
					"--no-trufflehog",
				]);

				const exported = readFileSync(
					join(root, "export", "sessions", "--p--", "s.jsonl"),
					"utf-8",
				);
				expect(exported).not.toContain(root);
				expect(exported).toContain("in [PATH_ROOT]/--p--/x");
			});

			it("exports only the raw traces for --raw-only", () => {
				const root = newLayout("raw-only");
				mkdirSync(join(root, "sess-a", "--p--"), { recursive: true });
				writeFileSync(
					join(root, "sess-a", "--p--", "s.jsonl"),
					'{"type":"note"}\n',
				);

				const report = plainExport(root, [
					"--sessions-dir",
					join(root, "sess-a"),
					"--no-trufflehog",
				]);

				expect(report.files.map((file) => file.layer)).toEqual(["raw-trace"]);
				expect(existsSync(join(root, "export", "sessions"))).toBe(false);
			});

			it("warns about a rejected export and stays informational otherwise", () => {
				const root = newLayout("export-notice");
				const notices: Array<[string, string]> = [];
				const ctx = {
					ui: {
						notify: (message: string, level: string) =>
							notices.push([message, level]),
					},
				} as Parameters<typeof exportRedactedData>[2];
				const raw = join(root, "raw-a", "--project--");
				mkdirSync(raw, { recursive: true });
				// A secret used as an object key survives redaction; only the
				// residual scan notices it.
				writeFileSync(join(raw, "leak.jsonl"), `{"${SECRET}":1}\n`);

				const rejected = exportRedactedData(
					baseConfig,
					[
						"--raw-dir",
						join(root, "raw-a"),
						"--raw-only",
						"--out",
						join(root, "out-1"),
						"--no-trufflehog",
					],
					ctx,
				);
				const clean = plainExport(
					newLayout("export-notice-clean"),
					["--no-trufflehog"],
					ctx,
				);

				expect(rejected.summary).toMatchObject({ rejected: 1 });
				expect(clean.summary).toMatchObject({ rejected: 0 });
				const levels = notices
					.filter(([message]) => message.startsWith("Langfuse export wrote"))
					.map(([, level]) => level);
				expect(levels).toEqual(["warning", "info"]);
			});

			it("accepts a license of the maximum length and refuses a longer one", () => {
				const root = newLayout("license-limit");
				const rawDir = join(root, "raw", "--home-jdoe-project--");
				writeRaw(rawDir, pair(0, "answer"));
				const withLicense = (license: string, out: string) =>
					exportRedactedData(liveConfig, [
						"--raw-dir",
						join(root, "raw"),
						"--raw-only",
						"--out",
						join(root, out),
						"--format",
						"openai-chat",
						"--license",
						license,
					]);
				installScanner(root);

				// Spaced words keep the declaration from being redacted as a blob.
				const atLimit = `${"word ".repeat(39)}word!`;
				expect(atLimit).toHaveLength(LICENSE_LIMIT);
				const accepted = withLicense(atLimit, "out-ok");
				const refused = withLicense(`${atLimit}!`, "out-long");

				expect(accepted.error).toBeUndefined();
				expect(accepted.training?.license).toBe(atLimit);
				expect(refused.status).toBe("failed");
				expect(refused.error?.message).toContain("license");
				expect(refused.summary).toEqual({ approved: 0, rejected: 0, files: 0 });
			});

			it("shows the declared license, or none, in the review text", () => {
				const root = newLayout("license-text");
				const rawDir = join(root, "raw", "--home-jdoe-project--");
				writeRaw(rawDir, pair(0, "answer"));
				installScanner(root);
				const review = (extra: string[], out: string) => {
					exportRedactedData(liveConfig, [
						"--raw-dir",
						join(root, "raw"),
						"--raw-only",
						"--out",
						join(root, out),
						"--format",
						"openai-chat",
						...extra,
					]);
					return readFileSync(join(root, out, "REVIEW.md"), "utf-8");
				};

				expect(review(["--license", "MIT"], "out-mit")).toContain(
					"License declaration: MIT",
				);
				expect(review([], "out-none")).toContain("License declaration: (none)");
			});

			it("records no scanner rejection when a failed scan had no samples to drop", () => {
				const root = newLayout("no-samples");
				mkdirSync(join(root, "raw", "--home-jdoe-project--"), {
					recursive: true,
				});
				process.env.PATH = "";
				process.env.TRUFFLEHOG_BIN = join(root, "missing", "trufflehog");

				const report = exportRedactedData(liveConfig, [
					"--raw-dir",
					join(root, "raw"),
					"--raw-only",
					"--out",
					join(root, "export"),
					"--format",
					"openai-chat",
				]);

				expect(report.training).toMatchObject({
					accepted: 0,
					rejected: 0,
					candidates: 0,
				});
				expect(report.training?.rejectionReasons).toEqual({});
			});

			it("rejects a sample whose record holds exactly one secret finding", () => {
				const root = newLayout("single-finding");
				const configured = "custom-super-secret-987654321";
				writeRaw(
					join(root, "raw", "--home-jdoe-project--"),
					pair(0, "answer"),
					`${configured}.jsonl`,
				);
				installScanner(root);

				const report = exportRedactedData(liveConfig, [
					"--raw-dir",
					join(root, "raw"),
					"--raw-only",
					"--out",
					join(root, "export"),
					"--format",
					"openai-chat",
				]);

				expect(report.training).toMatchObject({
					accepted: 0,
					rejectionReasons: { "residual-secret": 1 },
				});
			});
		});
	});
});
