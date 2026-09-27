import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getLastRuntimeError,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "../../src/langfuse-client.js";
import {
	captureSessionEvents,
	createRuntimeCase,
	type RuntimeCase,
} from "./isolated-pi.js";

/**
 * Real-Pi regressions for observation confirmation against the server modes
 * users actually run (contract from the v2/v1 negotiation fix):
 *
 * - v4-write-mode servers answer the v2 observations query; older servers
 *   reject it with 404 while the legacy `GET /api/public/observations` read
 *   still returns the stored observations.
 * - Only a 404 negotiates the API version. Unauthorized (401/403) and server
 *   failures stay unconfirmed: delivery is never faked and a failed v1 is
 *   never cached.
 * - A successful legacy read caches v1 per client, so later prompts skip the
 *   failing v2 probe; a later v1 404 negotiates back up to v2.
 *
 * These tests drive real Pi sessions so the per-prompt flush, the cross-prompt
 * client cache, and the shutdown drain all run exactly as in production. The
 * footer contract is asserted directly: zero Langfuse warnings and no new
 * runtime error when delivery is confirmable.
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

/** Capture only the extension's own diagnostics; unrelated noise is ignored. */
function captureLangfuseWarnings() {
	const warnings: string[] = [];
	const spy = vi
		.spyOn(console, "warn")
		.mockImplementation((...parts: unknown[]) => {
			const text = parts.map((part) => String(part)).join(" ");
			if (text.includes("📊 Langfuse:")) warnings.push(text);
		});
	return {
		warnings,
		stop: () => spy.mockRestore(),
	};
}

function runtimeErrorSignature(): string | undefined {
	const error = getLastRuntimeError();
	return error ? `${error.timestamp} ${error.message}` : undefined;
}

/** Every v2 observations request with the trace id it probed. */
function v2ProbeRequests(recorder: RuntimeCase["recorder"]): Array<{
	traceId: string;
	outcome: string;
}> {
	return recorder.records
		.filter((record) => record.path.includes("/api/public/v2/observations"))
		.map((record) => ({
			traceId:
				new URL(record.path, "http://127.0.0.1").searchParams.get("traceId") ??
				"",
			outcome: record.outcome,
		}));
}

async function createFauxCase(name: string): Promise<RuntimeCase> {
	const runtimeCase = await createRuntimeCase({
		name,
		provider: { kind: "faux" },
	});
	const piAi = runtimeCase.piAi;
	const faux = runtimeCase.faux;
	if (!faux) throw new Error("faux provider was not registered");
	faux.setResponses([
		piAi.fauxAssistantMessage([piAi.fauxText("answer one")]),
		piAi.fauxAssistantMessage([piAi.fauxText("answer two")]),
	]);
	return runtimeCase;
}

async function runTwoPrompts(runtimeCase: RuntimeCase): Promise<void> {
	captureSessionEvents(runtimeCase.session);
	await runtimeCase.session.prompt("mode prompt one");
	await runtimeCase.session.waitForIdle();
	await runtimeCase.session.prompt("mode prompt two");
	await runtimeCase.session.waitForIdle();
	runtimeCase.session.dispose();
	await shutdownClient();
}

