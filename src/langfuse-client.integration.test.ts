import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	context as otelContext,
	trace as otelTrace,
	TraceFlags,
} from "@opentelemetry/api";
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

type ExportedOtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
};

function exportedSpans(bodies: string[]): ExportedOtlpSpan[] {
	const spans: ExportedOtlpSpan[] = [];
	for (const body of bodies) {
		let payload: {
			resourceSpans?: Array<{
				scopeSpans?: Array<{ spans?: ExportedOtlpSpan[] }>;
			}>;
		};
		try {
			payload = JSON.parse(body);
		} catch {
			continue;
		}
		if (!payload?.resourceSpans) continue;
		for (const resource of payload.resourceSpans) {
			for (const scope of resource.scopeSpans ?? []) {
				spans.push(...(scope.spans ?? []));
			}
		}
	}
	return spans;
}

/**
 * Local fake of the supported server surface: OTLP ingestion plus the v2
 * observations query the fallback uses for completeness. Spans posted to the
 * OTLP route become queryable, so a healthy export satisfies the fallback
 * check the way a real server would.
 */
function createCollectingTraceServer() {
	const requests: Array<{ url: string; body: string }> = [];
	const receivedSpans: ExportedOtlpSpan[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ url: request.url || "", body });
			if (request.url?.includes("/api/public/otel/v1/traces")) {
				receivedSpans.push(...exportedSpans([body]));
			}
			if (request.url?.includes("/api/public/v2/observations")) {
				const traceId =
					new URL(request.url, "http://localhost").searchParams.get(
						"traceId",
					) || "";
				const data = receivedSpans
					.filter((span) => span.traceId === traceId)
					.map((span) => ({ id: span.spanId }));
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ data, meta: {} }));
				return;
			}
			response.statusCode = 200;
			response.setHeader("content-type", "application/json");
			response.end("{}");
		});
	});
	return { server, requests, receivedSpans };
}

