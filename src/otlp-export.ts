import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Dependency-free OTLP/HTTP span exporter for the Langfuse ingestion endpoint.
 *
 * Replaces the installed @opentelemetry OTLP exporter for this extension
 * because that exporter reports SUCCESS even when a 200 response rejects
 * spans via `partialSuccess` and even when the 200 body is malformed JSON.
 * This exporter checks every response, retries only bounded transient
 * failures within one total deadline per export, and reports export failures
 * through the `onError` callback instead of diag logging. Configuration is
 * fully explicit: OTEL_* environment variables are never read.
 *
 * Wire contract: POST `${host}/api/public/otel/v1/traces`, Basic auth,
 * `application/json` bodies produced by `JsonTraceSerializer` from the real
 * spans, so trace and span identities reach the server unchanged.
 */

export interface OtlpExporterOptions {
	host: string;
	publicKey: string;
	secretKey: string;
	/**
	 * Total budget for one `export()` call: all requests, retries, and
	 * response reads must finish inside it. The deadline aborts in-flight
	 * work; it is not reset per attempt.
	 */
	timeoutMs: number;
	/** App-edge sink for safe, actionable, bounded failure summaries. */
	onError: (message: string) => void;
}

// Bound each request below Langfuse's ingestion size limit.
const MAX_REQUEST_BYTES = 3_500_000;
const MAX_RESPONSE_BYTES = 1_000_000;
// One initial attempt plus three retries, all inside the total deadline.
const MAX_HTTP_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;
const MAX_SUMMARY_REASONS = 3;
const MAX_ERROR_NAME_CHARS = 40;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const TRACES_PATH = "/api/public/otel/v1/traces";

interface OversizedSpan {
	traceId: string;
	spanId: string;
	bytes: number;
}

interface ChunkPlan {
	bodies: Uint8Array[];
	oversized: OversizedSpan[];
}

/**
 * What one HTTP attempt concluded. `retry` carries the server-advised wait
 * (`retryAfterMs`) when a Retry-After header was usable, leaving the choice
 * of wait time and the deadline check to the retry loop.
 */
type AttemptResult =
	| { class: "accepted" }
	| { class: "terminal"; reason: string }
	| { class: "retry"; status?: number; retryAfterMs?: number };

type SendOutcome = { ok: true } | { ok: false; reason: string };

class ResponseTooLargeError extends Error {}

/** Export failure already delivered to the diagnostic sink. */
export class OtlpExportError extends Error {}

