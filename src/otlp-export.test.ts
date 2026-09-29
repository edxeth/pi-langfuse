import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { createOtlpExporter } from "./otlp-export.js";

interface RecordedRequest {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

type FixtureResponder = (
	request: RecordedRequest,
	response: http.ServerResponse,
) => void;

interface Fixture {
	host: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

async function startFixture(responder: FixtureResponder): Promise<Fixture> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const recorded: RecordedRequest = {
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks),
			};
			requests.push(recorded);
			responder(recorded, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		host: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Standard accepted export response; tests override per case. */
function acceptAll(_request: RecordedRequest, res: http.ServerResponse): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end("{}");
}

function basicAuth(publicKey: string, secretKey: string): string {
	return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

/** Builds real SDK spans through a live tracer pipeline (real ids and timings). */
function createRealSpans(
	count: number,
	attributes?: Record<string, string | number>,
): ReadableSpan[] {
	const captured: ReadableSpan[] = [];
	const provider = new BasicTracerProvider({
		spanProcessors: [
			{
				onStart() {},
				onEnd(span) {
					captured.push(span);
				},
				shutdown: () => Promise.resolve(),
				forceFlush: () => Promise.resolve(),
			},
		],
	});
	const tracer = provider.getTracer("otlp-export.test");
	for (let index = 0; index < count; index += 1) {
		const span = tracer.startSpan(`test-span-${index}`, { attributes });
		span.setAttribute("test.index", index);
		span.end();
	}
	return captured;
}

function spanIds(body: Buffer): Array<{ traceId: string; spanId: string }> {
	const parsed = JSON.parse(body.toString("utf8")) as {
		resourceSpans: Array<{
			scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }>;
		}>;
	};
	return parsed.resourceSpans.flatMap((resource) =>
		resource.scopeSpans.flatMap((scope) => scope.spans),
	);
}

function exportAndWait(
	exporter: SpanExporter,
	spans: ReadableSpan[],
): Promise<ExportResult> {
	return new Promise((resolve) => {
		exporter.export(spans, resolve);
	});
}

const openExporters: SpanExporter[] = [];
const openFixtures: Fixture[] = [];

afterEach(async () => {
	await Promise.allSettled(
		openExporters.map((exporter) => exporter.shutdown()),
	);
	openExporters.length = 0;
	await Promise.allSettled(openFixtures.map((fixture) => fixture.close()));
	openFixtures.length = 0;
});

interface TestRig {
	fixture: Fixture;
	createExporter(timeoutMs?: number): SpanExporter;
	errors: string[];
}

/**
 * Starts a fixture plus the error sink and registers both for teardown.
 * Tests set their own per-case responder through `fixture` afterwards.
 */
async function startRig(
	responder: FixtureResponder = acceptAll,
): Promise<TestRig> {
	const fixture = await startFixture(responder);
	openFixtures.push(fixture);
	const errors: string[] = [];
	const rig: TestRig = {
		fixture,
		errors,
		createExporter(timeoutMs = 5_000) {
			const exporter = createOtlpExporter({
				host: fixture.host,
				publicKey: "pk-test",
				secretKey: "sk-test",
				timeoutMs,
				onError: (message) => errors.push(message),
			});
			openExporters.push(exporter);
			return exporter;
		},
	};
	return rig;
}

describe("installed OTLPTraceExporter baseline", () => {
	// Characterization of the installed @opentelemetry exporter this module
	// replaces: a 200 response that rejects spans via partialSuccess is
	// reported as SUCCESS, and a malformed 200 body is also swallowed into
	// SUCCESS (the delegate comments "No matter the response, we can consider
	// the export still successful"). If this test goes red after an SDK
	// upgrade, upstream fixed the flaw and createOtlpExporter can be retired.
	it("reports SUCCESS when the server rejects spans via partialSuccess (documented flaw)", async () => {
		const fixture = await startFixture((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					partialSuccess: { rejectedSpans: 2, errorMessage: "quota exceeded" },
				}),
			);
		});
		openFixtures.push(fixture);
		const exporter = new OTLPTraceExporter({
			url: `${fixture.host}/api/public/otel/v1/traces`,
			headers: { Authorization: basicAuth("pk-test", "sk-test") },
		});
		openExporters.push(exporter);
		const result = await exportAndWait(exporter, createRealSpans(2));
		expect(fixture.requests).toHaveLength(1);
		expect(result.code).toBe(ExportResultCode.SUCCESS);
	});

	it("reports SUCCESS for a malformed 200 response body (documented flaw)", async () => {
		const fixture = await startFixture((_request, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("this is not json");
		});
		openFixtures.push(fixture);
		const exporter = new OTLPTraceExporter({
			url: `${fixture.host}/api/public/otel/v1/traces`,
			headers: { Authorization: basicAuth("pk-test", "sk-test") },
		});
		openExporters.push(exporter);
		const result = await exportAndWait(exporter, createRealSpans(2));
		expect(result.code).toBe(ExportResultCode.SUCCESS);
	});
});

