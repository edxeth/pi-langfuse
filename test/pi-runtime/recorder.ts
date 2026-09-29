import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the supported Langfuse server surface, used by the real
 * Pi runtime regression tests. Mirrors the single-export-pipeline contract:
 *
 * - POST /api/public/otel/v1/traces: OTLP JSON ingestion. Accepted spans are
 *   indexed per trace, which is what a real server's observation index does.
 *   Acceptance is decided by the transport response alone: a 200 without a
 *   rejecting partialSuccess is final, and a partialSuccess with rejected
 *   spans is a loss the server reports in-band (nothing is indexed).
 * - GET  /api/public/v2/observations and GET /api/public/observations: the
 *   read APIs exist here only as server-mode modeling. The extension must
 *   never call them under the single-export pipeline; their hit counters
 *   (pollCounts, v1Hits) turn any read attempt into a visible defect.
 * - POST /api/public/scores: accepted and recorded.
 * - Legacy routes (/api/public/ingestion, GET /api/public/traces/<id>) answer
 *   404 so any legacy traffic becomes a visible defect.
 *
 * Faults are explicit and opt-in per test; the default behavior is a healthy
 * server. All traffic stays on 127.0.0.1 and every request is recorded in
 * memory for assertions.
 */

export type RecorderRecord = {
	method: string;
	path: string;
	contentType: string;
	byteLength: number;
	kind: "json" | "text" | "empty";
	body?: unknown;
	text?: string;
	outcome: string;
};

export type RecorderFaults = {
	/** Reject matching OTLP posts with `rejectStatus` until this many matching posts have been seen. */
	rejectBodiesContaining: string[];
	rejectStatus: number;
	gateAtMatchedCount: number;
	/** Answer matching OTLP posts with 200 + partialSuccess and index nothing. */
	partialRejectBodiesContaining: string[];
	/**
	 * Status code for GET /api/public/v2/observations (default 200). Servers
	 * outside v4 write mode answer 404; the extension must never ask either
	 * way, so the hit counter stays the real assertion.
	 */
	v2Status: number;
	/**
	 * Status code for GET /api/public/observations (the legacy v1 read).
	 * Default 404 keeps legacy discipline; set 200 to prove the extension
	 * ignores an available legacy read surface too.
	 */
	v1Status: number;
};

export type RecordedSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes?: Array<{ key: string; value?: Record<string, unknown> }>;
};

function spansFromBody(body: unknown): RecordedSpan[] {
	const out: RecordedSpan[] = [];
	const payload = body as
		| {
				resourceSpans?: Array<{
					scopeSpans?: Array<{ spans?: RecordedSpan[] }>;
				}>;
		  }
		| undefined;
	for (const resource of payload?.resourceSpans ?? []) {
		for (const scope of resource.scopeSpans ?? []) {
			out.push(...(scope.spans ?? []));
		}
	}
	return out;
}

export class LangfuseRecorder {
	readonly server: Server;
	readonly port: number;
	readonly url: string;
	readonly name: string;
	readonly records: RecorderRecord[] = [];
	readonly scores: Array<{ auth: string | null; body: unknown }> = [];
	readonly legacyHits: string[] = [];
	/** traceId -> indexed spanId -> span name (only accepted OTLP posts). */
	readonly index = new Map<string, Map<string, string>>();
	/** GET /api/public/v2/observations requests per trace id; any hit is a defect. */
	readonly pollCounts = new Map<string, number>();
	/** GET /api/public/observations requests; any hit is a defect. */
	v1Hits = 0;
	readonly faults: RecorderFaults;
	postsTotal = 0;
	postsAccepted = 0;
	postsRejected = 0;

	constructor(server: Server, port: number, name: string) {
		this.server = server;
		this.port = port;
		this.url = `http://127.0.0.1:${port}`;
		this.name = name;
		this.faults = {
			rejectBodiesContaining: [],
			rejectStatus: 503,
			gateAtMatchedCount: Number.POSITIVE_INFINITY,
			partialRejectBodiesContaining: [],
			v2Status: 200,
			v1Status: 404,
		};
	}

