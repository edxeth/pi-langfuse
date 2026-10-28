import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flushClient } from "../../src/langfuse-client.js";
import {
	closeOpenRuntimeCases,
	createRuntimeCase,
	type RuntimeCase,
	warmRuntimeCase,
} from "./isolated-pi.js";

/**
 * Lifecycle contract of the real-Pi fixture: ownership is taken before startup
 * awaits, teardown is idempotent, a failed or abandoned startup releases
 * everything it created, and the process environment is never left pointing
 * at a case or at anything but the pinned test sandbox.
 */

let activeCase: RuntimeCase | undefined;

beforeAll(warmRuntimeCase);

afterEach(async () => {
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
});

function caseDirsNamed(name: string): string[] {
	return readdirSync(tmpdir()).filter((entry) =>
		entry.startsWith(`pi-runtime-${name}-`),
	);
}

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** An extension factory that reports entry, then waits for `gate`. */
function heldFactory(entered: () => void, gate: Promise<void>) {
	return async (_pi: ExtensionAPI) => {
		entered();
		await gate;
	};
}

describe("runtime case lifecycle", () => {
	it("restores the pinned environment, closes the recorder, and refuses the session after an idempotent teardown", async () => {
		const environmentBefore = { ...process.env };
		const runtimeCase = await createRuntimeCase({
			name: "lifecycle-normal",
			provider: { kind: "faux" },
		});
		activeCase = runtimeCase;
		expect(process.env.HOME).toBe(join(runtimeCase.caseDir, "home"));
		expect(process.env.PI_CODING_AGENT_DIR).toBe(
			join(runtimeCase.caseDir, "agent"),
		);

		await runtimeCase.teardown();
		await runtimeCase.teardown();

		expect({ ...process.env }).toEqual(environmentBefore);
		expect(existsSync(runtimeCase.caseDir)).toBe(false);
		await expect(fetch(runtimeCase.recorder.url)).rejects.toThrow();
		expect(() => runtimeCase.session.prompt("after teardown")).toThrow(
			/is closed; session\.prompt\(\) was refused/,
		);
		// A test may still dispose a session it already finished with.
		expect(() => runtimeCase.session.dispose()).not.toThrow();
	});

	it("stops a running prompt before it removes the case", async () => {
		const runtimeCase = await createRuntimeCase({
			name: "lifecycle-running",
			provider: { kind: "faux" },
		});
		activeCase = runtimeCase;
		const { faux, piAi, session } = runtimeCase;
		if (!faux) throw new Error("Expected isolated faux provider");
		faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText("ok")])]);

		const prompt = session.prompt("prompt in flight at teardown");
		await runtimeCase.teardown();
		await prompt.catch(() => undefined);

		expect(existsSync(runtimeCase.caseDir)).toBe(false);
		expect(runtimeCase.recorder.legacyHits).toEqual([]);
	});

	it("exports to the case recorder, not to a destination the process environment names", async () => {
		const inherited = {
			LANGFUSE_PUBLIC_KEY: "pk-lf-canary-inherited",
			LANGFUSE_SECRET_KEY: "sk-lf-canary-inherited",
			LANGFUSE_BASE_URL: "http://127.0.0.1:9",
		};
		const environmentBefore = { ...process.env };
		Object.assign(process.env, inherited);
		try {
			const runtimeCase = await createRuntimeCase({
				name: "lifecycle-credentials",
				provider: { kind: "faux" },
			});
			activeCase = runtimeCase;
			for (const key of Object.keys(inherited)) {
				expect(process.env[key]).toBeUndefined();
			}
			const { faux, piAi, session, recorder } = runtimeCase;
			if (!faux) throw new Error("Expected isolated faux provider");
			faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText("ok")])]);
			await session.prompt("credential isolation prompt");
			await session.waitForIdle();
			await flushClient();
			expect(recorder.postsAccepted).toBeGreaterThan(0);

			await runtimeCase.teardown();
			expect(process.env.LANGFUSE_BASE_URL).toBe(inherited.LANGFUSE_BASE_URL);
		} finally {
			for (const key of Object.keys(inherited)) delete process.env[key];
			Object.assign(process.env, environmentBefore);
		}
	});

	it("releases everything after a failed startup and lets the next case start", async () => {
		const environmentBefore = { ...process.env };
		const dirsBefore = caseDirsNamed("lifecycle-failed");

		await expect(
			createRuntimeCase({
				name: "lifecycle-failed",
				provider: { kind: "faux" },
				extensionFactories: [
					() => {
						throw new Error("synthetic startup failure");
					},
				],
			}),
		).rejects.toThrow(/discovery is not clean/);

		expect({ ...process.env }).toEqual(environmentBefore);
		expect(caseDirsNamed("lifecycle-failed")).toEqual(dirsBefore);

		activeCase = await createRuntimeCase({
			name: "lifecycle-after-failure",
			provider: { kind: "faux" },
		});
		expect(activeCase.discovery.extensions).toBe(1);
	});

	it("refuses to start a second case while one is open", async () => {
		activeCase = await createRuntimeCase({
			name: "lifecycle-first",
			provider: { kind: "faux" },
		});
		await expect(
			createRuntimeCase({
				name: "lifecycle-second",
				provider: { kind: "faux" },
			}),
		).rejects.toThrow(/lifecycle-first is still open/);
		expect(caseDirsNamed("lifecycle-second")).toEqual([]);
	});

	it("discards a startup abandoned mid-flight without creating a session", async () => {
		const environmentBefore = { ...process.env };
		const entered = deferred();
		const gate = deferred();
		let sessionStarted = false;

		const startup = createRuntimeCase({
			name: "lifecycle-abandoned",
			provider: { kind: "faux" },
			extensionFactories: [
				async (pi: ExtensionAPI) => {
					pi.on("session_start", () => {
						sessionStarted = true;
					});
					entered.resolve();
					await gate.promise;
				},
			],
		});
		const outcome = startup.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await entered.promise;

		// This is what the suite-level afterEach does after a timeout: the test
		// never assigned activeCase, yet the startup is still reachable.
		const closing = closeOpenRuntimeCases();
		gate.resolve();
		await closing;

		await expect(outcome).resolves.toMatch(
			/lifecycle-abandoned was closed before startup finished/,
		);
		expect(sessionStarted).toBe(false);
		expect({ ...process.env }).toEqual(environmentBefore);
		expect(caseDirsNamed("lifecycle-abandoned")).toEqual([]);
	});

	it("bounds the wait for an unresponsive startup and blocks new cases until it discards itself", async () => {
		const environmentBefore = { ...process.env };
		const entered = deferred();
		const gate = deferred();

		const startup = createRuntimeCase({
			name: "lifecycle-unresponsive",
			provider: { kind: "faux" },
			closeTimeoutMs: 25,
			extensionFactories: [heldFactory(entered.resolve, gate.promise)],
		});
		const outcome = startup.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await entered.promise;

		await expect(closeOpenRuntimeCases()).rejects.toThrow(
			/runtime case cleanup failed/,
		);
		await expect(
			createRuntimeCase({
				name: "lifecycle-blocked",
				provider: { kind: "faux" },
			}),
		).rejects.toThrow(/lifecycle-unresponsive is still open/);

		gate.resolve();
		await expect(outcome).resolves.toMatch(/closed before startup finished/);
		expect({ ...process.env }).toEqual(environmentBefore);
		expect(caseDirsNamed("lifecycle-unresponsive")).toEqual([]);

		activeCase = await createRuntimeCase({
			name: "lifecycle-recovered",
			provider: { kind: "faux" },
		});
	});

	describe("work that outlives a bounded close", () => {
		/**
		 * A bounded close is a caller failure, not permission to release the
		 * case: while the held work exists, the environment, the directory and
		 * the lease stay owned, and no other case may start. Once the work
		 * settles, a later close completes the release.
		 */
		async function expectRetainedThenReleased(
			runtimeCase: RuntimeCase,
			environmentBefore: NodeJS.ProcessEnv,
			work: {
				prompt: Promise<unknown>;
				open: () => void;
				observedHome: () => string | undefined;
			},
		) {
			const caseHome = join(runtimeCase.caseDir, "home");
			await expect(runtimeCase.teardown()).rejects.toThrow(
				/runtime case lifecycle-held-/,
			);
			expect(process.env.HOME).toBe(caseHome);
			expect(existsSync(runtimeCase.caseDir)).toBe(true);
			await expect(
				createRuntimeCase({
					name: "lifecycle-blocked-by-work",
					provider: { kind: "faux" },
				}),
			).rejects.toThrow(/is still open/);
			expect(caseDirsNamed("lifecycle-blocked-by-work")).toEqual([]);

			work.open();
			await work.prompt.catch(() => undefined);
			// The held work resumed while the case still owned the environment.
			expect(work.observedHome()).toBe(caseHome);

			await vi.waitFor(() => closeOpenRuntimeCases(), { timeout: 10_000 });
			expect({ ...process.env }).toEqual(environmentBefore);
			expect(existsSync(runtimeCase.caseDir)).toBe(false);
			activeCase = await createRuntimeCase({
				name: "lifecycle-after-held-work",
				provider: { kind: "faux" },
			});
		}

		it("keeps the case owned while a prompt is held before the agent starts", async () => {
			const environmentBefore = { ...process.env };
			const entered = deferred();
			const gate = deferred();
			let observedHome: string | undefined;
			const runtimeCase = await createRuntimeCase({
				name: "lifecycle-held-preflight",
				provider: { kind: "faux" },
				closeTimeoutMs: 50,
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.on("before_agent_start", async () => {
							entered.resolve();
							await gate.promise;
							observedHome = process.env.HOME;
						});
					},
				],
			});
			activeCase = runtimeCase;
			runtimeCase.faux?.setResponses([
				runtimeCase.piAi.fauxAssistantMessage([
					runtimeCase.piAi.fauxText("held reply"),
				]),
			]);
			const prompt = runtimeCase.session.prompt("held before agent start");
			try {
				await entered.promise;
				// The SDK does not consider the agent running yet.
				await expectRetainedThenReleased(runtimeCase, environmentBefore, {
					prompt,
					open: gate.resolve,
					observedHome: () => observedHome,
				});
			} finally {
				gate.resolve();
				await prompt.catch(() => undefined);
			}
		});

		it("keeps the case owned while a tool ignores abort, so the next case cannot inherit it", async () => {
			const environmentBefore = { ...process.env };
			const entered = deferred();
			const gate = deferred();
			let observedHome: string | undefined;
			const runtimeCase = await createRuntimeCase({
				name: "lifecycle-held-tool",
				provider: { kind: "faux" },
				closeTimeoutMs: 50,
				customToolsFactory: (piAi) => [
					{
						name: "held_tool",
						label: "Held tool",
						description: "Ignores abort until the test opens its gate.",
						parameters: piAi.Type.Object({}),
						execute: async () => {
							entered.resolve();
							await gate.promise;
							observedHome = process.env.HOME;
							return { content: [{ type: "text", text: "late" }], details: {} };
						},
					},
				],
			});
			activeCase = runtimeCase;
			runtimeCase.faux?.setResponses([
				runtimeCase.piAi.fauxAssistantMessage([
					runtimeCase.piAi.fauxToolCall("held_tool", {}),
				]),
				runtimeCase.piAi.fauxAssistantMessage([
					runtimeCase.piAi.fauxText("done"),
				]),
			]);
			const prompt = runtimeCase.session.prompt("hold a tool");
			try {
				await entered.promise;
				await expectRetainedThenReleased(runtimeCase, environmentBefore, {
					prompt,
					open: gate.resolve,
					observedHome: () => observedHome,
				});
			} finally {
				gate.resolve();
				await prompt.catch(() => undefined);
			}
		});

		it("reports a cleanup failure that surfaces after the caller stopped waiting", async () => {
			const entered = deferred();
			const gate = deferred();
			const runtimeCase = await createRuntimeCase({
				name: "lifecycle-late-failure",
				provider: { kind: "faux" },
				closeTimeoutMs: 50,
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.on("before_agent_start", async () => {
							entered.resolve();
							await gate.promise;
						});
					},
				],
			});
			activeCase = runtimeCase;
			runtimeCase.faux?.setResponses([
				runtimeCase.piAi.fauxAssistantMessage([
					runtimeCase.piAi.fauxText("held reply"),
				]),
			]);
			// The recorder still closes for real; only the outcome is a failure.
			const closeRecorder = runtimeCase.recorder.close.bind(
				runtimeCase.recorder,
			);
			runtimeCase.recorder.close = async () => {
				await closeRecorder();
				throw new Error("synthetic recorder close failure");
			};
			const prompt = runtimeCase.session.prompt("held before agent start");
			await entered.promise;
			await expect(runtimeCase.teardown()).rejects.toThrow(
				/did not finish closing/,
			);

			gate.resolve();
			await prompt.catch(() => undefined);
			await vi.waitFor(
				() => expect(existsSync(runtimeCase.caseDir)).toBe(false),
				{
					timeout: 10_000,
				},
			);
			const reported = await closeOpenRuntimeCases().catch(
				(error: AggregateError) => error,
			);
			expect(reported).toBeInstanceOf(AggregateError);
			expect(
				(reported as AggregateError).errors.map(
					(error: Error) => error.message,
				),
			).toEqual(["synthetic recorder close failure"]);
			// Reported once: the next case starts normally.
			activeCase = await createRuntimeCase({
				name: "lifecycle-after-late-failure",
				provider: { kind: "faux" },
			});
		});
	});
});
