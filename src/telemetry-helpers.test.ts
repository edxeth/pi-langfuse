import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
	summarizeMessages,
	summarizeProviderRequestMessages,
} from "./telemetry-helpers.js";

const config: Config = {
	enabled: true,
	publicKey: "pk-lf-test",
	secretKey: "sk-lf-test",
	host: "http://localhost:3100",
	userId: "tester",
	defaultTags: [],
	release: "",
	environment: "",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: true,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: [],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

describe("telemetry capture fidelity", () => {
	// Word-based filler keeps the redactor out of the way: long unbroken
	// character runs are treated as blobs and replaced.
	const filler = (label: string, chars: number) => {
		const unit = `${label} context line value `;
		return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
	};

	// Guards training/distillation fidelity: every recent message must survive at
	// full per-message capture. A total-context budget would silently drop the
	// (context, response) pairs that make traces useful for distillation.
	it("keeps every recent message even when the total exceeds traceInputMaxChars", () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: filler(`message-${index}`, 500),
		}));

		const summary = summarizeMessages(config, messages);
		const contentChars = summary.reduce(
			(total, message) => total + message.content.length,
			0,
		);

		expect(contentChars).toBeGreaterThan(config.traceInputMaxChars);
		// Full deep equality: a dropped message replaced by a truncation marker
		// keeps the length and the newest entry intact, so weaker assertions pass.
		expect(summary).toEqual(messages);
	});

	it("keeps provider request summaries at full per-message capture", () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			role: "user",
			content: filler(`provider-${index}`, 500),
		}));

		const summary = summarizeProviderRequestMessages(config, messages);
		if (!summary) throw new Error("provider summary was not created");
		const contentChars = summary.reduce(
			(total, message) => total + message.content.length,
			0,
		);

		expect(contentChars).toBeGreaterThan(config.traceInputMaxChars);
		expect(summary).toEqual(messages);
	});

	it("bounds one oversized message by traceInputMaxChars", () => {
		const summary = summarizeMessages(config, [
			{ role: "user", content: filler("oversized", 5_000) },
		]);

		expect(summary).toHaveLength(1);
		expect(summary[0]?.content).toHaveLength(config.traceInputMaxChars + 1);
	});

	it("marks only the messages dropped by the recent-message window", () => {
		const messages = Array.from({ length: 45 }, (_, index) => ({
			role: "user",
			content: `windowed-${index}`,
		}));

		const summary = summarizeMessages(config, messages);

		expect(summary[0]?.content).toBe("[truncated 5 earlier message(s)]");
		expect(summary).toHaveLength(41);
		expect(summary.at(-1)?.content).toBe("windowed-44");
	});
});
