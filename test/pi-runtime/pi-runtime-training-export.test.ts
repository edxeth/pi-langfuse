import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfigFilePath, resolveConfig } from "../../src/config.js";
import { exportRedactedData } from "../../src/export.js";
import { setRuntimeTimeoutsForTest } from "../../src/langfuse-client.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	captureSessionEvents,
	createRuntimeCase,
	type PiAiModule,
	type RuntimeCase,
	readRawTraceRecords,
} from "./isolated-pi.js";
import {
	type PiMessagesServer,
	startPiMessagesServer,
	textAnswerEvents,
	usageOf,
} from "./provider-server.js";

/**
 * Real producer to training conversion: a genuine Pi SDK session writes raw
 * trace records through the real pi-langfuse extension and raw-trace shaping,
 * and the real export converts those emitted records. Nothing about capture
 * provenance is hand-authored here. Everything stays on 127.0.0.1 with
 * synthetic credentials, a case-local config path, and temporary directories.
 */

const FULL_REQUESTS = { PI_LANGFUSE_RAW_PROVIDER_REQUEST: "full" } as const;
const SALT = "cd".repeat(32);
const CONFIG_SECRET = "sk-local-runtime-test-secret";
const PATTERN_SECRET = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;

let activeCase: RuntimeCase | undefined;
let restoreTimeouts: (() => void) | undefined;
const activeServers: PiMessagesServer[] = [];

afterEach(async () => {
	restoreTimeouts?.();
	restoreTimeouts = undefined;
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
	for (const server of activeServers.splice(0)) await server.close();
}, 30_000);

/** One prompt: a tool call in turn 0, a plain-text answer in turn 1. */
async function runToolSession(options: {
	name: string;
	/** Built after the case environment (HOME included) is pinned. */
	prompt: string | ((home: string) => string);
	settings?: Record<string, unknown>;
	env?: Record<string, string | undefined>;
	beforePrompt?: (runtimeCase: RuntimeCase) => void;
}) {
	restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 1_000 });
	const usage = usageOf(42, 7, 0);
	const provider = await startPiMessagesServer((call) =>
		call === 1
			? {
					events: [
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_end", contentIndex: 0, content: "calling" },
						{
							type: "toolcall_start",
							contentIndex: 1,
							id: "call-1",
							toolName: "probe_echo",
						},
						{
							type: "toolcall_delta",
							contentIndex: 1,
							delta: '{"q":"hello"}',
						},
						{
							type: "toolcall_end",
							contentIndex: 1,
							toolCall: {
								type: "toolCall",
								id: "call-1",
								name: "probe_echo",
								arguments: { q: "hello" },
							},
						},
						{ type: "done", reason: "toolCall", usage },
					],
				}
			: { events: textAnswerEvents("final answer", usage) },
	);
	activeServers.push(provider);
	const runtimeCase = await createRuntimeCase({
		name: options.name,
		provider: { kind: "pi-messages", baseUrl: provider.url },
		settings: options.settings,
		env: options.env,
		customToolsFactory: (piAi: PiAiModule) => [
			{
				name: "probe_echo",
				label: "Probe Echo",
				description: "Returns fixed synthetic text.",
				parameters: piAi.Type.Object({ q: piAi.Type.String() }),
				execute: async () => ({
					content: [{ type: "text", text: "TOOLOUT" }],
					details: {},
				}),
			},
		],
	});
	activeCase = runtimeCase;
	options.beforePrompt?.(runtimeCase);
	captureSessionEvents(runtimeCase.session);
	await runtimeCase.session.prompt(
		typeof options.prompt === "function"
			? options.prompt(process.env.HOME ?? "")
			: options.prompt,
	);
	await runtimeCase.session.waitForIdle();
	runtimeCase.session.dispose();
	drainRawTraceQueue();
	return { runtimeCase, provider };
}

