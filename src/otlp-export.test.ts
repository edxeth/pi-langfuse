import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOtlpExporter,
	MAX_CONCURRENT_EXPORTS,
	type OtlpSpanExporter,
} from "./otlp-export.js";

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
	vi.restoreAllMocks();
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

/** Time for a request that should NOT arrive to show up if it were going to. */
const SETTLE_MS = 100;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean): Promise<void> {
	const giveUpAt = Date.now() + 3_000;
	while (!condition()) {
		if (Date.now() > giveUpAt) throw new Error("waitFor: condition not met");
		await sleep(5);
	}
}

interface Gate {
	responder: FixtureResponder;
	heldCount(): number;
	peakOpen(): number;
	/** Answers the requests held so far; later requests are still held. */
	answerHeld(): void;
	/** Answers held requests and every later request immediately. */
	stopHolding(): void;
}

/**
 * Server-side gate: holds every request open until the test answers it, and
 * records the peak number of requests open at once. `answer` decides the
 * response once a request is let go.
 */
function createGate(answer: FixtureResponder = acceptAll): Gate {
	let holding = true;
	let open = 0;
	let peak = 0;
	const held: Array<() => void> = [];
	const answerHeld = () => {
		for (const release of held.splice(0)) release();
	};
	return {
		responder(request, res) {
			open += 1;
			peak = Math.max(peak, open);
			res.on("close", () => {
				open -= 1;
			});
			if (holding) held.push(() => answer(request, res));
			else answer(request, res);
		},
		heldCount: () => held.length,
		peakOpen: () => peak,
		answerHeld,
		stopHolding() {
			holding = false;
			answerHeld();
		},
	};
}

function sentSpanIds(rig: TestRig): string[] {
	return rig.fixture.requests
		.flatMap((request) => spanIds(request.body).map((span) => span.spanId))
		.sort();
}

function expectedSpanIds(spans: ReadableSpan[]): string[] {
	return spans.map((span) => span.spanContext().spanId).sort();
}

