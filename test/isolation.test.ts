import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigFilePath, resolveConfig } from "../src/config.js";
import {
	appendRawTrace,
	defaultRawTraceDir,
	drainRawTraceQueue,
	rawTracePathForSession,
} from "../src/raw-trace.js";

const syntheticPublicKey = "pk-lf-test-isolation";
const syntheticSecretKey = "sk-lf-test-isolation";
const loopbackHost = "http://127.0.0.1:9";
const runRoot = process.env.PI_LANGFUSE_TEST_RUN_DIR;
const runId = process.env.PI_LANGFUSE_TEST_RUN_ID;

describe.runIf(process.env.RUN_LANGFUSE_E2E !== "1")(
	"test telemetry isolation",
	() => {
		it("pins synthetic credentials and destinations before test imports", () => {
			if (!runRoot)
				throw new Error("test setup did not create an isolated root");

			const config = resolveConfig({});
			if (config.publicKey !== syntheticPublicKey) {
				throw new Error(
					"test setup did not resolve synthetic public credentials",
				);
			}
			if (config.secretKey !== syntheticSecretKey) {
				throw new Error(
					"test setup did not resolve synthetic secret credentials",
				);
			}

			expect(process.env.PI_CODING_AGENT_DIR).toBe(join(runRoot, "agent"));
			expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(
				join(runRoot, "sessions"),
			);
			expect(process.env.PI_LANGFUSE_CONFIG).toBe(
				join(runRoot, "pi-langfuse.json"),
			);
			expect(process.env.PI_LANGFUSE_RAW_TRACE_DIR).toBe(
				join(runRoot, "raw-traces"),
			);
			expect(config.rawTraceDir).toBe(join(runRoot, "raw-traces"));
			expect(config.host).toBe(loopbackHost);
		});

		it("keeps default config, session, and raw-trace writes in the sandbox when overrides are cleared", () => {
			if (!runRoot || !runId) {
				throw new Error("test setup did not create an isolated run identity");
			}

			const keys = [
				"PI_CODING_AGENT_DIR",
				"PI_LANGFUSE_CONFIG",
				"PI_LANGFUSE_RAW_TRACE_DIR",
				"PI_LANGFUSE_RAW_TRACE",
			] as const;
			const previous = new Map(keys.map((key) => [key, process.env[key]]));

			try {
				for (const key of keys) delete process.env[key];
				process.env.PI_LANGFUSE_RAW_TRACE = "1";

				const isolatedHome = process.env.HOME;
				if (!isolatedHome || isolatedHome !== runRoot) {
					throw new Error("test HOME is not the isolated run directory");
				}

				const expectedAgentDir = join(isolatedHome, ".pi", "agent");
				const expectedConfigPath = join(
					expectedAgentDir,
					"langfuse",
					"pi-langfuse.json",
				);
				const expectedRawTraceDir = join(
					expectedAgentDir,
					"langfuse",
					"raw-traces",
				);
				const config = resolveConfig({});
				expect(getConfigFilePath()).toBe(expectedConfigPath);
				expect(defaultRawTraceDir()).toBe(expectedRawTraceDir);
				expect(config.rawTraceDir).toBe(expectedRawTraceDir);
				expect(config.rawTraceEnabled).toBe(true);
				expect(config.host).toBe(loopbackHost);
				if (config.publicKey !== syntheticPublicKey) {
					throw new Error(
						"clearing test paths exposed non-synthetic credentials",
					);
				}
				if (config.secretKey !== syntheticSecretKey) {
					throw new Error(
						"clearing test paths exposed non-synthetic credentials",
					);
				}

				const sessionFile = join(
					isolatedHome,
					"sessions",
					`--pi-langfuse-test-${runId}--`,
					"session.jsonl",
				);
				const expectedPath = rawTracePathForSession(
					sessionFile,
					expectedRawTraceDir,
				);
				if (!expectedPath) {
					throw new Error("isolated raw-trace path could not be resolved");
				}
				const pathFromRunRoot = relative(runRoot, expectedPath);
				if (
					pathFromRunRoot === ".." ||
					pathFromRunRoot.startsWith(`..${sep}`)
				) {
					throw new Error("raw-trace path escaped the test sandbox");
				}

				appendRawTrace(config, sessionFile, {
					type: "test_isolation_probe",
					timestamp: "2026-10-13T00:00:00.000Z",
					testRunId: runId,
				});
				drainRawTraceQueue();

				expect(existsSync(expectedPath)).toBe(true);
				expect(readFileSync(expectedPath, "utf8")).toContain(
					"test_isolation_probe",
				);
			} finally {
				drainRawTraceQueue();
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});
	},
);