function exportTraining(runtimeCase: RuntimeCase, format = "openai-chat") {
	// The pinned config path must live inside the case: salt creation and
	// preseeding never touch a real user config.
	expect(getConfigFilePath().startsWith(runtimeCase.caseDir)).toBe(true);
	const out = join(runtimeCase.caseDir, "export", format);
	// Review records need a completed external scan; use a local fake that
	// exits cleanly. The real scanner is never run here.
	const bin = join(runtimeCase.caseDir, "scanner-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "trufflehog"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "trufflehog"), 0o755);
	process.env.TRUFFLEHOG_BIN = join(bin, "trufflehog");
	const report = exportRedactedData(resolveConfig({}), [
		"--raw-dir",
		runtimeCase.rawTraceDir,
		"--raw-only",
		"--out",
		out,
		"--format",
		format,
		"--consent",
		"granted",
		"--license",
		"synthetic-test-data",
	]);
	return { report, out };
}

function readTraining(out: string, format = "openai-chat") {
	return readFileSync(join(out, `training-index.${format}.jsonl`), "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolReasons(reasons: Record<string, number> | undefined) {
	return Object.keys(reasons ?? {}).filter((reason) =>
		reason.startsWith("stop-reason-tool"),
	);
}

describe("training export from real raw-trace records", () => {
	it("converts the completed generation and keeps its tool history, matching the provider wire", async () => {
		const { runtimeCase, provider } = await runToolSession({
			name: "training-full",
			prompt: "hi there",
			settings: { "capture-policy": "full-debug" },
			env: FULL_REQUESTS,
		});
		// The emitted records carry measured provenance.
		const emitted = readRawTraceRecords(runtimeCase.rawTraceDir);
		expect(
			emitted
				.filter((record) => record.type === "provider_request")
				.map((record) => record.captureProvenance),
		).toEqual([
			{ schema: 1, verified: ["messages"], degraded: {} },
			{ schema: 1, verified: ["messages"], degraded: {} },
		]);

		const { report, out } = exportTraining(runtimeCase);

		// Turn 0 ended in a tool call and is not a normally completed answer;
		// turn 1 answered normally.
		expect(report.error).toBeUndefined();
		expect(report.training?.accepted).toBe(1);
		expect(report.training?.rejected).toBe(1);
		expect(toolReasons(report.training?.rejectionReasons)).toHaveLength(1);
		const [sample] = readTraining(out);
		if (!sample) throw new Error("expected one converted sample");
		const messages = (
			sample.example as { messages: Array<Record<string, unknown>> }
		).messages;
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"assistant",
		]);

		// Independent reference: what the provider really received for turn 1.
		const wireBody = provider.requests[1]?.body as {
			context: { messages: Array<Record<string, unknown>> };
		};
		const wire = wireBody.context.messages;
		const wireAssistant = wire[2] as {
			content: Array<{ type: string; arguments?: unknown; id?: string }>;
		};
		const wireCall = wireAssistant.content.find(
			(block) => block.type === "toolCall",
		);
		const sampleCalls = messages[2]?.tool_calls as Array<{
			id: string;
			function: { arguments: string };
		}>;
		expect(sampleCalls[0]?.id).toBe(wireCall?.id);
		expect(JSON.parse(sampleCalls[0]?.function.arguments ?? "")).toEqual(
			wireCall?.arguments,
		);
		expect(messages[3]).toEqual({
			role: "tool",
			tool_call_id: "call-1",
			content: "TOOLOUT",
		});
		expect(messages[1]).toEqual({ role: "user", content: "hi there" });
		expect(String(messages[0]?.content)).toContain(
			"You are an expert coding assistant operating inside pi",
		);
		expect(messages[4]).toEqual({ role: "assistant", content: "final answer" });
		expect(sample).toMatchObject({
			consent: "granted",
			license: "synthetic-test-data",
			omitted: ["tool-definitions"],
		});
	}, 60_000);

	it("rejects every sample from default summary-mode raw records", async () => {
		const { runtimeCase } = await runToolSession({
			name: "training-summary",
			prompt: "hi there",
			settings: { "capture-policy": "full-debug" },
		});

		const { report, out } = exportTraining(runtimeCase);

		expect(report.training?.accepted).toBe(0);
		expect(report.training?.rejectionReasons).toMatchObject({
			"request-not-full-capture": 1,
		});
		expect(readTraining(out)).toEqual([]);
	}, 60_000);

	it("rejects samples whose capture a finite payload budget truncated", async () => {
		const { runtimeCase } = await runToolSession({
			name: "training-budget",
			prompt: "hi there",
			settings: {
				"capture-policy": "full-debug",
				"payload-max-string-chars": 100,
			},
			env: FULL_REQUESTS,
		});

		const { report, out } = exportTraining(runtimeCase);

		expect(report.training?.accepted).toBe(0);
		expect(report.training?.rejectionReasons).toMatchObject({
			"request-capture-budget-truncated": 1,
		});
		expect(readTraining(out)).toEqual([]);
	}, 60_000);

	it("rejects samples whose tool content the capture policy omitted", async () => {
		const { runtimeCase } = await runToolSession({
			name: "training-policy",
			prompt: "hi there",
			settings: { "capture-policy": "conversations" },
			env: FULL_REQUESTS,
		});

		const { report } = exportTraining(runtimeCase);

		expect(report.training?.accepted).toBe(0);
		expect(report.training?.rejectionReasons).toMatchObject({
			"response-capture-policy-omitted": 1,
		});
	}, 60_000);

	it("pseudonymizes and redacts the sample although capture ran raw and unredacted", async () => {
		let home = "";
		const { runtimeCase } = await runToolSession({
			name: "training-identity",
			prompt: (caseHome) => {
				home = caseHome;
				return `open ${caseHome}/notes.txt with ${CONFIG_SECRET} and ${PATTERN_SECRET} salt ${SALT}`;
			},
			settings: {
				"capture-policy": "full-debug",
				"redaction-enabled": false,
				"identity-mode": "raw",
				"identity-keep-repo": true,
			},
			env: FULL_REQUESTS,
			beforePrompt: () => {
				// Seed the case-local config so the salt is known to the test.
				mkdirSync(dirname(getConfigFilePath()), { recursive: true });
				writeFileSync(
					getConfigFilePath(),
					JSON.stringify({ identitySalt: SALT }),
				);
			},
		});
		const rawText = readdirSync(runtimeCase.rawTraceDir)
			.flatMap((entry) =>
				readdirSync(join(runtimeCase.rawTraceDir, entry)).map((file) =>
					readFileSync(join(runtimeCase.rawTraceDir, entry, file), "utf-8"),
				),
			)
			.join("\n");
		// The capture really was raw: the source holds the secrets and home path.
		expect(rawText).toContain(CONFIG_SECRET);
		expect(rawText).toContain(PATTERN_SECRET);
		expect(rawText).toContain(home);

		const { report, out } = exportTraining(runtimeCase);

		expect(report.training?.accepted).toBe(1);
		const artifacts = [
			"training-index.openai-chat.jsonl",
			"manifest.jsonl",
			"report.json",
		].map((name) => readFileSync(join(out, name), "utf-8"));
		const derivative = readdirSync(join(out, "raw-traces")).flatMap((entry) =>
			readdirSync(join(out, "raw-traces", entry)).map((file) =>
				readFileSync(join(out, "raw-traces", entry, file), "utf-8"),
			),
		);
		for (const content of [...artifacts, ...derivative]) {
			for (const leaked of [CONFIG_SECRET, PATTERN_SECRET, SALT]) {
				expect(content).not.toContain(leaked);
			}
		}
		const sample = JSON.stringify(readTraining(out)[0]?.example);
		expect(sample).toContain("[REDACTED:identity-salt]");
		expect(sample).toContain("~/notes.txt");
		expect(existsSync(join(out, "raw-traces"))).toBe(true);
	}, 60_000);
});
