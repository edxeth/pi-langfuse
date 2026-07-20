import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trace as otelTrace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { flushClient, getRuntime, shutdownClient } from "./langfuse-client.js";

const baseConfig: Omit<Config, "host"> = {
	enabled: true,
	publicKey: "pk-local-test",
	secretKey: "sk-local-test",
	userId: "local-test-user",
	defaultTags: ["local-test"],
	release: "local-release",
	environment: "test",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: false,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: [],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://127.0.0.1/api/public/health",
	localAutostartTimeoutMs: 200,
};

describe("langfuse v5 local runtime", () => {
	afterEach(async () => {
		await shutdownClient();
	});

	it("propagates real OTel context and exports to an ephemeral local endpoint", async () => {
		const requests: string[] = [];
		const payloads: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url || "");
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				payloads.push(Buffer.concat(chunks).toString("utf8"));
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end("{}");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});

		try {
			const address = server.address() as AddressInfo;
			const runtime = await getRuntime({
				...baseConfig,
				host: `http://127.0.0.1:${address.port}`,
			});
			const trace = runtime.trace({
				name: "pi-agent",
				id: "a".repeat(32),
				input: "local prompt",
				sessionId: "local-session",
			});
			trace.update({ metadata: { first: "one" } });
			trace.update({ metadata: { second: "two" } });
			const prompt = runtime.span({
				name: "agent.prompt",
				traceId: trace.id,
			});
			const activeTraceId = await runtime.withContext(prompt, async () => {
				await new Promise<void>((resolve) => setImmediate(resolve));
				return otelTrace.getActiveSpan()?.spanContext().traceId;
			});
			const turn = runtime.span({
				name: "agent.turn",
				traceId: trace.id,
				parentObservationId: prompt.id,
			});
			const generation = runtime.generation({
				name: "llm-response",
				traceId: trace.id,
				parentObservationId: turn.id,
				model: "local-model",
			});
			generation.end({
				output: "local answer",
				usageDetails: { input: 2, output: 3, total: 5 },
			});
			turn.end({ output: "local answer" });
			prompt.end({ output: "local answer" });
			await flushClient();

			expect(trace.id).toBe("a".repeat(32));
			expect(activeTraceId).toBe(trace.id);
			expect(requests.length).toBeGreaterThan(0);
			expect(requests.some((url) => url.includes("otel"))).toBe(true);
			expect(payloads.join("\n")).toContain("local answer");
			expect(payloads.join("\n")).toContain("agent.prompt");
			expect(payloads.join("\n")).toContain("first");
			expect(payloads.join("\n")).toContain("second");
		} finally {
			await shutdownClient();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
