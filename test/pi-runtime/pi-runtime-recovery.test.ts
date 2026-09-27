import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getRuntimeRegistrySizeForTest,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "../../src/langfuse-client.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	completeTrace,
	createOtlpFallbackTransport,
	createRestFallbackStore,
	drainCompletedRestFallback,
	MAX_FALLBACK_ATTEMPTS,
	type RestFallbackDeps,
	recordObservation,
	recordTrace,
} from "../../src/rest-fallback.js";
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
import { startLangfuseRecorder } from "./recorder.js";

/**
 * Transport-fault regressions at the real seams:
 *
 * - The first test drives a genuine Pi SDK session whose recorder deliberately
 *   rejects the first OTLP posts, so recovery happens through the extension's
 *   production shutdown path: rejection, bounded replay, and confirmation on
 *   the supported v2 observations surface.
 * - The remaining tests drive the rest-fallback drain module directly (the
 *   seam the validator used, because oversized and partialSuccess faults
 *   cannot be injected at the session level) with the real OTLP replay
 *   exporter and a fault-injecting recorder.
 *
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

/**
 * Drain dependencies against the recorder: the completeness check queries the
 * recorder's supported v2 observations surface, and replays go through the
 * real OTLP fallback transport.
 */
function drainDeps(recorder: RuntimeCase["recorder"]): RestFallbackDeps {
	const getMany = async (query: { traceId: string }) => {
		const response = await fetch(
			`${recorder.url}/api/public/v2/observations?traceId=${encodeURIComponent(query.traceId)}`,
			{
				headers: { authorization: "Basic dDp0" },
				signal: AbortSignal.timeout(3_000),
			},
		);
		const page = (await response.json()) as { data?: unknown[] };
		return { data: page.data ?? [], meta: {} };
	};
	// SAFETY: the drain reads only client.api.observations.getMany; the
	// minimal query shape mirrors how the production score client is called.
	return {
		client: {
			api: { observations: { getMany } },
		} as unknown as RestFallbackDeps["client"],
		transport: createOtlpFallbackTransport({
			host: recorder.url,
			publicKey: "pk-drain-test",
			secretKey: "sk-drain-test",
		}),
	};
}

