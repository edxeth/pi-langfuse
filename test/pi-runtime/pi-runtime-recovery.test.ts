import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getLastRuntimeError,
	getRuntimeRegistrySizeForTest,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "../../src/langfuse-client.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import { subscribeRuntimeErrors } from "../../src/runtime-diagnostics.js";
import {
	createRuntimeCase,
	type PiAiModule,
	type RuntimeCase,
	readRawTraceRecords,
} from "./isolated-pi.js";
import {
	type DecodedSpan,
	decodeOtlpPayload,
	latestSpanPerId,
	spansByName,
} from "./otlp.js";
import type { RecorderRecord } from "./recorder.js";

/**
 * Transport-fault regressions at the real Pi seam under the single-export
 * pipeline:
 *
 * - The extension's only delivery path is the OTLP transport (POST
 *   /api/public/otel/v1/traces). Acceptance is the transport response; there
 *   is no read-back confirmation and no retained replay.
 * - A transient rejection recovers inside the same export through the
 *   exporter's bounded native-fetch retry: no second prompt, no replay
 *   pipeline, no diagnostic.
 * - A permanent HTTP failure is reported exactly once through the
 *   runtime-diagnostics subscription (never the console) while the prompt
 *   and the bounded shutdown still complete.
 * - A 200 response that rejects spans via partialSuccess is never retried
 *   (the server persisted the accepted spans) and is reported as a loss.
 *
 * The privacy, hierarchy, usage/cost, score-environment, and credential
 * contracts from the previous replay pipeline carry over unchanged.
 * Everything stays on 127.0.0.1 with synthetic credentials; no Docker, no
 * persistent Langfuse, no paid models.
 */

let activeCase: RuntimeCase | undefined;
let restoreTimeouts: (() => void) | undefined;

afterEach(async () => {
	restoreTimeouts?.();
	restoreTimeouts = undefined;
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
});

function requireSpan(span: DecodedSpan | undefined, name: string): DecodedSpan {
	if (!span) throw new Error(`expected a ${name} span in the accepted export`);
	return span;
}

function traceMeta(span: DecodedSpan, key: string): unknown {
	return span.attrs[`langfuse.trace.metadata.${key}`];
}

function spansFromAccepted(recorder: RuntimeCase["recorder"]): DecodedSpan[] {
	return recorder
		.acceptedPosts()
		.flatMap((record) => decodeOtlpPayload(record.body));
}

function spanIdsOf(record: RecorderRecord): Set<string> {
	return new Set(decodeOtlpPayload(record.body).map((span) => span.spanId));
}

function otlpPosts(recorder: RuntimeCase["recorder"]): RecorderRecord[] {
	return recorder.records.filter((record) =>
		record.path.includes("/otel/v1/traces"),
	);
}

function getReadRequests(recorder: RuntimeCase["recorder"]): RecorderRecord[] {
	return recorder.records.filter((record) => record.method === "GET");
}

/** Collect runtime diagnostics for a test window; the runtime never logs. */
function captureRuntimeDiagnostics() {
	const messages: string[] = [];
	const stop = subscribeRuntimeErrors((error) => {
		messages.push(error.message);
	});
	return { messages, stop };
}

