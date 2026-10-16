import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
	appendRawTrace,
	drainRawTraceQueue,
	rawTracePathForSession,
} from "./raw-trace.js";
import {
	type RuntimeError,
	subscribeRuntimeErrors,
} from "./runtime-diagnostics.js";

/**
 * A configured exact secret can match its own generated marker. A match in
 * the marker's reason moves right by ten characters on each shaping pass;
 * a match in REDACTED moves by only one. These real inputs exercise both
 * settlement within the preview budget and fail-closed pass exhaustion.
 */
const SELF_MATCHING_SECRET = "configured-secret";
const MARKER_PREFIX_SECRET = "REDACTED";

function rawTraceConfig(
	rawTraceDir: string,
	redactionAdditionalSecrets: string[],
) {
	return {
		enabled: false,
		publicKey: "pk-test",
		secretKey: "sk-test-secret-value",
		host: "http://localhost",
		userId: "test-user",
		defaultTags: [],
		release: "",
		environment: "",
		traceInputMaxChars: 2_000,
		traceOutputMaxChars: 2_000,
		toolArgsMaxChars: 500,
		toolOutputMaxChars: 2_000,
		captureToolProgress: true,
		captureMessageUpdates: false,
		skipUnpersistedSessions: false,
		captureProviderPayload: false,
		providerPayloadMaxChars: 50_000,
		redactionEnabled: true,
		redactionAdditionalSecrets,
		rawTraceEnabled: true,
		rawTraceDir,
		rawTraceProviderRequestMode: "summary",
		localAutostart: false,
		localAutostartDir: "/tmp/langfuse",
		localAutostartHealthUrl: "http://localhost:3100",
		localAutostartTimeoutMs: 200,
		capturePolicy: "full-debug",
	} satisfies Config;
}

function writeSummary(config: Config, sessionFile: string, content: string) {
	const errors: RuntimeError[] = [];
	const unsubscribe = subscribeRuntimeErrors((error) => errors.push(error));
	try {
		appendRawTrace(config, sessionFile, {
			type: "provider_request",
			captureMode: "summary",
			messagesSummary: [{ role: "user", content }],
			messagesSummaryOmitted: 0,
			timestamp: new Date().toISOString(),
		});
		drainRawTraceQueue();
		return errors;
	} finally {
		unsubscribe();
	}
}

describe("raw trace summary shaping", () => {
	it("settles after many passes when a configured secret matches its own marker", () => {
		const rawTraceDir = mkdtempSync(join(tmpdir(), "pi-langfuse-settling-"));
		const config = rawTraceConfig(rawTraceDir, [SELF_MATCHING_SECRET]);
		const sessionFile = "/tmp/pi-agent/sessions/--settles--/session.jsonl";

		// Longer than one preview once shaped, so shaping is followed by cuts.
		const errors = writeSummary(
			config,
			sessionFile,
			`${SELF_MATCHING_SECRET} `.repeat(12),
		);

		expect(errors).toEqual([]);
		const rawPath = rawTracePathForSession(sessionFile, rawTraceDir);
		if (rawPath === undefined) throw new Error("Expected a raw trace path");
		const record = JSON.parse(readFileSync(rawPath, "utf8"));
		const [message] = record.messagesSummary;
		// Each pass nested the previous marker once more, so the preview holds
		// many nested openings and no longer contains the whole secret.
		expect(message.content.match(/\[REDACTED:/g)?.length).toBeGreaterThan(10);
		expect(Array.from(message.content).length).toBeLessThanOrEqual(200);
		expect(message.content).not.toContain(SELF_MATCHING_SECRET);
	});

	it("reports an error and writes nothing when marker expansion exceeds the pass limit", () => {
		const rawTraceDir = mkdtempSync(join(tmpdir(), "pi-langfuse-unsettled-"));
		const config = rawTraceConfig(rawTraceDir, [MARKER_PREFIX_SECRET]);
		const sessionFile = "/tmp/pi-agent/sessions/--unsettled--/session.jsonl";
		const errors = writeSummary(
			config,
			sessionFile,
			`${MARKER_PREFIX_SECRET} `.repeat(40),
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain(
			"raw provider summary did not settle within 32 shaping passes",
		);
		const rawPath = rawTracePathForSession(sessionFile, rawTraceDir);
		if (rawPath === undefined) throw new Error("Expected a raw trace path");
		expect(existsSync(rawPath)).toBe(false);
	});
});