describe("pi runtime transport recovery", () => {
	it("recovers a transport-rejected export through the supported OTLP/v2 surface at the Pi session boundary", async () => {
		// Production drain behavior under fault: rounds are bounded, so shrink
		// the wall-clock windows without touching the recovery contract.
		restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 1_500,
			traceVisibilityMs: 100,
			pollIntervalMs: 10,
		});
		const marker = "PR-RECOVERY-canary";
		const secret = "SUP3R-PR-SECRET";
		// Quoted key with a newline separator: the shape the redaction model
		// handles in-place while keeping the surrounding marker text.
		const secretPattern = `{"api_password"\n : "${secret}"`;
		const userPrompt = `${marker}: setup ${secretPattern}"`;
		const finalText = "PR-RECOVERY final answer";
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
			name: "otlp-recovery",
			provider: { kind: "faux" },
			settings: { environment: "PR-RECOVERY-ENV" },
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
		activeCase = runtimeCase;
		const piAi = runtimeCase.piAi;
		const faux = runtimeCase.faux;
		if (!faux) throw new Error("faux provider was not registered");
		faux.setResponses([
			piAi.fauxAssistantMessage([
				piAi.fauxToolCall(
					"probe_echo",
					{ q: "probe" },
					{ id: "call-pr-rec-1" },
				),
			]),
			piAi.fauxAssistantMessage([piAi.fauxText(finalText)]),
		]);

		// Deliberate fault, separate from the healthy default: reject the first
		// two OTLP posts carrying the marker (the normal export and the first
		// replay round), then accept. 400 is nonretryable for the OTel
		// exporter, so the normal transport cannot recover on its own and the
		// accepted delivery below can only be the fallback replay.
		runtimeCase.recorder.faults.rejectBodiesContaining = [marker];
		runtimeCase.recorder.faults.gateAtMatchedCount = 2;
		runtimeCase.recorder.faults.rejectStatus = 400;

		const warns: string[] = [];
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation((...parts: unknown[]) => {
				warns.push(parts.map((part) => String(part)).join(" "));
			});

		try {
			await runtimeCase.session.prompt(userPrompt);
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			// Shutdown drain: replay rounds with production-shaped, bounded windows.
			await shutdownClient();
			drainRawTraceQueue();
		} finally {
			warnSpy.mockRestore();
		}

		const recorder = runtimeCase.recorder;
		const accepted = spansFromAccepted(recorder);

		// --- endpoint discipline: OTLP + v2 only, no legacy routes ---
		expect(recorder.legacyHits).toEqual([]);
		expect(recorder.pollCounts.size).toBe(1);

		// --- the accepted delivery is the fallback replay, provably ---
		// 400 is nonretryable, so the exporter cannot recover by itself: the
		// normal export and the first replay round are both rejected, and the
		// single accepted post can only be the fallback replay. Its spans ride
		// the fallback's instrumentation scope, not the normal exporter's.
		expect(recorder.postsRejected).toBe(2);
		expect(recorder.postsAccepted).toBe(1);
		expect(recorder.postsTotal).toBe(3);
		for (const span of accepted) {
			expect(span.scopeName).toBe("pi-langfuse-rest-fallback");
		}

		// --- stable identities: the replay carries the original ids ---
		const otlpPosts = recorder.records.filter((record) =>
			record.path.includes("/otel/v1/traces"),
		);
		const firstPostIds = new Set(
			decodeOtlpPayload(otlpPosts[0]?.body).map((span) => span.spanId),
		);
		const replayedIds = new Set(accepted.map((span) => span.spanId));
		expect(firstPostIds.size).toBeGreaterThan(0);
		expect(replayedIds).toEqual(firstPostIds);

		// --- delivery: the server-visible index holds every expected span ---
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
		const traceId = [...traceIds][0];
		const indexed = recorder.index.get(traceId ?? "");
		const uniqueDeliveredSpanIds = new Set(accepted.map((span) => span.spanId));
		expect(indexed?.size).toBe(uniqueDeliveredSpanIds.size);
		expect(recorder.index.size).toBe(1);
		// The fallback confirmed the replay through the supported surface and
		// retired the trace: the completeness check ran for it.
		expect(recorder.pollCounts.get(traceId ?? "") ?? 0).toBeGreaterThan(0);

		// --- tool SPAN usage/cost fidelity in the replay-delivered payload ---
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

		// --- privacy through normal export, replay, and raw records ---
		const sinkText = JSON.stringify(recorder.records);
		expect(sinkText).not.toContain(secret);
		expect(sinkText).toContain("[REDACTED:");
		const rawText = JSON.stringify(
			readRawTraceRecords(runtimeCase.rawTraceDir),
		);
		expect(rawText).not.toContain(secret);
		expect(rawText).toContain("[REDACTED:");
		expect(rawText).toContain(marker);

		// --- the fallback retired everything during the shutdown drain ---
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});

		// --- honest diagnostics: recovery succeeded, nothing reported lost ---
		const lossWarnings = warns.filter(
			(warning) =>
				warning.includes("discarded") ||
				warning.includes("could not be delivered"),
		);
		expect(lossWarnings).toEqual([]);
		expect(JSON.stringify(recorder.records)).not.toContain(
			"sk-local-runtime-test-secret",
		);
	});

	it("discards an oversized trace terminally while a delayed-index trace recovers exactly once", async () => {
		const recorder = await startLangfuseRecorder("drain-mixed");
		try {
			const store = createRestFallbackStore();
			const now = () => new Date().toISOString();

			// Trace A: one span whose serialized body exceeds the 3.5 MB wire
			// batch limit; every replay drops it before sending.
			const oversizedId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
			recordTrace(store, {
				id: oversizedId,
				timestamp: now(),
				body: { name: "pi-agent" },
			});
			recordObservation(store, {
				id: "aaaa-span-root",
				traceId: oversizedId,
				name: "agent.prompt",
				type: "SPAN",
				startTime: now(),
				body: { input: "A".repeat(3_550_000) },
			});
			completeTrace(store, oversizedId);

			// Trace B: usage/cost-bearing tool SPAN plus a generation. Delayed
			// indexing: the recorder serves empty v2 pages for the first polls,
			// so confirmation lags the accepted POST by one drain round.
			const recoverableId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
			recordTrace(store, {
				id: recoverableId,
				timestamp: now(),
				body: { name: "pi-agent" },
			});
			recordObservation(store, {
				id: "bbbb-span-tool",
				traceId: recoverableId,
				name: "tool:probe_echo",
				type: "SPAN",
				startTime: now(),
				body: {
					usageDetails: { input: 700, output: 70, total: 770 },
					costDetails: { total: 0.77 },
					output: "probe ok",
				},
			});
			recordObservation(store, {
				id: "bbbb-span-gen",
				traceId: recoverableId,
				name: "llm-response",
				type: "GENERATION",
				startTime: now(),
				body: { model: "faux-model", usageDetails: { input: 42, output: 7 } },
			});
			completeTrace(store, recoverableId);

			// Delayed indexing binds to B deterministically: the visibility
			// window is shorter than the poll interval, so every completeness
			// check performs exactly one poll. The first two polls (round 1's
			// pre-send and post-accept checks) hit the lazy empty pages; the
			// round 2 pre-check sees the indexed spans.
			recorder.faults.lazyIndexPolls = 2;

			const deps = drainDeps(recorder);
			const options = {
				requestTimeoutMs: 3_000,
				visibilityTimeoutMs: 40,
				pollIntervalMs: 1_000,
			};

			const rounds = [];
			for (let round = 0; round < 3; round += 1) {
				rounds.push(await drainCompletedRestFallback(store, deps, options));
			}
			const problems = rounds.flatMap((result) => result.problems);
			const terminalText = rounds
				.flatMap((result) => result.terminalLosses)
				.join(" | ");

			// --- oversized trace A: named truthfully, never transmitted, terminally discarded ---
			expect(
				rounds[0]?.problems.some(
					(problem) =>
						problem.includes("no sendable span remained") &&
						problem.includes(oversizedId),
				),
			).toBe(true);
			const oversizedLine = rounds[0]?.problems.find((problem) =>
				problem.includes("oversized"),
			);
			const reportedSize = Number(oversizedLine?.match(/\((\d+) bytes\)/)?.[1]);
			expect(reportedSize).toBeGreaterThan(3_550_000);
			expect(reportedSize).toBeLessThan(3_560_000);
			expect(oversizedLine).toContain("3500000");
			expect(terminalText).toContain(oversizedId);
			expect(terminalText).toContain(
				`${MAX_FALLBACK_ATTEMPTS} failed attempts`,
			);
			for (const record of recorder.records) {
				expect(JSON.stringify(record.body ?? {})).not.toContain(
					"A".repeat(1000),
				);
			}

			// --- delayed-index trace B: sent once, confirmed late, never misreported ---
			const recoverablePosts = recorder.records.filter(
				(record) =>
					record.path.includes("/otel/v1/traces") &&
					JSON.stringify(record.body ?? {}).includes(recoverableId),
			);
			expect(recoverablePosts).toHaveLength(1);
			expect(recoverablePosts[0]?.outcome).toBe("accepted");
			const replayBody = JSON.stringify(recoverablePosts[0]?.body ?? {});
			expect(replayBody).toContain("usage_details");
			expect(replayBody).toContain("700");
			expect(replayBody).toContain("cost_details");
			expect(replayBody).toContain("0.77");
			expect(recorder.index.get(recoverableId)?.has("bbbb-span-tool")).toBe(
				true,
			);
			expect(
				recorder.pollCounts.get(recoverableId) ?? 0,
			).toBeGreaterThanOrEqual(3);
			// Round 1 could not confirm (lazy empty pages) and said so honestly.
			expect(
				rounds[0]?.problems.some(
					(problem) =>
						problem.includes(recoverableId) &&
						problem.includes("sent but not confirmed"),
				),
			).toBe(true);
			// Round 2 confirmed through the v2 surface and retired B without
			// another send; B never appears in any terminal loss.
			expect(
				rounds[1]?.problems.some((problem) => problem.includes(recoverableId)),
			).toBe(false);
			expect(terminalText).not.toContain(recoverableId);

			// Round diagnostics: unconfirmed traces are explicitly retained for a
			// later drain instead of being silently dropped.
			expect(problems.some((problem) => problem.includes("retaining"))).toBe(
				true,
			);
		} finally {
			await recorder.close();
		}
	});

	it("never misreports a partial-acceptance response as delivered and discards after bounded replays", async () => {
		const recorder = await startLangfuseRecorder("drain-partial");
		try {
			const store = createRestFallbackStore();
			const now = () => new Date().toISOString();
			const traceId = "cccccccccccccccccccccccccccccccc";
			recordTrace(store, {
				id: traceId,
				timestamp: now(),
				body: { name: "pi-agent" },
			});
			recordObservation(store, {
				id: "cccc-span-root",
				traceId,
				name: "agent.prompt",
				type: "SPAN",
				startTime: now(),
				body: { output: "c" },
			});
			completeTrace(store, traceId);

			// Deliberate fault: every post answers 200 + partialSuccess and the
			// recorder indexes nothing, so the v2 check stays unsatisfied.
			recorder.faults.partialRejectBodiesContaining = [traceId];

			const deps = drainDeps(recorder);
			const options = {
				requestTimeoutMs: 3_000,
				visibilityTimeoutMs: 100,
				pollIntervalMs: 20,
			};

			const rounds = [];
			for (let round = 0; round < 3; round += 1) {
				rounds.push(await drainCompletedRestFallback(store, deps, options));
			}

			// Every round reports the trace as sent-but-not-confirmed, never
			// delivered; the replay count stays inside the retry budget; the
			// budget exhaustion produces the explicit discard.
			for (const result of rounds) {
				const relevant = result.problems.filter((problem) =>
					problem.includes(traceId),
				);
				for (const problem of relevant) {
					if (problem.includes("replay")) {
						expect(problem).toContain("sent but not confirmed");
					}
				}
			}
			expect(
				rounds
					.flatMap((result) => result.problems)
					.some((problem) => problem.includes("sent but not confirmed")),
			).toBe(true);
			const terminalText = rounds
				.flatMap((result) => result.terminalLosses)
				.join(" | ");
			expect(terminalText).toContain(traceId);
			expect(terminalText).toContain(
				`${MAX_FALLBACK_ATTEMPTS} failed attempts`,
			);
			const posts = recorder.records.filter((record) =>
				record.path.includes("/otel/v1/traces"),
			);
			expect(posts.length).toBeLessThanOrEqual(MAX_FALLBACK_ATTEMPTS);
			for (const post of posts) {
				expect(post.outcome).toBe("partial-reject");
			}
			expect(recorder.index.size).toBe(0);
		} finally {
			await recorder.close();
		}
	});
});
