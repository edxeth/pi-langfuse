import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { getConfigFilePath, resolveConfig } from "../../../src/config.js";
import {
	appendRawTrace,
	drainRawTraceQueue,
	rawTracePathForSession,
} from "../../../src/raw-trace.js";
import { containmentState, credentialLabel, writeProbe } from "./probe.js";

/**
 * The incident shape without Pi: a test times out while awaiting work, Vitest
 * moves on and runs every cleanup hook, and the abandoned continuation then
 * resolves runtime configuration, writes a raw trace, and posts to the
 * configured host. Where those land is the boundary under test.
 */
it("resumes after setup cleanup and touches only the sandbox", async () => {
	const state = containmentState();
	const sandboxHome = process.env.HOME;
	if (!sandboxHome) throw new Error("setup did not pin HOME");

	const lateWork = (async () => {
		await state.gate;
		// Observed before the late work can recreate anything in the sandbox.
		const sandboxRemoved = !existsSync(sandboxHome);
		const config = resolveConfig({});
		const sessionFile = join(
			homedir(),
			".pi",
			"agent",
			"sessions",
			"late.jsonl",
		);
		const rawTracePath = rawTracePathForSession(
			sessionFile,
			config.rawTraceDir,
		);
		// Raw tracing is off by default in the sandbox; force it on so the
		// resolved directory itself is what gets exercised.
		appendRawTrace({ ...config, rawTraceEnabled: true }, sessionFile, {
			type: "late_activity_probe",
			timestamp: "2026-10-14T00:00:00.000Z",
		});
		drainRawTraceQueue();

		let requestOutcome: string;
		try {
			const response = await fetch(`${config.host}/api/public/ingestion`, {
				method: "POST",
				headers: {
					authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
				},
				body: "{}",
				signal: AbortSignal.timeout(2_000),
			});
			requestOutcome = `status ${response.status}`;
		} catch (error) {
			const cause = (error as { cause?: { code?: string } }).cause;
			requestOutcome = `failed ${cause?.code ?? (error as Error).name}`;
		}

		writeProbe("late-activity", {
			sandboxHome,
			sandboxRemovedBeforeLateWork: sandboxRemoved,
			home: process.env.HOME,
			homedir: homedir(),
			configPath: getConfigFilePath(),
			rawTraceDir: config.rawTraceDir,
			rawTracePath,
			rawTraceWritten: rawTracePath ? existsSync(rawTracePath) : false,
			host: config.host,
			publicKey: credentialLabel(config.publicKey),
			secretKey: credentialLabel(config.secretKey),
			requestOutcome,
		});
	})();
	state.lateWork.push(lateWork);
	await lateWork;
}, 50);