describe("langfuse v5 local runtime", () => {
	afterEach(async () => {
		await shutdownClient();
	});

	it("propagates real OTel context and exports to an ephemeral local endpoint", async () => {
		const { server, requests } = createCollectingTraceServer();
		const payloads = () => requests.map(({ body }) => body);
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
			expect(
				requests.some(({ url }) => url.includes("otel")),
			).toBe(true);
			const exported = payloads().join("\n");
			expect(exported).toContain("local answer");
			expect(exported).toContain("agent.prompt");
			expect(exported).toContain("first");
			expect(exported).toContain("second");
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

		it("replays an unconfirmed trace over the OTLP ingestion endpoint", async () => {
		const requests: Array<{ url: string; body: string }> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({
					url: request.url || "",
					body: Buffer.concat(chunks).toString("utf8"),
				});
				// The server never reports observations, so the fallback cannot
				// confirm delivery and must replay over OTLP.
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end("{}");
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

		type ReplayAttribute = { key: string; value?: { stringValue?: string; boolValue?: boolean } };
		type ReplaySpan = {
			traceId: string;
			spanId: string;
			parentSpanId?: string;
			name: string;
			attributes?: ReplayAttribute[];
		};
		const parseReplaySpans = (bodies: string[]): ReplaySpan[] =>
			bodies.flatMap((body) => {
				try {
					const payload = JSON.parse(body) as {
						resourceSpans?: Array<{
							scopeSpans?: Array<{ spans?: ReplaySpan[] }>;
						}>;
					};
					return (
						payload.resourceSpans?.flatMap((resource) =>
							(resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
						) ?? []
					);
				} catch {
					return [];
				}
			});
		const attributeOf = (span: ReplaySpan, key: string) =>
			span.attributes?.find((attribute) => attribute.key === key)?.value
				?.stringValue;

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

			const replayBodies = requests
				.filter(({ url }) => url.includes("/api/public/otel/v1/traces"))
				.map(({ body }) => body);
			if (replayBodies.length === 0) {
				throw new Error("OTLP fallback replay was not received");
			}
			const spans = parseReplaySpans(replayBodies);
			expect(spans.map((span) => span.name)).toEqual(
				expect.arrayContaining([
					"agent.prompt",
					"agent.turn",
					"llm-response",
					"tool:bash",
				]),
			);
			for (const span of spans) {
				expect(span.traceId).toBe(trace.id);
			}
			const root = spans.find((span) => span.name === "agent.prompt");
			if (!root) throw new Error("replay is missing the prompt root");
			expect(root.parentSpanId).toBeUndefined();
			expect(
				spans.find((span) => span.name === "agent.turn")?.parentSpanId,
			).toBe(prompt.id);
			expect(attributeOf(root, "langfuse.trace.name")).toBe("pi-agent");
			expect(attributeOf(root, "session.id")).toBe("rest-fallback-session");
			expect(attributeOf(root, "langfuse.trace.input")).toContain("[REDACTED:");
			expect(attributeOf(root, "langfuse.trace.output")).toBe("final answer");
			const generationSpan = spans.find((span) => span.name === "llm-response");
			if (!generationSpan) throw new Error("replay is missing the generation");
			expect(attributeOf(generationSpan, "langfuse.observation.model.name")).toBe(
				"fallback-model",
			);
			expect(
				attributeOf(generationSpan, "langfuse.observation.usage_details"),
			).toBe(JSON.stringify({ input: 4, output: 6, total: 10 }));
			const toolSpan = spans.find((span) => span.name === "tool:bash");
			if (!toolSpan) throw new Error("replay is missing the tool span");
			expect(attributeOf(toolSpan, "langfuse.observation.level")).toBe("ERROR");
			expect(attributeOf(toolSpan, "langfuse.observation.status_message")).toBe(
				"tool failed",
			);
			// The replay must be visible to the same v2 observations endpoint the
			// fallback checks for completeness.
			expect(
				requests.some(({ url }) =>
					url.includes("/api/public/v2/observations"),
				),
			).toBe(true);
			expect(JSON.stringify(spans)).not.toContain("sk-local-test");
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
		const { server, requests } = createCollectingTraceServer();
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

	it("starts prompt roots independently of an active external OTel parent", async () => {
		const { server, requests } = createCollectingTraceServer();
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
			const sampledExternal = otelTrace.wrapSpanContext({
				traceId: "c".repeat(32),
				spanId: "1".repeat(16),
				traceFlags: TraceFlags.SAMPLED,
				isRemote: true,
			});
			const unsampledExternal = otelTrace.wrapSpanContext({
				traceId: "d".repeat(32),
				spanId: "2".repeat(16),
				traceFlags: TraceFlags.NONE,
				isRemote: true,
			});
			const sampledPrompt = await otelContext.with(
				otelTrace.setSpan(otelContext.active(), sampledExternal),
				async () => {
					const trace = runtime.trace({
						name: "pi-agent",
						id: "a".repeat(32),
					});
					const prompt = runtime.span({
						name: "agent.prompt",
						traceId: trace.id,
					});
					prompt.end({ output: "sampled-parent answer" });
					return trace;
				},
			);
			const unsampledPrompt = await otelContext.with(
				otelTrace.setSpan(otelContext.active(), unsampledExternal),
				async () => {
					const trace = runtime.trace({
						name: "pi-agent",
						id: "b".repeat(32),
					});
					const prompt = runtime.span({
						name: "agent.prompt",
						traceId: trace.id,
					});
					prompt.end({ output: "unsampled-parent answer" });
					return trace;
				},
			);
			await flushClient();

			// Each prompt keeps its requested identity instead of inheriting the
			// external trace, and the unsampled parent must not suppress export.
			expect(sampledPrompt.id).toBe("a".repeat(32));
			expect(unsampledPrompt.id).toBe("b".repeat(32));
			const otelPayload = requests
				.filter(({ url }) => url.includes("otel"))
				.map(({ body }) => body)
				.join("\n");
			expect(otelPayload).toContain("a".repeat(32));
			expect(otelPayload).toContain("b".repeat(32));
			expect(otelPayload).not.toContain("c".repeat(32));
			expect(otelPayload).not.toContain("d".repeat(32));
			const spans = exportedSpans(requests.map(({ body }) => body));
			const roots = spans.filter((span) => span.name === "agent.prompt");
			expect(roots).toHaveLength(2);
			for (const root of roots) {
				expect(root.parentSpanId).toBeUndefined();
				expect(root.traceId).not.toBe("c".repeat(32));
				expect(root.traceId).not.toBe("d".repeat(32));
			}
		} finally {
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