/** Capture every console channel so runtime console output becomes visible. */
function captureConsole() {
	const output: string[] = [];
	const spies = (["warn", "error", "log"] as const).map((method) =>
		vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
			output.push(`${method}: ${parts.map((part) => String(part)).join(" ")}`);
		}),
	);
	return {
		output,
		stop: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

function langfuseConsoleOutput(output: string[]): string[] {
	return output.filter((line) => /langfuse/i.test(line));
}

type RecoveryFixture = {
	runtimeCase: RuntimeCase;
	userPrompt: string;
	secret: string;
	marker: string;
};

/**
 * A real Pi session with a usage-bearing tool and a redaction-targeted
 * secret, so every test exercises the same wire content contracts.
 */
async function createRecoveryCase(name: string): Promise<RecoveryFixture> {
	const marker = `PR-${name}-canary`;
	const secret = `SUP3R-${name}-SECRET`;
	// Quoted key with a newline separator: the shape the redaction model
	// handles in-place while keeping the surrounding marker text.
	const userPrompt = `${marker}: setup {"api_password"\n : "${secret}"`;
	const toolUsage = {
		input: 700,
		output: 70,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 770,
		cost: {
			input: 0.7,
			output: 0.07,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.77,
		},
	};
	const runtimeCase = await createRuntimeCase({
		name,
		provider: { kind: "faux" },
		settings: { environment: `${name}-ENV` },
		customToolsFactory: (piAiModule: PiAiModule) => [
			{
				name: "probe_echo",
				label: "Probe Echo",
				description: "returns fixed text and reports usage",
				parameters: piAiModule.Type.Object({ q: piAiModule.Type.String() }),
				execute: async () => ({
					content: [{ type: "text", text: "probe ok" }],
					details: { name: "probe_echo" },
					usage: toolUsage,
				}),
			},
		],
	});
	const piAi = runtimeCase.piAi;
	runtimeCase.faux?.setResponses([
		piAi.fauxAssistantMessage([
			piAi.fauxToolCall("probe_echo", { q: "probe" }, { id: `call-${name}-1` }),
		]),
		piAi.fauxAssistantMessage([piAi.fauxText("PR-RECOVERY final answer")]),
	]);
	return { runtimeCase, userPrompt, secret, marker };
}

describe("pi runtime transport recovery (single OTLP export pipeline)", () => {
	it("recovers a transiently rejected export inside one prompt via the exporter's bounded retry, with no replay and no read-back", async () => {
		// The retry budget runs inside one export; the step bound must cover
		// the backoff chain without touching the recovery contract.
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 4_000 });
		const { runtimeCase, userPrompt, secret, marker } =
			await createRecoveryCase("PR-RECOVERY");
		activeCase = runtimeCase;

		// Deliberate fault: reject the first OTLP post carrying the marker
		// with a transient 503, then accept. The exporter's bounded retry must
		// deliver the same batch; nothing else may appear on the wire.
		runtimeCase.recorder.faults.rejectBodiesContaining = [marker];
		runtimeCase.recorder.faults.gateAtMatchedCount = 1;
		runtimeCase.recorder.faults.rejectStatus = 503;

		const diagnostics = captureRuntimeDiagnostics();
		const consoleCapture = captureConsole();
		try {
			await runtimeCase.session.prompt(userPrompt);
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			await shutdownClient();
			drainRawTraceQueue();
		} finally {
			consoleCapture.stop();
			diagnostics.stop();
		}

		const recorder = runtimeCase.recorder;

		// --- endpoint discipline: OTLP POST only, no reads, no legacy routes ---
		expect(recorder.legacyHits).toEqual([]);
		expect(getReadRequests(recorder)).toEqual([]);

		// --- recovery without another prompt: one rejected attempt, one accepted retry ---
		expect(recorder.postsRejected).toBe(1);
		expect(recorder.postsAccepted).toBe(6);
		expect(recorder.postsTotal).toBe(7);
		const rejectedPost = otlpPosts(recorder).find((post) =>
			post.outcome.startsWith("rejected-"),
		);
		if (!rejectedPost) throw new Error("expected the rejected attempt");
		const rejectedIds = spanIdsOf(rejectedPost);
		const acceptedPost = recorder
			.acceptedPosts()
			.find((post) => [...spanIdsOf(post)].some((id) => rejectedIds.has(id)));
		if (!acceptedPost) throw new Error("expected a retry of the same span");
		const acceptedIds = spanIdsOf(acceptedPost);
		expect(rejectedIds.size).toBeGreaterThan(0);
		// The retry carries the original identities, not a rebuilt copy.
		expect([...acceptedIds].sort()).toEqual([...rejectedIds].sort());

		// --- delivery: the server-visible index holds every expected span ---
		const accepted = spansFromAccepted(recorder);
		const byName = spansByName(latestSpanPerId(accepted));
		for (const name of [
			"agent.prompt",
			"agent.turn",
			"llm-response",
			"tool:probe_echo",
		]) {
			expect((byName[name] ?? []).length).toBeGreaterThanOrEqual(1);
		}
		const traceIds = new Set(accepted.map((span) => span.traceId));
		expect(traceIds.size).toBe(1);
		const traceId = [...traceIds][0] ?? "";
		const uniqueDeliveredSpanIds = new Set(accepted.map((span) => span.spanId));
		expect(recorder.index.get(traceId)?.size).toBe(uniqueDeliveredSpanIds.size);
		expect(recorder.index.size).toBe(1);
		// Acceptance is final on the transport response: the completeness
		// surface is never queried.
		expect(recorder.pollCounts.size).toBe(0);

		// --- tool SPAN usage/cost fidelity on the delivered payload ---
		const acceptedToolPost = recorder
			.acceptedPosts()
			.find((record) =>
				JSON.stringify(record.body ?? {}).includes("tool:probe_echo"),
			);
		expect(acceptedToolPost).toBeDefined();
		const acceptedText = JSON.stringify(acceptedToolPost?.body ?? {});
		expect(acceptedText).toContain("usage_details");
		expect(acceptedText).toContain("700");
		expect(acceptedText).toContain("cost_details");
		expect(acceptedText).toContain("0.77");
		const root = requireSpan(byName["agent.prompt"]?.[0], "agent.prompt");
		expect(Number(traceMeta(root, "indirectTokensIn"))).toBe(700);
		expect(Number(traceMeta(root, "indirectTokensOut"))).toBe(70);

		// --- scores ride the supported endpoint with the configured environment ---
		expect(recorder.scores.length).toBeGreaterThanOrEqual(1);
		for (const score of recorder.scores) {
			expect((score.body as { environment?: string }).environment).toBe(
				"PR-RECOVERY-ENV",
			);
			expect(String(score.auth)).toContain("Basic ");
		}

		// --- privacy through normal export and raw records ---
		const sinkText = JSON.stringify(recorder.records);
		expect(sinkText).not.toContain(secret);
		expect(sinkText).toContain("[REDACTED:");
		const rawText = JSON.stringify(
			readRawTraceRecords(runtimeCase.rawTraceDir),
		);
		expect(rawText).not.toContain(secret);
		expect(rawText).toContain("[REDACTED:");
		expect(rawText).toContain(marker);

		// --- the single pipeline retired everything during shutdown ---
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});

		// --- honest diagnostics: transient recovery is silent and console-free ---
		expect(diagnostics.messages).toEqual([]);
		expect(langfuseConsoleOutput(consoleCapture.output)).toEqual([]);
		expect(JSON.stringify(recorder.records)).not.toContain(
			"sk-local-runtime-test-secret",
		);
	}, 30_000);

	it("reports a permanent HTTP failure through the diagnostics subscription while prompt and bounded shutdown complete console-silently", async () => {
		// The full bounded retry chain (initial + 3 retries with backoff) must
		// fit the export deadline so the failure is "all attempts rejected",
		// not a deadline cut.
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 5_000 });
		const { runtimeCase, userPrompt, secret, marker } =
			await createRecoveryCase("PR-DEAD");
		activeCase = runtimeCase;

		// Every post is rejected: the loss is permanent and must be reported,
		// not retried forever and not hidden.
		runtimeCase.recorder.faults.rejectBodiesContaining = ['"traceId"'];
		runtimeCase.recorder.faults.rejectStatus = 503;

		const startedAt = Date.now();
		const diagnostics = captureRuntimeDiagnostics();
		const consoleCapture = captureConsole();
		try {
			await runtimeCase.session.prompt(userPrompt);
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			await shutdownClient();
			drainRawTraceQueue();
		} finally {
			consoleCapture.stop();
			diagnostics.stop();
		}
		const elapsedMs = Date.now() - startedAt;

		const recorder = runtimeCase.recorder;

		// --- bounded transport behavior: initial attempt plus three retries ---
		expect(recorder.postsTotal).toBe(24);
		expect(recorder.postsAccepted).toBe(0);
		expect(recorder.index.size).toBe(0);
		expect(getReadRequests(recorder)).toEqual([]);
		expect(recorder.legacyHits).toEqual([]);

		// --- the failure surfaces deterministically through the subscription ---
		// Six ended observations each report one failed export, not an
		// additional wrapper warning from forceFlush.
		expect(diagnostics.messages).toHaveLength(6);
		const message = diagnostics.messages[0] ?? "";
		expect(message).toContain("Langfuse OTLP export failed");
		expect(message).toContain("HTTP 503");
		expect(message).toContain("4 attempts");
		// Sanitized: no credentials, endpoints, or user content ride the summary.
		for (const forbidden of [
			secret,
			marker,
			"sk-local-runtime-test-secret",
			"127.0.0.1",
		]) {
			for (const diagnostic of diagnostics.messages) {
				expect(diagnostic).not.toContain(forbidden);
			}
		}
		expect(getLastRuntimeError()?.message).toBe(diagnostics.messages.at(-1));

		// --- console silence: diagnostics never ride console.warn ---
		expect(langfuseConsoleOutput(consoleCapture.output)).toEqual([]);

		// --- the prompt and the bounded shutdown completed without hanging ---
		expect(elapsedMs).toBeLessThan(20_000);
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});
	}, 30_000);

	it("never retries a 200 partial rejection, indexes nothing, and reports the loss through diagnostics", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 4_000 });
		const { runtimeCase, userPrompt } = await createRecoveryCase("PR-PARTIAL");
		activeCase = runtimeCase;

		// Deliberate fault: every post answers 200 + partialSuccess and the
		// recorder indexes nothing. The server persisted the accepted spans,
		// so resending would duplicate them: exactly one attempt is allowed.
		runtimeCase.recorder.faults.partialRejectBodiesContaining = ['"traceId"'];

		const diagnostics = captureRuntimeDiagnostics();
		const consoleCapture = captureConsole();
		try {
			await runtimeCase.session.prompt(userPrompt);
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			await shutdownClient();
			drainRawTraceQueue();
		} finally {
			consoleCapture.stop();
			diagnostics.stop();
		}

		const recorder = runtimeCase.recorder;

		expect(recorder.postsTotal).toBe(6);
		expect(
			new Set(otlpPosts(recorder).flatMap((post) => [...spanIdsOf(post)])).size,
		).toBe(6);
		expect(recorder.postsAccepted).toBe(0);
		expect(recorder.index.size).toBe(0);
		// A partial rejection is reported in-band; no read API is consulted.
		expect(getReadRequests(recorder)).toEqual([]);

		// Each ended observation reports its rejection exactly once.
		expect(diagnostics.messages).toHaveLength(6);
		const message = diagnostics.messages[0] ?? "";
		expect(message).toContain("rejected 1 span(s)");
		expect(message).toContain("not retried (OTLP partial success)");
		expect(langfuseConsoleOutput(consoleCapture.output)).toEqual([]);
		expect(getLastRuntimeError()?.message).toBe(diagnostics.messages.at(-1));
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});
	}, 30_000);
});