describe("createOtlpExporter concurrency bound", () => {
	const BURST = MAX_CONCURRENT_EXPORTS + 21;

	/** One `export()` call per span, like the span processor's immediate mode. */
	function exportEach(
		exporter: SpanExporter,
		spans: ReadableSpan[],
	): Array<Promise<ExportResult>> {
		return spans.map((span) => exportAndWait(exporter, [span]));
	}

	/**
	 * Fills every slot with a held request, then issues `queued` more exports
	 * and proves none of them has reached the server yet.
	 */
	async function queueBehindFullSlots(
		rig: TestRig,
		gate: Gate,
		queued: number,
	) {
		const exporter = rig.createExporter();
		const spans = createRealSpans(MAX_CONCURRENT_EXPORTS + queued);
		const results = exportEach(exporter, spans);
		await waitFor(() => rig.fixture.requests.length >= MAX_CONCURRENT_EXPORTS);
		await sleep(SETTLE_MS);
		expect(rig.fixture.requests).toHaveLength(MAX_CONCURRENT_EXPORTS);
		expect(gate.heldCount()).toBe(MAX_CONCURRENT_EXPORTS);
		return { exporter, spans, results };
	}

	it("never has more than the limit of requests open and coalesces the overflow", async () => {
		const gate = createGate();
		const rig = await startRig(gate.responder);
		const spans = createRealSpans(BURST);
		const results = exportEach(rig.createExporter(), spans);

		await waitFor(() => rig.fixture.requests.length >= MAX_CONCURRENT_EXPORTS);
		await sleep(SETTLE_MS);
		expect(rig.fixture.requests).toHaveLength(MAX_CONCURRENT_EXPORTS);
		gate.stopHolding();
		const settled = await Promise.all(results);

		expect(gate.peakOpen()).toBeLessThanOrEqual(MAX_CONCURRENT_EXPORTS);
		expect(settled.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
		expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
		// The overflow left as a few coalesced requests, not one per span.
		expect(rig.fixture.requests.length).toBeLessThan(BURST / 2);
		expect(rig.errors).toEqual([]);
	});

	it("gives every coalesced callback the shared failure and reports it once", async () => {
		const gate = createGate((request, res) => {
			if (rig.fixture.requests.indexOf(request) < MAX_CONCURRENT_EXPORTS) {
				acceptAll(request, res);
				return;
			}
			res.writeHead(401);
			res.end();
		});
		const rig = await startRig(gate.responder);
		const { results } = await queueBehindFullSlots(rig, gate, 6);

		gate.stopHolding();
		const settled = await Promise.all(results);

		const started = settled.slice(0, MAX_CONCURRENT_EXPORTS);
		const coalesced = settled.slice(MAX_CONCURRENT_EXPORTS);
		expect(started.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
		expect(coalesced).toHaveLength(6);
		expect(coalesced.every((r) => r.code === ExportResultCode.FAILED)).toBe(
			true,
		);
		const messages = new Set(coalesced.map((r) => r.error?.message));
		expect([...messages]).toHaveLength(1);
		expect([...messages][0]).toContain("HTTP 401");
		// One failed export, however many callbacks it carried.
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toBe([...messages][0]);
		expect(rig.fixture.requests).toHaveLength(MAX_CONCURRENT_EXPORTS + 1);
	});

	it("reports SUCCESS for an empty export without taking a slot or sending", async () => {
		const rig = await startRig();
		const exporter = rig.createExporter();

		const result = await exportAndWait(exporter, []);

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.fixture.requests).toHaveLength(0);
	});

	it("fails every coalesced callback once when the batch cannot be serialized", async () => {
		const gate = createGate();
		const rig = await startRig(gate.responder);
		const { exporter, results } = await queueBehindFullSlots(rig, gate, 0);
		// A span the serializer cannot read poisons the whole coalesced batch.
		const malformed = {} as unknown as ReadableSpan;
		const poisoned = [
			exportAndWait(exporter, [malformed]),
			exportAndWait(exporter, createRealSpans(1)),
		];

		gate.stopHolding();
		const settled = await Promise.all([...results, ...poisoned]);

		const failed = settled.slice(MAX_CONCURRENT_EXPORTS);
		expect(failed.map((r) => r.code)).toEqual([
			ExportResultCode.FAILED,
			ExportResultCode.FAILED,
		]);
		expect(failed[0].error?.message).toMatch(/export failed \(\w+\)/);
		expect(failed[1].error?.message).toBe(failed[0].error?.message);
		expect(rig.errors).toEqual([failed[0].error?.message]);
	});

	it("forceFlush resolves only after queued spans are sent", async () => {
		const gate = createGate();
		const rig = await startRig(gate.responder);
		const { exporter, spans, results } = await queueBehindFullSlots(
			rig,
			gate,
			3,
		);

		let flushed = false;
		const flush = exporter.forceFlush?.().then(() => {
			flushed = true;
		});
		// Free the slots: the queue goes out as one request, which stays held.
		gate.answerHeld();
		await waitFor(
			() => rig.fixture.requests.length === MAX_CONCURRENT_EXPORTS + 1,
		);
		await sleep(SETTLE_MS);
		expect(flushed).toBe(false);

		gate.stopHolding();
		await flush;

		expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
		const settled = await Promise.all(results);
		expect(settled.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
	});

	it("shutdown delivers spans accepted while the exporter was at capacity", async () => {
		const gate = createGate();
		const rig = await startRig(gate.responder);
		const { exporter, spans, results } = await queueBehindFullSlots(
			rig,
			gate,
			3,
		);

		const closing = exporter.shutdown();
		gate.answerHeld();
		await waitFor(
			() => rig.fixture.requests.length === MAX_CONCURRENT_EXPORTS + 1,
		);
		gate.stopHolding();
		await closing;

		expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
		const settled = await Promise.all(results);
		expect(settled.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
		const requestsBefore = rig.fixture.requests.length;
		const late = await exportAndWait(exporter, createRealSpans(1));
		expect(late.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(requestsBefore);
	});
});

/**
 * The clock the exporter reads (`Date.now`), frozen at its current value and
 * moved by the test. The export deadline is measured on this clock, so a test
 * can place the deadline exactly instead of racing real time. Create spans
 * before freezing the clock.
 */
function freezeClock() {
	const start = Date.now();
	let elapsedMs = 0;
	vi.spyOn(Date, "now").mockImplementation(() => start + elapsedMs);
	return {
		/** Sets the time elapsed since the freeze. */
		setElapsed(ms: number) {
			elapsedMs = ms;
		},
	};
}

/** A budget far above any real wait of these tests, so only the clock decides. */
const BUDGET_MS = 30_000;

describe("createOtlpExporter total deadline", () => {
	/**
	 * Answers the first request with 503 (after moving the clock to
	 * `elapsedMs`) and every later request with success.
	 */
	function transientThenAccept(
		onFirst: () => void,
		retryAfter?: string,
	): FixtureResponder {
		let answered = 0;
		return (request, res) => {
			answered += 1;
			if (answered > 1) {
				acceptAll(request, res);
				return;
			}
			onFirst();
			res.writeHead(503, retryAfter ? { "retry-after": retryAfter } : {});
			res.end();
		};
	}

	it.each([
		["a Retry-After wait", "30", "30000ms", true, 100, "100ms"],
		["a backoff wait", undefined, "250ms", false, 100, "100ms"],
		[
			"a Retry-After wait when the deadline has passed",
			"30",
			"30000ms",
			true,
			-500,
			"0ms",
		],
	])(
		"gives up with the wait and the time left when %s does not fit the deadline",
		async (_name, retryAfter, needs, advised, leftMs, shownLeft) => {
			const spans = createRealSpans(1);
			const clock = freezeClock();
			const rig = await startRig(
				transientThenAccept(
					() => clock.setElapsed(BUDGET_MS - leftMs),
					retryAfter,
				),
			);

			const result = await exportAndWait(rig.createExporter(BUDGET_MS), spans);

			expect(result.code).toBe(ExportResultCode.FAILED);
			expect(rig.fixture.requests).toHaveLength(1);
			expect(rig.errors).toHaveLength(1);
			expect(rig.errors[0]).toContain("HTTP 503 on attempt 1");
			expect(rig.errors[0]).toContain(
				`next retry needs ${needs} but only ${shownLeft} of the ${BUDGET_MS}ms deadline remain`,
			);
			expect(rig.errors[0].includes("(Retry-After)")).toBe(advised);
		},
	);

	it("gives up when the advised wait uses all of the time left", async () => {
		const spans = createRealSpans(1);
		const clock = freezeClock();
		const budget = 61_000;
		// One second of the budget is left: a one-second Retry-After uses it all.
		const exact = await startRig(
			transientThenAccept(() => clock.setElapsed(budget - 1_000), "1"),
		);

		const result = await exportAndWait(exact.createExporter(budget), spans);

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(exact.fixture.requests).toHaveLength(1);
		expect(exact.errors[0]).toContain("needs 1000ms but only 1000ms");
	});

	/**
	 * Moves the clock once the exporter starts its backoff wait (250 ms after
	 * the first failure), which is after the time left was computed and before
	 * the next attempt checks the deadline.
	 */
	function moveClockDuringBackoff(
		clock: ReturnType<typeof freezeClock>,
		elapsedMs: number,
	) {
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: () => void,
			ms?: number,
		) => {
			if (ms === 250) clock.setElapsed(elapsedMs);
			return realSetTimeout(handler, ms);
		}) as unknown as typeof setTimeout);
	}

	it.each([
		["has passed", BUDGET_MS + 5_000],
		["ends exactly now", BUDGET_MS],
	])(
		"does not send another attempt once the deadline %s while it waits to retry",
		async (_name, elapsedMs) => {
			const spans = createRealSpans(1);
			const clock = freezeClock();
			const rig = await startRig(transientThenAccept(() => undefined));
			moveClockDuringBackoff(clock, elapsedMs);

			const result = await exportAndWait(rig.createExporter(BUDGET_MS), spans);

			expect(result.code).toBe(ExportResultCode.FAILED);
			expect(rig.fixture.requests).toHaveLength(1);
			expect(rig.errors).toEqual([
				`Langfuse OTLP export failed: export deadline of ${BUDGET_MS}ms exceeded; last failure: HTTP 503`,
			]);
		},
	);

	it("sends another attempt when the wait to retry leaves a millisecond of the deadline", async () => {
		const spans = createRealSpans(1);
		const clock = freezeClock();
		const rig = await startRig(transientThenAccept(() => undefined));
		moveClockDuringBackoff(clock, BUDGET_MS - 1);

		const result = await exportAndWait(rig.createExporter(BUDGET_MS), spans);

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.fixture.requests).toHaveLength(2);
		expect(rig.errors).toEqual([]);
	});

	it("reports an export whose budget was spent before its first request without a last failure", async () => {
		const spans = createRealSpans(1);
		const rig = await startRig();
		const exporter = rig.createExporter(1_000);
		const start = Date.now();
		let reads = 0;
		// The export reads the clock when it starts; every later read is late.
		vi.spyOn(Date, "now").mockImplementation(() => {
			reads += 1;
			return reads === 1 ? start : start + 10_000;
		});

		const result = await exportAndWait(exporter, spans);

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(0);
		expect(rig.errors).toEqual([
			"Langfuse OTLP export failed: export deadline of 1000ms exceeded",
		]);
	});

	it("fails an export with a zero budget against a server that never answers", async () => {
		const rig = await startRig(() => {
			// Never respond.
		});

		const result = await exportAndWait(
			rig.createExporter(0),
			createRealSpans(1),
		);

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toMatch(/deadline/);
	});
});