	handleRequest = (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
	): void => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks);
			const path = request.url || "";
			const bodyText = raw.toString("utf8");
			let body: unknown;
			let kind: RecorderRecord["kind"] = "empty";
			if (raw.length > 0) {
				try {
					body = JSON.parse(bodyText) as unknown;
					kind = "json";
				} catch {
					kind = "text";
				}
			}
			const record: RecorderRecord = {
				method: request.method || "",
				path,
				contentType: String(request.headers["content-type"] || ""),
				byteLength: raw.length,
				kind,
				...(kind === "json" ? { body } : {}),
				...(kind === "text" ? { text: bodyText.slice(0, 4000) } : {}),
				outcome: "default-200",
			};
			const matches = (markers: string[]) =>
				markers.some((marker) => bodyText.includes(marker));
			const finish = (status: number, payload: string) => {
				this.records.push(record);
				response.writeHead(status, { "content-type": "application/json" });
				response.end(payload);
			};

			// OTLP ingestion: the normal export and every replay land here.
			if (path.includes("/otel/v1/traces")) {
				this.postsTotal += 1;
				const matched =
					matches(this.faults.rejectBodiesContaining) &&
					this.postsTotal <= this.faults.gateAtMatchedCount;
				if (matched) {
					this.postsRejected += 1;
					record.outcome = `rejected-${this.faults.rejectStatus}`;
					finish(
						this.faults.rejectStatus,
						this.faults.rejectStatus === 400
							? JSON.stringify({
									error: { message: "synthetic bad request", code: 400 },
								})
							: JSON.stringify({
									error: { message: "synthetic overload", code: 503 },
								}),
					);
					return;
				}
				if (matches(this.faults.partialRejectBodiesContaining)) {
					record.outcome = "partial-reject";
					finish(
						200,
						JSON.stringify({
							partialSuccess: {
								rejectedSpans: "1",
								errorMessage: "synthetic partial rejection",
							},
						}),
					);
					return;
				}
				this.postsAccepted += 1;
				record.outcome = "accepted";
				for (const span of spansFromBody(body)) {
					let spans = this.index.get(span.traceId);
					if (!spans) {
						spans = new Map();
						this.index.set(span.traceId, spans);
					}
					spans.set(span.spanId, span.name);
				}
				finish(200, "{}");
				return;
			}

			// Read APIs: modeled for server-mode tests; any hit is a defect.
			if (
				request.method === "GET" &&
				path.includes("/api/public/v2/observations")
			) {
				if (this.faults.v2Status !== 200) {
					record.outcome = `v2-${this.faults.v2Status}`;
					this.records.push(record);
					response.writeHead(this.faults.v2Status, {
						"content-type": "application/json",
					});
					response.end(JSON.stringify({ error: "not found" }));
					return;
				}
				const traceId =
					new URL(path, "http://127.0.0.1").searchParams.get("traceId") ?? "";
				const polls = (this.pollCounts.get(traceId) ?? 0) + 1;
				this.pollCounts.set(traceId, polls);
				const spans = [...(this.index.get(traceId)?.entries() ?? [])].map(
					([id, name]) => ({ id, name, type: "SPAN" }),
				);
				record.outcome = `v2-${spans.length}`;
				finish(200, JSON.stringify({ data: spans, meta: {} }));
				return;
			}

			// Legacy v1 observations read (the extension must never negotiate
			// or read it; v1Hits exists to prove that).
			if (
				request.method === "GET" &&
				path.startsWith("/api/public/observations")
			) {
				this.v1Hits += 1;
				if (this.faults.v1Status !== 200) {
					record.outcome = `v1-${this.faults.v1Status}`;
					finish(
						this.faults.v1Status,
						JSON.stringify({ message: "Observation API unavailable" }),
					);
					return;
				}
				const query = new URL(path, "http://127.0.0.1").searchParams;
				const traceId = query.get("traceId") ?? "";
				const page = Math.max(1, Number(query.get("page") || 1));
				const limit = Math.max(1, Number(query.get("limit") || 100));
				const ids = [...(this.index.get(traceId)?.keys() ?? [])];
				const start = (page - 1) * limit;
				const data = ids
					.slice(start, start + limit)
					.map((id) => ({ id, traceId, type: "SPAN" }));
				record.outcome = `v1-${data.length}`;
				finish(
					200,
					JSON.stringify({
						data,
						meta: {
							page,
							limit,
							totalPages: Math.max(1, Math.ceil(ids.length / limit)),
						},
					}),
				);
				return;
			}

			if (path.includes("/api/public/scores")) {
				this.scores.push({
					auth: request.headers.authorization ?? null,
					body,
				});
				record.outcome = "score-accepted";
				finish(200, "{}");
				return;
			}

			// Legacy routes: recorded, then rejected so any traffic is a defect.
			if (
				path.includes("/api/public/ingestion") ||
				(request.method === "GET" && path.startsWith("/api/public/traces/"))
			) {
				this.legacyHits.push(path);
				record.outcome = "legacy-404";
				finish(404, JSON.stringify({ error: "not found" }));
				return;
			}

			finish(200, "{}");
		});
	};

	/** Stop accepting traffic and wait until the socket is fully released. */
	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	acceptedPosts(): RecorderRecord[] {
		return this.records.filter(
			(record) =>
				record.path.includes("/otel/v1/traces") &&
				record.outcome === "accepted",
		);
	}
}

export function startLangfuseRecorder(name: string): Promise<LangfuseRecorder> {
	return new Promise((resolve, reject) => {
		let recorder: LangfuseRecorder | undefined;
		const server = createServer((request, response) => {
			// Requests cannot arrive before the listening callback has run, so the
			// recorder instance is always bound by the time traffic flows.
			if (!recorder) {
				response.destroy();
				return;
			}
			recorder.handleRequest(request, response);
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			recorder = new LangfuseRecorder(server, port, name);
			resolve(recorder);
		});
	});
}
