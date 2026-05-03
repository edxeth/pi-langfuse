import { afterEach, describe, expect, it, vi } from "vitest";
import { getClient, shutdownClient } from "./langfuse-client.js";

const mocks = vi.hoisted(() => {
	const trace = { id: "trace-1", update: vi.fn() };
	const span = { id: "span-1", update: vi.fn(), end: vi.fn() };
	const generation = { id: "gen-1", update: vi.fn(), end: vi.fn() };
	const client = {
		trace: vi.fn(() => trace),
		span: vi.fn(() => span),
		generation: vi.fn(() => generation),
		score: vi.fn(),
		shutdownAsync: vi.fn(async () => undefined),
	};
	return { client, trace, span, generation };
});

vi.mock("langfuse", () => ({
	Langfuse: vi.fn(() => mocks.client),
}));

const config = {
	enabled: true,
	publicKey: "pk-lf-test",
	secretKey: "sk-lf-test-secret-1234567890",
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
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

describe("langfuse client redaction wrapper", () => {
	afterEach(async () => {
		vi.clearAllMocks();
		await shutdownClient();
	});

	it("sanitizes trace, span, generation, and update/end payloads before SDK calls", async () => {
		const lf = await getClient(config);
		const trace = lf.trace({
			name: "pi-agent",
			input: "secret sk-lf-test-secret-1234567890",
		});
		trace.update({
			output: "LANGFUSE_SECRET_KEY=sk-lf-test-secret-1234567890",
		});
		const span = lf.span({
			name: "tool:bash",
			traceId: trace.id,
			input: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		});
		span.end({ output: "Bearer abcdefghijklmnopqrstuvwxyz123456" });
		const generation = lf.generation({
			name: "llm-response",
			traceId: trace.id,
			input: [{ role: "user", content: "sk-lf-test-secret-1234567890" }],
		});
		generation.end({ output: "hf_abcdefghijklmnopqrstuvwxyz" });

		const serialized = JSON.stringify([
			mocks.client.trace.mock.calls,
			mocks.trace.update.mock.calls,
			mocks.client.span.mock.calls,
			mocks.span.end.mock.calls,
			mocks.client.generation.mock.calls,
			mocks.generation.end.mock.calls,
		]);

		expect(serialized).not.toContain("sk-lf-test-secret-1234567890");
		expect(serialized).not.toContain(
			"ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		);
		expect(serialized).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz123456");
		expect(serialized).not.toContain("hf_abcdefghijklmnopqrstuvwxyz");
		expect(serialized).toContain("[REDACTED:langfuse-secret-key:");
		expect(serialized).toContain("[REDACTED:github-token:");
		expect(serialized).toContain("[REDACTED:bearer-token:");
		expect(serialized).toContain("[REDACTED:huggingface-token:");
	});
});