describe("createOtlpExporter response and request limits", () => {
	it("fails without retrying when the response body exceeds the read limit", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("x".repeat(1_200_000));
		});

		const result = await exportAndWait(
			rig.createExporter(),
			createRealSpans(1),
		);

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(1);
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toMatch(/response exceeded the \d+-byte read limit/);
	});

	it("names the position of each failed request of a split export", async () => {
		const rig = await startRig((_request, res) => {
			res.writeHead(401);
			res.end();
		});
		// Two spans that cannot share a request.
		const spans = createRealSpans(2, { "test.big": "x".repeat(2_000_000) });

		const result = await exportAndWait(rig.createExporter(), spans);

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(rig.fixture.requests).toHaveLength(2);
		expect(rig.errors).toHaveLength(1);
		expect(rig.errors[0]).toContain("(request 1/2)");
		expect(rig.errors[0]).toContain("(request 2/2)");
	});
});

describe("createOtlpExporter linger", () => {
	const LONG_LINGER_MS = 60_000;

	async function lingerRig(lingerMs: number) {
		const rig = await startRig();
		const exporter = createOtlpExporter({
			host: rig.fixture.host,
			publicKey: "pk-test",
			secretKey: "sk-test",
			timeoutMs: 5_000,
			lingerMs,
			dispatchSpanNames: new Set(["agent.turn"]),
			onError: (message) => rig.errors.push(message),
		});
		openExporters.push(exporter);
		return { rig, exporter };
	}

	/** Real spans with explicit names, ended through a live tracer pipeline. */
	function namedSpans(names: string[]): ReadableSpan[] {
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
		const tracer = provider.getTracer("otlp-export.linger.test");
		for (const name of names) tracer.startSpan(name).end();
		return captured;
	}

	it("sends spans that end within the linger window as one request", async () => {
		const { rig, exporter } = await lingerRig(150);
		const spans = createRealSpans(5);

		const results = await Promise.all(
			spans.map((span) => exportAndWait(exporter, [span])),
		);

		expect(results.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
		expect(rig.fixture.requests).toHaveLength(1);
		expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
		expect(rig.errors).toEqual([]);
	});

	it("sends at once when the waiting spans reach the queue bound", async () => {
		const { rig, exporter } = await lingerRig(LONG_LINGER_MS);
		const spans = createRealSpans(256);

		const results = await Promise.all(
			spans.map((span) => exportAndWait(exporter, [span])),
		);

		expect(results.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
		expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
	});

	it("sends at once when a span that closes a unit of work ends", async () => {
		const { rig, exporter } = await lingerRig(LONG_LINGER_MS);
		const spans = namedSpans(["tool:bash", "llm-response", "agent.turn"]);

		const results = await Promise.all(
			spans.map((span) => exportAndWait(exporter, [span])),
		);

		expect(results.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
			true,
		);
		expect(rig.fixture.requests).toHaveLength(1);
		expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
	});

	it("sends spans that end during an immediate hold at once, and batches again after its release", async () => {
		// A flush holds immediate sending for its whole duration: the span
		// processor waits for every pending export callback before it asks
		// the exporter to flush, so a span that ends mid-flush must not wait.
		const { rig, exporter } = await lingerRig(LONG_LINGER_MS);
		const [held, afterRelease] = createRealSpans(2);
		const release = exporter.sendImmediately();

		// The exporter was idle when the hold began; the span ends later.
		const heldResult = await exportAndWait(exporter, [held]);
		expect(heldResult.code).toBe(ExportResultCode.SUCCESS);
		expect(sentSpanIds(rig)).toEqual(expectedSpanIds([held]));

		release();
		release(); // A second release is a no-op, not a second decrement.
		const later = exportAndWait(exporter, [afterRelease]);
		await sleep(SETTLE_MS);
		expect(rig.fixture.requests).toHaveLength(1);
		await exporter.forceFlush?.();
		expect((await later).code).toBe(ExportResultCode.SUCCESS);
		expect(rig.fixture.requests).toHaveLength(2);
	});

	it.each([
		["forceFlush", (exporter: OtlpSpanExporter) => exporter.forceFlush?.()],
		["shutdown", (exporter: OtlpSpanExporter) => exporter.shutdown()],
		[
			"sendImmediately",
			async (exporter: OtlpSpanExporter) => {
				exporter.sendImmediately()();
			},
		],
	])(
		"%s sends lingering spans without waiting for the window",
		async (_name, release) => {
			const { rig, exporter } = await lingerRig(LONG_LINGER_MS);
			const spans = createRealSpans(2);
			const results = spans.map((span) => exportAndWait(exporter, [span]));
			await sleep(SETTLE_MS);
			expect(rig.fixture.requests).toHaveLength(0);

			await release(exporter);
			const settled = await Promise.all(results);

			expect(settled.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(
				true,
			);
			expect(sentSpanIds(rig)).toEqual(expectedSpanIds(spans));
		},
	);
});

describe("createOtlpExporter transient retries", () => {
	it("waits at least the base backoff when the server advises no wait", async () => {
		// Retries now run until the deadline, so a Retry-After of 0 (or a
		// past date) must not turn them into a burst against a busy server.
		const rig = await startRig((_request, res) => {
			res.writeHead(503, { "retry-after": "0" });
			res.end();
		});

		const result = await exportAndWait(
			rig.createExporter(1_200),
			createRealSpans(1),
		);

		expect(result.code).toBe(ExportResultCode.FAILED);
		// 0, 250, 500, 750, 1,000 ms at most: five attempts, not hundreds.
		expect(rig.fixture.requests.length).toBeGreaterThanOrEqual(2);
		expect(rig.fixture.requests.length).toBeLessThanOrEqual(5);
		expect(rig.errors).toHaveLength(1);
	});

	it("keeps retrying a transient failure until the deadline instead of stopping after a fixed count", async () => {
		// A Postgres restart behind Langfuse answers 503 for several seconds.
		// Five failures take 0.25 + 0.5 + 1 + 2 s of backoff, inside 6 s.
		let answered = 0;
		const rig = await startRig((request, res) => {
			answered += 1;
			if (answered <= 5) {
				res.writeHead(503);
				res.end();
				return;
			}
			acceptAll(request, res);
		});

		const result = await exportAndWait(
			rig.createExporter(6_000),
			createRealSpans(1),
		);

		expect(result).toEqual({ code: ExportResultCode.SUCCESS });
		expect(rig.fixture.requests).toHaveLength(6);
		expect(rig.errors).toEqual([]);
	}, 15_000);
});
