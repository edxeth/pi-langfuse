import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getLastRuntimeError,
	getRuntimeRegistrySizeForTest,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "../../src/langfuse-client.js";
import { subscribeRuntimeErrors } from "../../src/runtime-diagnostics.js";
import {
	captureSessionEvents,
	createRuntimeCase,
	type RuntimeCase,
} from "./isolated-pi.js";

/**
 * Server-mode regressions under the single-export pipeline.
 *
 * The extension's only delivery surface is OTLP ingestion (POST
 * /api/public/otel/v1/traces). Acceptance is the transport response itself,
 * so the observations read APIs (v2 and the legacy v1 read) are never
 * queried: no negotiation, no caching, no completeness polling. These tests
 * run real Pi sessions against recorder servers that model every read-surface
 * mode (v2 supported, v2 404, legacy v1 working, both missing) and prove:
 *
 * - delivery is accepted on every mode, and each prompt's export is flushed
 *   before shutdown instead of being delayed by read availability;
 * - zero GET requests reach the server regardless of mode, so a delayed or
 *   unavailable observation index can neither delay a prompt nor trigger a
 *   replay;
 * - the console stays free of Langfuse output and no new runtime diagnostic
 *   appears when delivery is accepted.
 *
 * Everything stays on 127.0.0.1 with synthetic credentials and temp
 * directories; no live providers, no persistent Langfuse, no user resources.
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

/** Capture every console channel; the runtime must not write to it. */
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

function runtimeErrorSignature(): string | undefined {
	const error = getLastRuntimeError();
	return error ? `${error.timestamp} ${error.message}` : undefined;
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

describe("pi runtime delivery across server read-surface modes", () => {
	it("delivers both prompts with zero observation reads on a server where v2 and the legacy v1 read are both 404", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 1_500 });
		const runtimeCase = await createFauxCase("server-mode-no-reads");
		activeCase = runtimeCase;
		// Neither read API exists (servers outside v4 write mode). Delivery
		// must not care: acceptance is the transport response.
		runtimeCase.recorder.faults.v2Status = 404;
		runtimeCase.recorder.faults.v1Status = 404;

		const errorBefore = runtimeErrorSignature();
		const diagnostics: string[] = [];
		const stopDiagnostics = subscribeRuntimeErrors((error) => {
			diagnostics.push(error.message);
		});
		const consoleCapture = captureConsole();
		try {
			captureSessionEvents(runtimeCase.session);
			await runtimeCase.session.prompt("mode prompt one");
			await runtimeCase.session.waitForIdle();
			await runtimeCase.session.prompt("mode prompt two");
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			await shutdownClient();
		} finally {
			consoleCapture.stop();
			stopDiagnostics();
		}

		const recorder = runtimeCase.recorder;

		// --- delivery: three observations per prompt, each exported once ---
		expect(recorder.postsTotal).toBe(6);
		expect(recorder.postsAccepted).toBe(6);
		expect(recorder.index.size).toBe(2);
		for (const spans of recorder.index.values()) {
			expect(spans.size).toBeGreaterThanOrEqual(3);
		}

		// --- read discipline: the missing surfaces were never probed ---
		expect(recorder.records.filter((r) => r.method === "GET")).toEqual([]);
		expect(recorder.v1Hits).toBe(0);
		expect(recorder.pollCounts.size).toBe(0);

		// --- endpoint discipline: no legacy ingestion or trace lookups ---
		expect(recorder.legacyHits).toEqual([]);

		// --- clean diagnostics: acceptance is final, nothing was reported ---
		expect(diagnostics).toEqual([]);
		expect(langfuseConsoleOutput(consoleCapture.output)).toEqual([]);
		expect(runtimeErrorSignature()).toBe(errorBefore);
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});
	}, 30_000);

	it("never queries a legacy v1 read even when the server offers it", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 1_500 });
		const runtimeCase = await createFauxCase("server-mode-v1-available");
		activeCase = runtimeCase;
		// v2 is unsupported (404 outside v4 write mode) but the legacy v1 read
		// works. The old pipeline negotiated and cached it; the single-export
		// pipeline must ignore the read surface entirely.
		runtimeCase.recorder.faults.v2Status = 404;
		runtimeCase.recorder.faults.v1Status = 200;

		const errorBefore = runtimeErrorSignature();
		const diagnostics: string[] = [];
		const stopDiagnostics = subscribeRuntimeErrors((error) => {
			diagnostics.push(error.message);
		});
		const consoleCapture = captureConsole();
		try {
			await runtimeCase.session.prompt("mode prompt one");
			await runtimeCase.session.waitForIdle();
			await runtimeCase.session.prompt("mode prompt two");
			await runtimeCase.session.waitForIdle();
			runtimeCase.session.dispose();
			await shutdownClient();
		} finally {
			consoleCapture.stop();
			stopDiagnostics();
		}

		const recorder = runtimeCase.recorder;

		expect(recorder.postsTotal).toBe(6);
		expect(recorder.postsAccepted).toBe(6);
		expect(recorder.index.size).toBe(2);
		// The offered read was never used: no v1 hits, no v2 probes.
		expect(recorder.v1Hits).toBe(0);
		expect(recorder.pollCounts.size).toBe(0);
		expect(recorder.legacyHits).toEqual([]);
		expect(diagnostics).toEqual([]);
		expect(langfuseConsoleOutput(consoleCapture.output)).toEqual([]);
		expect(runtimeErrorSignature()).toBe(errorBefore);
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});
	}, 30_000);

	it("flushes each prompt's export before shutdown and drains cleanly on a healthy server", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 1_500 });
		const runtimeCase = await createFauxCase("server-mode-healthy");
		activeCase = runtimeCase;

		const diagnostics: string[] = [];
		const stopDiagnostics = subscribeRuntimeErrors((error) => {
			diagnostics.push(error.message);
		});
		const consoleCapture = captureConsole();
		let postsAfterSecondPrompt = -1;
		let shutdownElapsedMs = -1;
		try {
			await runtimeCase.session.prompt("mode prompt one");
			await runtimeCase.session.waitForIdle();
			await runtimeCase.session.prompt("mode prompt two");
			await runtimeCase.session.waitForIdle();
			// The final prompt's export is flushed by the prompt itself: no
			// read index exists to wait for, so nothing is left for shutdown.
			postsAfterSecondPrompt = runtimeCase.recorder.postsAccepted;
			runtimeCase.session.dispose();
			const shutdownStartedAt = Date.now();
			await shutdownClient();
			shutdownElapsedMs = Date.now() - shutdownStartedAt;
		} finally {
			consoleCapture.stop();
			stopDiagnostics();
		}

		const recorder = runtimeCase.recorder;

		expect(postsAfterSecondPrompt).toBe(6);
		expect(recorder.postsTotal).toBe(6);
		expect(recorder.records.filter((r) => r.method === "GET")).toEqual([]);
		// Shutdown drains an already-empty pipeline, well inside the bounded
		// per-step window (4 steps x 1500 ms worst case).
		expect(shutdownElapsedMs).toBeLessThan(6_000);
		expect(recorder.index.size).toBe(2);
		expect(diagnostics).toEqual([]);
		expect(langfuseConsoleOutput(consoleCapture.output)).toEqual([]);
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});
	}, 30_000);
});