describe("pi runtime observation confirmation across server modes", () => {
	it("confirms delivery through the legacy v1 read on a v2-404 server with zero warnings across prompts and shutdown", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 1_500,
			traceVisibilityMs: 100,
			pollIntervalMs: 10,
		});
		const runtimeCase = await createFauxCase("server-mode-v1-available");
		activeCase = runtimeCase;
		// The user's server shape: OTLP ingestion works, the v2 observations
		// query does not exist (404 outside v4 write mode), the legacy v1 read
		// returns the stored observations.
		runtimeCase.recorder.faults.v2Status = 404;
		runtimeCase.recorder.faults.v1Status = 200;

		const errorBefore = runtimeErrorSignature();
		const { warnings, stop } = captureLangfuseWarnings();
		try {
			await runTwoPrompts(runtimeCase);
		} finally {
			stop();
		}

		const recorder = runtimeCase.recorder;

		// --- delivery: one accepted export per prompt, no replay posts ---
		expect(recorder.postsTotal).toBe(2);
		expect(recorder.postsAccepted).toBe(2);
		expect(recorder.index.size).toBe(2);
		for (const spans of recorder.index.values()) {
			expect(spans.size).toBeGreaterThanOrEqual(3);
		}

		// --- negotiation is bounded and then cached per client ---
		// Only the first trace is ever probed on v2 (a single 404, then v1);
		// the second prompt goes straight to the cached v1 read.
		const v2Probes = v2ProbeRequests(recorder);
		expect(v2Probes).toHaveLength(1);
		expect(v2Probes[0]?.outcome).toBe("v2-404");
		expect(recorder.v1Hits).toBe(2);

		// --- endpoint discipline: no legacy ingestion or trace lookups ---
		expect(recorder.legacyHits).toEqual([]);

		// --- the footer contract: no warning churn, no runtime error ---
		expect(warnings).toEqual([]);
		expect(runtimeErrorSignature()).toBe(errorBefore);
	});

	it("keeps an unauthorized legacy read strict: honest warnings, no false confirmation, no cached v1", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 1_500,
			traceVisibilityMs: 100,
			pollIntervalMs: 10,
		});
		const runtimeCase = await createFauxCase("server-mode-v1-unauthorized");
		activeCase = runtimeCase;
		// Neither surface can confirm: v2 is unsupported (404) and the legacy
		// read rejects the credentials (401). The trace data itself is accepted.
		runtimeCase.recorder.faults.v2Status = 404;
		runtimeCase.recorder.faults.v1Status = 401;

		const errorBefore = runtimeErrorSignature();
		const { warnings, stop } = captureLangfuseWarnings();
		try {
			await runTwoPrompts(runtimeCase);
		} finally {
			stop();
		}

		const recorder = runtimeCase.recorder;

		// Delivery still reached the server; the client just cannot confirm it.
		expect(recorder.postsAccepted).toBeGreaterThanOrEqual(2);
		expect(recorder.index.size).toBe(2);

		// Strict policy: 401 never negotiates and never caches, so later checks
		// keep probing v2 first for both traces and warn honestly instead of
		// pretending the sends were confirmed.
		expect(
			new Set(v2ProbeRequests(recorder).map((probe) => probe.traceId)).size,
		).toBe(2);
		expect(recorder.v1Hits).toBeGreaterThanOrEqual(2);
		expect(warnings.length).toBeGreaterThanOrEqual(2);
		expect(warnings.some((warning) => warning.includes("not confirmed"))).toBe(
			true,
		);

		// The drain reports the exhausted traces as terminal losses instead of
		// dropping them silently.
		expect(runtimeErrorSignature()).not.toBe(errorBefore);
		expect(getLastRuntimeError()?.message).toContain("discarded");

		// Replay posts stay inside the bounded budget (per-prompt drains plus
		// up to MAX_FALLBACK_ATTEMPTS shutdown rounds).
		expect(recorder.postsTotal).toBeLessThanOrEqual(8);
		expect(recorder.legacyHits).toEqual([]);
	});

	it("negotiates back up to v2 after a server upgrade removes the cached v1 read", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 1_500,
			traceVisibilityMs: 100,
			pollIntervalMs: 10,
		});
		const runtimeCase = await createFauxCase("server-mode-v1-to-v2-upgrade");
		activeCase = runtimeCase;
		// Prompt 1 runs against the old server: v2 unsupported, v1 works.
		runtimeCase.recorder.faults.v2Status = 404;
		runtimeCase.recorder.faults.v1Status = 200;

		const piAi = runtimeCase.piAi;
		runtimeCase.faux?.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxText("old server answer")]),
			piAi.fauxAssistantMessage([piAi.fauxText("upgraded server answer")]),
		]);

		await runtimeCase.session.prompt("mode prompt one");
		await runtimeCase.session.waitForIdle();
		expect(runtimeCase.recorder.index.size).toBe(1);

		// The server upgrades to v4 write mode mid-session: v1 is removed and
		// v2 starts answering.
		runtimeCase.recorder.faults.v2Status = 200;
		runtimeCase.recorder.faults.v1Status = 404;

		const errorBefore = runtimeErrorSignature();
		const { warnings, stop } = captureLangfuseWarnings();
		try {
			await runtimeCase.session.prompt("mode prompt two");
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			await shutdownClient();
		} finally {
			stop();
		}

		const recorder = runtimeCase.recorder;

		// The cached-v1 client re-probes v1 (404), negotiates back up to v2,
		// confirms the new trace, and clears the stale cache entry.
		expect(recorder.v1Hits).toBe(2);
		// v2 was asked exactly twice: once per trace (the first probe 404s,
		// the post-upgrade probe confirms).
		expect(v2ProbeRequests(recorder)).toHaveLength(2);
		expect(recorder.index.size).toBe(2);
		expect(recorder.postsTotal).toBe(2);
		expect(recorder.legacyHits).toEqual([]);
		expect(warnings).toEqual([]);
		expect(runtimeErrorSignature()).toBe(errorBefore);
	});
});