export function createOtlpExporter(options: OtlpExporterOptions): SpanExporter {
	const endpoint = `${options.host.replace(/\/+$/, "")}${TRACES_PATH}`;
	const headers: Record<string, string> = {
		Authorization: `Basic ${Buffer.from(
			`${options.publicKey}:${options.secretKey}`,
		).toString("base64")}`,
		"Content-Type": "application/json",
		"x-langfuse-public-key": options.publicKey,
	};
	const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs));
	const inFlight = new Set<Promise<void>>();
	let shutDown = false;

	function deliver(
		resultCallback: (result: { code: ExportResultCode; error?: Error }) => void,
		summary: string | undefined,
	): void {
		if (summary === undefined) {
			resultCallback({ code: ExportResultCode.SUCCESS });
			return;
		}
		options.onError(summary);
		resultCallback({
			code: ExportResultCode.FAILED,
			error: new OtlpExportError(summary),
		});
	}

	async function exportSpans(
		resultCallback: (result: { code: ExportResultCode; error?: Error }) => void,
		spans: ReadableSpan[],
	): Promise<void> {
		const controller = new AbortController();
		const deadline = Date.now() + timeoutMs;
		// One abortable total deadline per export: it covers every request,
		// retry wait, and body read of this call.
		const timer = setTimeout(
			() => {
				controller.abort();
			},
			Math.max(1, deadline - Date.now()),
		);
		try {
			const plan = planRequestBodies(spans);
			const problems: string[] = [];
			for (const dropped of plan.oversized) {
				problems.push(
					`span ${dropped.spanId} of trace ${dropped.traceId} is ${dropped.bytes} bytes, exceeds the ${MAX_REQUEST_BYTES}-byte request limit; not sent`,
				);
			}
			const failures: string[] = [];
			for (let index = 0; index < plan.bodies.length; index += 1) {
				const label =
					plan.bodies.length > 1
						? ` (request ${index + 1}/${plan.bodies.length})`
						: "";
				const outcome = await sendRequestWithRetry(
					plan.bodies[index],
					controller,
					deadline,
				);
				if (!outcome.ok) failures.push(`${outcome.reason}${label}`);
			}
			deliver(
				resultCallback,
				joinReasons("Langfuse OTLP export failed", [...failures, ...problems]),
			);
		} finally {
			clearTimeout(timer);
		}
	}

	async function sendRequestWithRetry(
		body: Uint8Array,
		controller: AbortController,
		deadline: number,
	): Promise<SendOutcome> {
		let lastFailure: string | undefined;
		for (let attempt = 1; attempt <= MAX_HTTP_ATTEMPTS; attempt += 1) {
			if (deadline - Date.now() <= 0) {
				return {
					ok: false,
					reason: `export deadline of ${timeoutMs}ms exceeded${
						lastFailure ? `; last failure: ${lastFailure}` : ""
					}`,
				};
			}
			let result: AttemptResult;
			try {
				result = await sendAttempt(body, controller);
			} catch (error) {
				if (error instanceof ResponseTooLargeError) {
					return {
						ok: false,
						reason: `Langfuse response exceeded the ${MAX_RESPONSE_BYTES}-byte read limit; not retried`,
					};
				}
				if (controller.signal.aborted) {
					// The only abort source is this export's deadline timer.
					return {
						ok: false,
						reason: `timed out after ${timeoutMs}ms total export deadline`,
					};
				}
				// Transport-level failures retry like transient HTTP errors; the
				// raw message stays out of summaries on purpose.
				lastFailure = `network error (${errorName(error)})`;
				result = { class: "retry" };
			}
			if (result.class === "accepted") return { ok: true };
			if (result.class === "terminal")
				return { ok: false, reason: result.reason };
			if (result.status !== undefined) lastFailure = `HTTP ${result.status}`;
			if (attempt >= MAX_HTTP_ATTEMPTS) {
				return {
					ok: false,
					reason: `${lastFailure} persisted for all ${attempt} attempts within the ${timeoutMs}ms deadline`,
				};
			}
			const delayMs = result.retryAfterMs ?? backoffDelayMs(attempt);
			const remainingMs = deadline - Date.now();
			if (delayMs >= remainingMs) {
				return {
					ok: false,
					reason: `${lastFailure} on attempt ${attempt}; next retry needs ${Math.round(
						delayMs,
					)}ms but only ${Math.max(0, Math.round(remainingMs))}ms of the ${timeoutMs}ms deadline remain${
						result.retryAfterMs !== undefined ? " (Retry-After)" : ""
					}`,
				};
			}
			await delay(delayMs, controller.signal);
		}
		return { ok: false, reason: "retry budget exhausted" };
	}

	async function sendAttempt(
		body: Uint8Array,
		controller: AbortController,
	): Promise<AttemptResult> {
		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
			// Credentials must never ride a redirect to another URL.
			redirect: "error",
		});
		const data = await readBoundedBody(response, controller);
		if (response.ok) {
			return acceptedOrRejected(parseExportResponse(data));
		}
		if (RETRYABLE_STATUS_CODES.has(response.status)) {
			return {
				class: "retry",
				status: response.status,
				retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
			};
		}
		// Status-only summary: no response body, credentials, or transport text.
		return { class: "terminal", reason: `HTTP ${response.status}` };
	}

	return {
		export(spans, resultCallback) {
			if (shutDown) {
				const summary =
					"Langfuse OTLP export dropped: exporter already shut down";
				deliver(resultCallback, summary);
				return;
			}
			if (spans.length === 0) {
				resultCallback({ code: ExportResultCode.SUCCESS });
				return;
			}
			const run = exportSpans(resultCallback, spans).catch((error: unknown) => {
				deliver(
					resultCallback,
					`Langfuse OTLP export failed (${errorName(error)})`,
				);
			});
			inFlight.add(run);
			const settle = () => {
				inFlight.delete(run);
			};
			run.then(settle, settle);
		},
		async forceFlush() {
			await Promise.allSettled([...inFlight]);
		},
		async shutdown() {
			shutDown = true;
			await Promise.allSettled([...inFlight]);
		},
	};
}

function acceptedOrRejected(verdict: ResponseVerdict): AttemptResult {
	switch (verdict.kind) {
		case "accepted":
			return { class: "accepted" };
		case "rejected":
			// OTLP forbids retrying a populated partialSuccess response.
			return {
				class: "terminal",
				reason: `server rejected ${verdict.rejectedSpans} span(s) in a 200 response; not retried (OTLP partial success)`,
			};
		case "malformed":
			// The request may have been persisted; a retry cannot fix the body
			// and risks duplicates, so a malformed 200 is terminal.
			return {
				class: "terminal",
				reason: `malformed 200 response (${verdict.detail}); not retried because the server may have persisted the batch`,
			};
	}
}

type ResponseVerdict =
	| { kind: "accepted" }
	| { kind: "rejected"; rejectedSpans: number }
	| { kind: "malformed"; detail: string };

/**
 * Classifies an export response against the OTLP spec: an empty body or an
 * empty object is full acceptance; `partialSuccess.rejectedSpans` above zero
 * is a rejection (number or int64 digit string); anything uninterpretable is
 * malformed and can never count as success.
 */
