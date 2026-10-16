import { homedir } from "node:os";
import { afterEach, beforeAll, it } from "vitest";
import { shutdownClient } from "../../../src/langfuse-client.js";
import {
	createRuntimeCase,
	type RuntimeCase,
	readRawTraceRecords,
} from "../../pi-runtime/isolated-pi.js";
import {
	containmentState,
	credentialLabel,
	type LateProbe,
	writeProbe,
} from "./probe.js";

// Same repeated pattern as the real runtime suites.
let activeCase: RuntimeCase | undefined;

afterEach(async () => {
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
});

// Load the Pi SDK before the timed test so its 1.5 s budget is not spent on
// the first SDK import.
beforeAll(async () => {
	await import("@earendil-works/pi-coding-agent");
}, 60_000);

function environmentProbe(): LateProbe {
	return {
		home: process.env.HOME,
		homedir: homedir(),
		agentDir: process.env.PI_CODING_AGENT_DIR,
		baseUrl: process.env.LANGFUSE_BASE_URL,
		publicKey: credentialLabel(process.env.LANGFUSE_PUBLIC_KEY),
	};
}

/**
 * A test times out after `createRuntimeCase` resolved, while its body waits.
 * The suite's `afterEach` tears the case down; the abandoned body then resumes
 * after setup cleanup and tries to prompt the torn-down session.
 */
it("a stale body cannot prompt a case its test already tore down", async () => {
	const state = containmentState();
	const runtimeCase = await createRuntimeCase({
		name: "containment-late-prompt",
		provider: { kind: "faux" },
	});
	activeCase = runtimeCase;
	runtimeCase.faux?.setResponses([
		runtimeCase.piAi.fauxAssistantMessage(
			runtimeCase.piAi.fauxText("late reply"),
		),
	]);

	const lateWork = (async () => {
		await state.gate;
		const probe: LateProbe = {};
		try {
			await runtimeCase.session.prompt("late prompt");
			await runtimeCase.session.waitForIdle();
			probe.latePrompt = "ran";
		} catch (error) {
			probe.latePrompt = `refused: ${(error as Error).message}`;
		}
		await shutdownClient();
		writeProbe("late-prompt", {
			...probe,
			...environmentProbe(),
			recorderRecords: runtimeCase.recorder.records.length,
			rawTraceRecords: readRawTraceRecords(runtimeCase.rawTraceDir).length,
		});
	})();
	state.lateWork.push(lateWork);
	await lateWork;
}, 1_500);
