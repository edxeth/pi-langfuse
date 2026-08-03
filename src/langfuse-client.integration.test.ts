import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trace as otelTrace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
	flushClient,
	getRuntime,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "./langfuse-client.js";

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

	it("prevents non-media data prefixes from corrupting later media", async () => {
		const requests: string[] = [];
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const server = createServer((request, response) => {
			requests.push(request.url || "");
			request.resume();
			request.on("end", () => {
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
				name: "embedded-data-prefixes",
				input: "ordinary prompt",
			});
			const generation = runtime.generation({
				name: "llm-response",
				traceId: trace.id,
			});
			generation.end({
				output: [
					'SSE example: data: {"id":"chunk-1","delta":"hello"}',
					"Terminator example: data: [DONE]",
					"Image documentation: data:image/png;base64,AAAA",
				].join("\n"),
			});
			await flushClient();

			expect(requests.some((url) => url.includes("/api/public/media"))).toBe(
				true,
			);
			expect(
				consoleError.mock.calls.some((call) =>
					call.some((value) =>
						String(value).includes("Error parsing base64 data URI"),
					),
				),
			).toBe(false);
		} finally {
			await shutdownClient();
			consoleError.mockRestore();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("ingests an invisible completed trace through the REST fallback", async () => {
		const requests: Array<{ url: string; body: string }> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				requests.push({ url: request.url || "", body });
				if (request.url?.includes("/api/public/traces/")) {
					response.statusCode = 404;
					response.end("not found");
					return;
				}
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ successes: [], errors: [] }));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 500,
			traceVisibilityMs: 25,
			pollIntervalMs: 1,
		});

		try {
			const address = server.address() as AddressInfo;
			const runtime = await getRuntime({
				...baseConfig,
				host: `http://127.0.0.1:${address.port}`,
			});
			const trace = runtime.trace({
				id: "b".repeat(32),
				name: "pi-agent",
				input: "sk-local-test",
				output: "final answer",
				sessionId: "rest-fallback-session",
			});
			trace.setTraceIO?.({
				input: "sk-local-test",
				output: "final answer",
			});
			const prompt = runtime.span({ name: "agent.prompt", traceId: trace.id });
			const turn = runtime.span({
				name: "agent.turn",
				traceId: trace.id,
				parentObservationId: prompt.id,
			});
			const generation = runtime.generation({
				name: "llm-response",
				traceId: trace.id,
				parentObservationId: turn.id,
				model: "fallback-model",
			});
			const tool = runtime.span({
				name: "tool:bash",
				traceId: trace.id,
				parentObservationId: turn.id,
			});
			generation.end({
				output: "generated answer",
				usageDetails: { input: 4, output: 6, total: 10 },
			});
			tool.end({ isError: true, statusMessage: "tool failed" });
			turn.end({ output: "final answer" });
			prompt.end({ output: "final answer" });

			await shutdownClient();

			const fallbackRequest = requests
				.map(({ body }) => {
					try {
						return JSON.parse(body) as {
							metadata?: Record<string, unknown>;
							batch?: Array<{
								type: string;
								body: Record<string, unknown>;
							}>;
						};
					} catch {
						return undefined;
					}
				})
				.find((payload) => payload?.metadata?.fallback === "rest-ingestion");
			if (!fallbackRequest?.batch) {
				throw new Error("REST fallback request was not received");
			}
			const traceEvent = fallbackRequest.batch.find(
				(event) => event.type === "trace-create",
			);
			const generationEvent = fallbackRequest.batch.find(
				(event) => event.type === "generation-create",
			);
			const toolEvent = fallbackRequest.batch.find(
				(event) => event.type === "span-create" && event.body.id === tool.id,
			);
			expect(fallbackRequest.metadata).toMatchObject({
				fallback: "rest-ingestion",
				reason: "otel-trace-not-visible-after-flush",
			});
			expect(fallbackRequest.batch).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "trace-create",
						body: expect.objectContaining({
							id: trace.id,
							output: "final answer",
							sessionId: "rest-fallback-session",
						}),
					}),
					expect.objectContaining({
						type: "span-create",
						body: expect.objectContaining({
							id: turn.id,
							parentObservationId: prompt.id,
						}),
					}),
				]),
			);
			if (!traceEvent || !generationEvent || !toolEvent) {
				throw new Error("REST fallback observations are incomplete");
			}
			expect(traceEvent.body).toMatchObject({
				name: "pi-agent",
				input: expect.stringContaining("[REDACTED:"),
			});
			expect(generationEvent.body).toMatchObject({
				id: generation.id,
				traceId: trace.id,
				parentObservationId: turn.id,
				model: "fallback-model",
				usageDetails: { input: 4, output: 6, total: 10 },
			});
			expect(toolEvent.body).toMatchObject({
				traceId: trace.id,
				parentObservationId: turn.id,
				level: "ERROR",
				statusMessage: "tool failed",
			});
			for (const event of fallbackRequest.batch) {
				if (event.type === "trace-create") continue;
				expect(event.body.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				expect(event.body.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			}
			expect(JSON.stringify(fallbackRequest)).not.toContain("sk-local-test");
		} finally {
			restoreTimeouts();
			await shutdownClient();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("stamps trace identity on child spans before the prompt root exports", async () => {
		const requests: Array<{ url: string; body: string }> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({
					url: request.url || "",
					body: Buffer.concat(chunks).toString("utf8"),
				});
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ successes: [], errors: [] }));
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
				id: "c".repeat(32),
				input: "open prompt",
				sessionId: "open-session",
				userId: "open-user",
			});
			const prompt = runtime.span({ name: "agent.prompt", traceId: trace.id });
			const turn = runtime.span({
				name: "agent.turn",
				traceId: trace.id,
				parentObservationId: prompt.id,
			});
			turn.end({ output: "turn output" });
			// The prompt root is intentionally left open (prompt still in flight).
			await flushClient();

			// Only the ended child (agent.turn) is exported while the root stays open,
			// so it must carry the trace name itself or the trace would be empty-name.
			const otelPayload = requests
				.filter(({ url }) => url.includes("otel"))
				.map(({ body }) => body)
				.join("\n");
			expect(otelPayload).toContain("agent.turn");
			expect(
				otelPayload,
				"child span must carry langfuse.trace.name before the root exports",
			).toContain("langfuse.trace.name");
			expect(otelPayload).toContain("pi-agent");
			expect(otelPayload).toContain(trace.id);
		} finally {
			await shutdownClient();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("exports an open prompt root on controlled shutdown", async () => {
		const requests: Array<{ url: string; body: string }> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({
					url: request.url || "",
					body: Buffer.concat(chunks).toString("utf8"),
				});
				if (request.url?.includes("/api/public/traces/")) {
					response.statusCode = 404;
					response.end("not found");
					return;
				}
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ successes: [], errors: [] }));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 500,
			traceVisibilityMs: 25,
			pollIntervalMs: 1,
		});

		try {
			const address = server.address() as AddressInfo;
			const runtime = await getRuntime({
				...baseConfig,
				host: `http://127.0.0.1:${address.port}`,
			});
			const trace = runtime.trace({
				name: "pi-agent",
				id: "d".repeat(32),
				sessionId: "shutdown-session",
			});
			const prompt = runtime.span({ name: "agent.prompt", traceId: trace.id });
			const turn = runtime.span({
				name: "agent.turn",
				traceId: trace.id,
				parentObservationId: prompt.id,
			});
			turn.end({ output: "turn output" });
			// Prompt root left open; simulate quitting mid-prompt.
			await shutdownClient();

			const otelPayloads = requests
				.filter(({ url }) => url.includes("otel"))
				.map(({ body }) => body)
				.join("\n");
			expect(
				otelPayloads,
				"open prompt root must be exported on shutdown",
			).toContain("agent.prompt");
		} finally {
			restoreTimeouts();
			await shutdownClient();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("rejects a child observation whose parent trace is not registered", async () => {
		const server = createServer((_request, response) => {
			response.statusCode = 200;
			response.setHeader("content-type", "application/json");
			response.end("{}");
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
			expect(() =>
				runtime.span({
					name: "agent.turn",
					traceId: "e".repeat(32),
					parentObservationId: "0123456789abcdef",
				}),
			).toThrow();
		} finally {
			await shutdownClient();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