function parseExportResponse(data: Uint8Array): ResponseVerdict {
	if (data.byteLength === 0) return { kind: "accepted" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(data));
	} catch {
		return { kind: "malformed", detail: "body is not valid JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "malformed", detail: "body is not a JSON object" };
	}
	const partial = (parsed as { partialSuccess?: unknown }).partialSuccess;
	if (partial === undefined || partial === null) return { kind: "accepted" };
	if (typeof partial !== "object" || Array.isArray(partial)) {
		return { kind: "malformed", detail: "partialSuccess is not an object" };
	}
	const raw = (partial as { rejectedSpans?: unknown }).rejectedSpans;
	if (raw === undefined) return { kind: "accepted" };
	const rejected =
		typeof raw === "number"
			? raw
			: typeof raw === "string" && /^\d+$/.test(raw)
				? Number(raw)
				: undefined;
	if (rejected === undefined || !Number.isInteger(rejected) || rejected < 0) {
		return {
			kind: "malformed",
			detail: "rejectedSpans is not a non-negative integer or digit string",
		};
	}
	if (rejected > 0) {
		// Server errorMessage can echo private payloads; report only the count.
		return { kind: "rejected", rejectedSpans: rejected };
	}
	// Zero rejected is full acceptance, whatever warning message rode along.
	return { kind: "accepted" };
}

/**
 * Splits spans into request bodies of at most `MAX_REQUEST_BYTES` without
 * rebuilding span content. The whole batch is serialized once; only when it
 * exceeds the cap are spans serialized individually. Each single-span
 * serialization includes the envelope once, so summing those costs
 * over-counts the transmitted size and a packed chunk can never cross the
 * cap. A span that alone exceeds the cap is reported and excluded instead of
 * poisoning the chunk that would carry it.
 */
function planRequestBodies(spans: ReadableSpan[]): ChunkPlan {
	const whole = JsonTraceSerializer.serializeRequest(spans);
	if (whole && whole.byteLength <= MAX_REQUEST_BYTES) {
		return { bodies: [whole], oversized: [] };
	}
	const bodies: Uint8Array[] = [];
	const oversized: OversizedSpan[] = [];
	let current: ReadableSpan[] = [];
	let currentBytes = 0;
	const closeCurrent = () => {
		if (current.length === 0) return;
		const serialized = JsonTraceSerializer.serializeRequest(current);
		if (!serialized) {
			throw new Error("Langfuse OTLP span serialization produced no bytes");
		}
		bodies.push(serialized);
		current = [];
		currentBytes = 0;
	};
	for (const span of spans) {
		const serialized = JsonTraceSerializer.serializeRequest([span]);
		if (!serialized) {
			throw new Error("Langfuse OTLP span serialization produced no bytes");
		}
		const bytes = serialized.byteLength;
		if (bytes > MAX_REQUEST_BYTES) {
			oversized.push({
				traceId: span.spanContext().traceId,
				spanId: span.spanContext().spanId,
				bytes,
			});
			continue;
		}
		if (currentBytes + bytes > MAX_REQUEST_BYTES) closeCurrent();
		current.push(span);
		currentBytes += bytes;
	}
	closeCurrent();
	return { bodies, oversized };
}

/**
 * Reads the response body with a hard byte cap. Oversized responses abort
 * the export's controller and surface as a terminal failure, so a hostile
 * or broken server cannot stream unbounded data into memory.
 */
async function readBoundedBody(
	response: Response,
	controller: AbortController,
): Promise<Uint8Array> {
	const body = response.body;
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			controller.abort();
			await reader.cancel().catch(() => {});
			throw new ResponseTooLargeError();
		}
		chunks.push(value);
	}
	const data = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}

/** Retry-After as delay-seconds or HTTP-date; unusable values defer to backoff. */
function parseRetryAfterMs(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number.parseInt(value, 10);
	if (Number.isInteger(seconds)) return Math.max(0, seconds * 1000);
	const dateMs = Date.parse(value);
	if (Number.isNaN(dateMs)) return undefined;
	return Math.max(0, dateMs - Date.now());
}

function backoffDelayMs(attempt: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/**
 * Waits for the backoff without busy-spinning. An abort (deadline reached)
 * resolves early; the retry loop's remaining-time check then stops the loop.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

function joinReasons(label: string, reasons: string[]): string | undefined {
	if (reasons.length === 0) return undefined;
	const shown = reasons.slice(0, MAX_SUMMARY_REASONS);
	const omitted = reasons.length - shown.length;
	return `${label}: ${shown.join("; ")}${
		omitted > 0 ? ` (+${omitted} more)` : ""
	}`;
}

/** Error class name only: transport messages can carry URLs or addresses. */
function errorName(error: unknown): string {
	const name =
		error instanceof Error && error.constructor?.name
			? error.constructor.name
			: typeof error;
	return name.slice(0, MAX_ERROR_NAME_CHARS);
}
