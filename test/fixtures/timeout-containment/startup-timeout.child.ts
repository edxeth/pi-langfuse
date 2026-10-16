import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, it } from "vitest";
import { shutdownClient } from "../../../src/langfuse-client.js";
import { createRuntimeCase } from "../../pi-runtime/isolated-pi.js";
import {
	containmentState,
	credentialLabel,
	type LateProbe,
	writeProbe,
} from "./probe.js";

// Load the Pi SDK before the timed test so its 1.5 s budget starts the held
// factory deterministically instead of racing the first SDK import.
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
 * The incident shape: a test times out while `createRuntimeCase` is still
 * starting (held inside an extension factory), so `activeCase` is never
 * assigned. Vitest does not cancel the test promise; the startup resumes after
 * setup cleanup and must neither create a session nor prompt anything. The
 * 100 ms close bound makes the suite-level `afterEach` give up on the held
 * startup, which then discards itself when the gate opens.
 */
it("a startup that outlives its test creates no session and prompts nothing", async () => {
	const state = containmentState();
	const probe: LateProbe = { sessionStartObserved: false };

	const lateWork = (async () => {
		try {
			const runtimeCase = await createRuntimeCase({
				name: "containment-startup",
				provider: { kind: "faux" },
				closeTimeoutMs: 100,
				extensionFactories: [
					async (pi: ExtensionAPI) => {
						pi.on("session_start", () => {
							probe.sessionStartObserved = true;
						});
						await state.gate;
					},
				],
			});
			probe.startup = "resolved";
			runtimeCase.faux?.setResponses([
				runtimeCase.piAi.fauxAssistantMessage(
					runtimeCase.piAi.fauxText("late reply"),
				),
			]);
			await runtimeCase.session.prompt("late prompt");
			await runtimeCase.session.waitForIdle();
			probe.latePrompt = "ran";
		} catch (error) {
			if (probe.startup === "resolved") {
				probe.latePrompt = `failed: ${(error as Error).message}`;
			} else {
				probe.startup = `rejected: ${(error as Error).message}`;
			}
		}
		await shutdownClient();
		writeProbe("startup-timeout", {
			...probe,
			...environmentProbe(),
			leftoverCaseDirs: readdirSync(tmpdir()).filter((entry) =>
				entry.startsWith("pi-runtime-containment-startup-"),
			),
		});
	})();
	state.lateWork.push(lateWork);
	await lateWork;
}, 1_500);