describe("createOtlpExporter", () => {
	it("does not echo server-supplied payloads or credentials in partial-rejection diagnostics", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					partialSuccess: {
						rejectedSpans: 1,
						errorMessage: "rejected private-prompt-content with sk-test",
					},
				}),
			);
		});
		const result = await exportAndWait(
			rig.createExporter(),
			createRealSpans(1),
		);
		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.errors.join()).toContain("rejected 1 span(s)");
		expect(rig.errors.join()).not.toContain("private-prompt-content");
		expect(rig.errors.join()).not.toContain("sk-test");
	});
	it("POSTs real spans to the Langfuse OTLP endpoint with Basic auth and reports SUCCESS", async () => {
		const rig = await startRig();
		const spans = createRealSpans(2, { "test.key": "value" });
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, spans);

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.errors).toEqual([]);
		expect(rig.fixture.requests).toHaveLength(1);
		const request = rig.fixture.requests[0];
		expect(request.method).toBe("POST");
		expect(request.url).toBe("/api/public/otel/v1/traces");
		expect(request.headers.authorization).toBe(basicAuth("pk-test", "sk-test"));
		expect(request.headers["content-type"]).toBe("application/json");
		const sent = spanIds(request.body);
		expect(sent).toHaveLength(2);
		expect(sent.map((span) => span.spanId)).toEqual(
			spans.map((span) => span.spanContext().spanId),
		);
		expect(sent.map((span) => span.traceId)).toEqual(
			spans.map((span) => span.spanContext().traceId),
		);
	});

	it("accepts an empty 200 response body", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end();
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(1));

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.errors).toEqual([]);
	});

	it("fails the export without retrying when a 200 response rejects spans via partialSuccess", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					partialSuccess: { rejectedSpans: 2, errorMessage: "quota exceeded" },
				}),
			);
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(2));

		expect(result.code).toBe(ExportResultCode.FAILED);
		// A partial rejection must never be retried: the accepted spans are
		// already persisted and a resend would duplicate them.
		expect(rig.fixture.requests).toHaveLength(1);
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toContain("rejected 2 span(s)");
		expect(rig.errors[0]).not.toContain("quota exceeded");
	});

	it("reads rejectedSpans reported as an int64 string", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					partialSuccess: { rejectedSpans: "3", errorMessage: "over limit" },
				}),
			);
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(3));

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(1);
		expect(rig.errors[0]).toContain("rejected 3 span(s)");
	});

	it("accepts zero rejected spans with a warning message as full success", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					partialSuccess: {
						rejectedSpans: 0,
						errorMessage: "all spans accepted",
					},
				}),
			);
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(2));

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		// No loss occurred, so no error may be reported either.
		expect(rig.errors).toEqual([]);
	});

	it("fails a 200 response whose body is malformed instead of claiming success", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("this is not json");
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(1));

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(1);
		expect(rig.errors[0]).toMatch(/malformed 200 response/);
	});

	it("fails a 200 response whose body is not a JSON object", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("[1,2,3]");
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(1));

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.errors[0]).toMatch(/malformed 200 response/);
	});

	it("recovers from a transient 503 and delivers on the retry", async () => {
		let responses = 0;
		const rig = await startRig((_request, res) => {
			responses += 1;
			if (responses === 1) {
				res.writeHead(503, { "retry-after": "0" });
				res.end("try again");
				return;
			}
			acceptAll(_request, res);
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(1));

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.fixture.requests).toHaveLength(2);
		expect(rig.errors).toEqual([]);
	});

	it("rejects permanently on an HTTP 401 with a sanitized summary and no retry", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: "invalid credentials pk-test leaked-response-body",
				}),
			);
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, createRealSpans(1));

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(1);
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toContain("HTTP 401");
		// The summary must not leak response bodies or credentials.
		expect(rig.errors[0]).not.toContain("leaked-response-body");
		expect(rig.errors[0]).not.toContain("sk-test");
	});

	it("does not busy-wait when Retry-After exceeds the remaining deadline", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(429, { "retry-after": "30" });
			res.end("slow down");
		});
		const exporter = rig.createExporter(400);

		const startedAt = Date.now();
		const result = await exportAndWait(exporter, createRealSpans(1));
		const elapsed = Date.now() - startedAt;

		expect(result.code).toBe(ExportResultCode.FAILED);
		// One attempt, then give up because the advised wait exceeds the budget.
		expect(rig.fixture.requests).toHaveLength(1);
		expect(elapsed).toBeLessThan(5_000);
		expect(rig.errors[0]).toContain("HTTP 429");
		expect(rig.errors[0]).toMatch(/Retry-After|deadline/);
	});

	it("times out against a hanging server within the total deadline", async () => {
		const rig = await startRig(() => {
			// Never respond: the export must abort itself.
		});
		const exporter = rig.createExporter(250);

		const startedAt = Date.now();
		const result = await exportAndWait(exporter, createRealSpans(1));
		const elapsed = Date.now() - startedAt;

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(elapsed).toBeGreaterThanOrEqual(200);
		expect(elapsed).toBeLessThan(5_000);
		expect(rig.errors[0]).toMatch(/timed out/);
	});

	it("fails with a sanitized network summary when the endpoint refuses connections", async () => {
		const rig = await startRig();
		const deadPort = rig.fixture.host;
		await rig.fixture.close();
		openFixtures.splice(openFixtures.indexOf(rig.fixture), 1);
		const errors: string[] = [];
		const exporter = createOtlpExporter({
			host: deadPort,
			publicKey: "pk-test",
			secretKey: "sk-test",
			timeoutMs: 5_000,
			onError: (message) => errors.push(message),
		});
		openExporters.push(exporter);

		const result = await exportAndWait(exporter, createRealSpans(1));

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/network error/);
		expect(errors[0]).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
	}, 15_000);

	it("ignores OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS", async () => {
		const rig = await startRig();
		const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		const previousHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9/never";
		process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-injected-leak=1";
		try {
			const exporter = rig.createExporter();
			const result = await exportAndWait(exporter, createRealSpans(1));

			expect(result).toEqual({ code: ExportResultCode.SUCCESS });
			const request = rig.fixture.requests[0];
			expect(request.url).toBe("/api/public/otel/v1/traces");
			expect(request.headers["x-injected-leak"]).toBeUndefined();
		} finally {
			if (previousEndpoint === undefined)
				delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
			else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
			if (previousHeaders === undefined)
				delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
			else process.env.OTEL_EXPORTER_OTLP_HEADERS = previousHeaders;
		}
	});

	it("delivers a batch larger than the request cap as multiple bounded requests", async () => {
		const rig = await startRig();
		const big = "x".repeat(1_500_000);
		const spans = createRealSpans(4, { "test.big": big });
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, spans);

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.fixture.requests.length).toBeGreaterThanOrEqual(2);
		const sentIds: string[] = [];
		for (const request of rig.fixture.requests) {
			expect(request.body.byteLength).toBeLessThanOrEqual(3_500_000);
			sentIds.push(...spanIds(request.body).map((span) => span.spanId));
		}
		expect(sentIds.sort()).toEqual(
			spans.map((span) => span.spanContext().spanId).sort(),
		);
		expect(rig.errors).toEqual([]);
	});

	it("reports an individually oversized span and still delivers the rest", async () => {
		const rig = await startRig();
		const normal = createRealSpans(1);
		const oversizedSpans = createRealSpans(1, {
			"test.huge": "x".repeat(3_600_000),
		});
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, [
			normal[0],
			oversizedSpans[0],
		]);

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toContain(oversizedSpans[0].spanContext().spanId);
		expect(rig.errors[0]).toMatch(/exceeds/);
		// The deliverable span went out; the oversized one was never sent.
		expect(rig.fixture.requests).toHaveLength(1);
		expect(
			spanIds(rig.fixture.requests[0].body).map((span) => span.spanId),
		).toEqual([normal[0].spanContext().spanId]);
	});

	it("shutdown awaits in-flight exports and rejects later exports", async () => {
		let responses = 0;
		const rig = await startRig((_request, res) => {
			responses += 1;
			setTimeout(() => acceptAll(_request, res), 200);
		});
		const exporter = rig.createExporter();
		const spans = createRealSpans(1);

		let finalResult: ExportResult | undefined;
		exporter.export(spans, (result) => {
			finalResult = result;
		});
		// shutdown must wait for the in-flight send to settle.
		await exporter.shutdown();
		expect(finalResult).toEqual({ code: ExportResultCode.SUCCESS });
		expect(responses).toBe(1);
		expect(rig.errors).toEqual([]);

		const afterShutdown = await exportAndWait(exporter, spans);
		expect(afterShutdown.code).toBe(ExportResultCode.FAILED);
		expect(responses).toBe(1);
	});

	it("forceFlush awaits in-flight exports", async () => {
		const rig = await startRig((_request, res) => {
			setTimeout(() => acceptAll(_request, res), 150);
		});
		const exporter = rig.createExporter();

		let finalResult: ExportResult | undefined;
		exporter.export(createRealSpans(1), (result) => {
			finalResult = result;
		});
		await exporter.forceFlush?.();

		expect(finalResult).toEqual({ code: ExportResultCode.SUCCESS });
	});
});
