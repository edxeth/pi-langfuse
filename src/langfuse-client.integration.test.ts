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
	getLastRuntimeError,
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
 * observations query. Spans posted to the OTLP route become queryable, so a
 * healthy export satisfies the read the way a real server would.
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
	it.each([512, 3000])(
		"awaits exports already started before forceFlush and delivers all %i ended spans",
		async (spanCount) => {
			const restore = setRuntimeTimeoutsForTest({ shutdownStepMs: 10_000 });
			const waiting: Array<() => void> = [];
			let started: (() => void) | undefined;
			const firstRequest = new Promise<void>((resolve) => {
				started = resolve;
			});
			let hold = true;
			let received = 0;
			const server = createServer((request, response) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					received += exportedSpans([Buffer.concat(chunks).toString()]).length;
					const accept = () => {
						response.setHeader("content-type", "application/json");
						response.end("{}");
					};
					if (hold) waiting.push(accept);
					else accept();
					started?.();
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const runtime = await getRuntime({
					...baseConfig,
					host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				});
				const trace = runtime.trace({ name: "flush-in-flight" });
				for (let n = 0; n < spanCount; n++)
					runtime.span({ name: "tool:burst", traceId: trace.id }).end();
				await firstRequest;
				let finished = false;
				const flush = flushClient().then(() => {
					finished = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 40));
				const finishedBeforeAcceptance = finished;
				hold = false;
				for (const accept of waiting.splice(0)) accept();
				await flush;
				expect(finishedBeforeAcceptance).toBe(false);
				expect(received).toBe(spanCount);
			} finally {
				hold = false;
				for (const accept of waiting.splice(0)) accept();
				await shutdownClient();
				restore();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
		30_000,
	);

	it("does not expose response bodies from rejected score writes", async () => {
		const server = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ message: "private-score-payload-marker" }),
				);
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const runtime = await getRuntime({
				...baseConfig,
				host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			});
			runtime.score({ name: "synthetic", value: 1, traceId: "a".repeat(32) });
			await flushClient();
			expect(getLastRuntimeError()?.message).toContain("400");
			expect(getLastRuntimeError()?.message).not.toContain(
				"private-score-payload-marker",
			);
		} finally {
			await shutdownClient();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	afterEach(async () => {
		await shutdownClient();
	});

	/**
	 * Server that accepts the OTLP export route and rejects every other
	 * request, like a server whose read APIs are unavailable. Records every
	 * request so tests can assert that delivery is one-way.
	 */
	function createAcceptOnlyOtelServer() {
		const requests: Array<{ method: string; url: string }> = [];
		const receivedSpans: ExportedOtlpSpan[] = [];
		const server = createServer((request, response) => {
			requests.push({ method: request.method || "", url: request.url || "" });
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				if (
					request.method === "POST" &&
					request.url?.includes("/api/public/otel/v1/traces")
				) {
					receivedSpans.push(
						...exportedSpans([Buffer.concat(chunks).toString("utf8")]),
					);
					response.statusCode = 200;
					response.setHeader("content-type", "application/json");
					response.end("{}");
					return;
				}
				response.statusCode = 404;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ message: "not found" }));
			});
		});
		return { server, requests, receivedSpans };
	}

	it("delivers an accepted prompt with one-way export and no diagnostics", async () => {
		const previousError = getLastRuntimeError();
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 500 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { server, requests, receivedSpans } = createAcceptOnlyOtelServer();
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
				input: "one-way prompt",
				sessionId: "one-way-session",
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
				model: "one-way-model",
			});
			generation.end({ output: "one-way answer" });
			turn.end({ output: "one-way answer" });
			prompt.end({ output: "one-way answer" });
			await flushClient();
			await shutdownClient();

			// The accepted POST carried the full hierarchy with original ids.
			expect(receivedSpans.length).toBeGreaterThan(0);
			for (const span of receivedSpans) {
				expect(span.traceId).toBe(trace.id);
			}
			const byName = new Map(receivedSpans.map((span) => [span.name, span]));
			expect(byName.get("agent.turn")?.parentSpanId).toBe(
				byName.get("agent.prompt")?.spanId,
			);
			expect(byName.get("llm-response")?.parentSpanId).toBe(
				byName.get("agent.turn")?.spanId,
			);
			expect(byName.get("agent.prompt")?.parentSpanId).toBeUndefined();

			// Delivery is one-way: only accepted OTLP POSTs, no reads, no
			// replay re-POST of an already delivered span.
			expect(requests.length).toBeGreaterThan(0);
			for (const request of requests) {
				expect(request.method).toBe("POST");
				expect(request.url).toContain("/api/public/otel/v1/traces");
			}
			const postedSpanIds = receivedSpans.map((span) => span.spanId);
			expect(new Set(postedSpanIds).size).toBe(postedSpanIds.length);

			// A successful prompt must stay silent.
			expect(warn.mock.calls).toEqual([]);
			expect(getLastRuntimeError()).toBe(previousError);
		} finally {
			warn.mockRestore();
			restoreTimeouts();
			await new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("surfaces export failure through the runtime error boundary without raw console output", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 500 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const server = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				response.statusCode = 500;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ message: "export rejected" }));
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
			const trace = runtime.trace({ name: "pi-agent" });
			const prompt = runtime.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "done" });
			await flushClient();

			// The exporter reports through onError, which lands in the runtime
			// error boundary; the runtime itself adds no duplicate report and
			// never writes to the console.
			expect(getLastRuntimeError()).toBeDefined();
			expect(warn.mock.calls).toEqual([]);
		} finally {
			warn.mockRestore();
			restoreTimeouts();
			await new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
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
			expect(requests.some(({ url }) => url.includes("otel"))).toBe(true);
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
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 200 });
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
			restoreTimeouts();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("exports the full hierarchy with observation facts over the OTLP ingestion endpoint", async () => {
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
				response.end("{}");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 500 });

		type ReplayAttribute = {
			key: string;
			value?: { stringValue?: string; boolValue?: boolean };
		};
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
			tool.end({
				isError: true,
				statusMessage: "tool failed",
				usageDetails: { input: 2, output: 1, total: 3 },
				costDetails: { total: 0.02 },
			});
			turn.end({ output: "final answer" });
			prompt.end({ output: "final answer" });
			await flushClient();
			await shutdownClient();

			// Delivery is one-way over the OTLP ingestion endpoint: no
			// observation reads, no replay posts.
			const otelRequests = requests.filter(({ url }) =>
				url.includes("/api/public/otel/v1/traces"),
			);
			if (otelRequests.length === 0) {
				throw new Error("OTLP export was not received");
			}
			expect(
				requests.filter(({ url }) => url.includes("observations")),
			).toEqual([]);
			const postedSpanIds = parseReplaySpans(
				otelRequests.map(({ body }) => body),
			).map((span) => span.spanId);
			expect(new Set(postedSpanIds).size).toBe(postedSpanIds.length);
			const spans = parseReplaySpans(otelRequests.map(({ body }) => body));
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
			expect(
				attributeOf(generationSpan, "langfuse.observation.model.name"),
			).toBe("fallback-model");
			expect(
				attributeOf(generationSpan, "langfuse.observation.usage_details"),
			).toBe(JSON.stringify({ input: 4, output: 6, total: 10 }));
			const toolSpan = spans.find((span) => span.name === "tool:bash");
			if (!toolSpan) throw new Error("replay is missing the tool span");
			expect(attributeOf(toolSpan, "langfuse.observation.level")).toBe("ERROR");
			expect(attributeOf(toolSpan, "langfuse.observation.status_message")).toBe(
				"tool failed",
			);
			// SPAN-type observations keep usage and cost on the export.
			expect(attributeOf(toolSpan, "langfuse.observation.usage_details")).toBe(
				JSON.stringify({ input: 2, output: 1, total: 3 }),
			);
			expect(attributeOf(toolSpan, "langfuse.observation.cost_details")).toBe(
				JSON.stringify({ total: 0.02 }),
			);
			expect(JSON.stringify(spans)).not.toContain("sk-local-test");
		} finally {
			restoreTimeouts();
			await shutdownClient();
			await new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("stamps trace identity on child spans before the prompt root exports", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 200 });
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
			restoreTimeouts();
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
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 500 });

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

	it("publishes traces flagged public over the normal OTel export", async () => {
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
			const trace = runtime.trace({ name: "published-trace", public: true });
			const prompt = runtime.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "published answer" });
			await flushClient();

			const otelBodies = requests
				.filter(({ url }) => url.includes("otel"))
				.map(({ body }) => body);
			if (otelBodies.length === 0) throw new Error("no OTel export received");
			const spans = exportedSpans(otelBodies);
			const root = spans.find((span) => span.name === "agent.prompt");
			if (!root) throw new Error("prompt root was not exported");
			const attributes = otelBodies
				.map(
					(body) =>
						JSON.parse(body) as {
							resourceSpans?: Array<{
								scopeSpans?: Array<{
									spans?: Array<{
										spanId?: string;
										attributes?: Array<{
											key?: string;
											value?: { boolValue?: boolean };
										}>;
									}>;
								}>;
							}>;
						},
				)
				.flatMap((payload) =>
					(payload.resourceSpans ?? []).flatMap((resource) =>
						(resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
					),
				);
			const exportedRoot = attributes.find(
				(span) => span.spanId === root.spanId,
			);
			if (!exportedRoot) throw new Error("root span payload not found");
			expect(
				exportedRoot.attributes?.some(
					(attribute) =>
						attribute.key === "langfuse.trace.public" &&
						attribute.value?.boolValue === true,
				),
			).toBe(true);
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
