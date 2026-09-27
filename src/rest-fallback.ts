import type { LangfuseClient } from "@langfuse/client";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { ExportResultCode, timeInputToHrTime } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export type RestFallbackMetadata = Record<string, unknown>;

export type RestFallbackTraceBody = {
	name?: string;
	input?: unknown;
	output?: unknown;
	sessionId?: string;
	userId?: string;
	tags?: string[];
	release?: string;
	version?: string;
	environment?: string;
	public?: boolean;
	metadata?: RestFallbackMetadata;
};

export type RestFallbackObservationBody = {
	input?: unknown;
	output?: unknown;
	metadata?: RestFallbackMetadata;
	isError?: boolean;
	model?: string;
	modelParameters?: Record<string, string | number>;
	usage?: unknown;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	statusMessage?: string;
	completionStartTime?: Date;
};

export type RestFallbackObservationType = "SPAN" | "GENERATION";
export type RestFallbackObservationLevel = "DEFAULT" | "ERROR";

export interface RestFallbackObservation {
	readonly id: string;
	readonly traceId: string;
	readonly type: RestFallbackObservationType;
	readonly name: string;
	readonly startTime: string;
	endTime?: string;
	parentObservationId?: string;
	input?: unknown;
	output?: unknown;
	metadata?: RestFallbackMetadata;
	model?: string;
	modelParameters?: Record<string, string | number>;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	level?: RestFallbackObservationLevel;
	statusMessage?: string;
	completionStartTime?: string;
}

export interface RestFallbackTrace {
	readonly id: string;
	timestamp: string;
	name: string;
	input?: unknown;
	output?: unknown;
	sessionId?: string;
	userId?: string;
	tags?: string[];
	release?: string;
	version?: string;
	environment?: string;
	public?: boolean;
	metadata?: RestFallbackMetadata;
	readonly observations: RestFallbackObservation[];
	completed: boolean;
	/** Drain rounds that attempted replay without full delivery. */
	attempts: number;
}

export interface RestFallbackStore {
	readonly traces: Map<string, RestFallbackTrace>;
	readonly observations: Map<string, RestFallbackObservation>;
}

/**
 * Connection facts for the supported OTLP ingestion endpoint. The legacy
 * `/api/public/ingestion` and trace read APIs are unavailable on Langfuse
 * server v4, so both the replay and the completeness check use the
 * OTLP/v2 surface that exists on v3 and v4 alike.
 */
export interface RestFallbackConnection {
	host: string;
	publicKey: string;
	secretKey: string;
}

export interface FallbackReplayTransport {
	sendSpans(spans: ReadableSpan[], timeoutMs: number): Promise<void>;
}

export interface RestFallbackDeps {
	client: LangfuseClient;
	transport: FallbackReplayTransport;
}

const MAX_REST_BATCH_BYTES = 3_500_000;
const MAX_REPORTED_FAILURE_REASONS = 3;
export const MAX_FALLBACK_ATTEMPTS = 3;
let maxRetainedFallbackBytes = 32_000_000;

/**
 * Overrides the retention budget for tests; the drain treats the previous
 * budget as restored once the returned function runs.
 */
export function setRestFallbackRetentionForTest(maxBytes: number) {
	const previous = maxRetainedFallbackBytes;
	maxRetainedFallbackBytes = maxBytes;
	return () => {
		maxRetainedFallbackBytes = previous;
	};
}
const MAX_VISIBILITY_PAGES = 5;
const FALLBACK_RESOURCE = { attributes: { "service.name": "pi-langfuse" } };
const FALLBACK_SCOPE = {
	name: "pi-langfuse-rest-fallback",
	version: undefined,
	schemaUrl: undefined,
};

export function createRestFallbackStore(): RestFallbackStore {
	return {
		traces: new Map(),
		observations: new Map(),
	};
}

/**
 * Builds a replay sender over the standard OTLP trace exporter, the same
 * serialization the normal export path uses. A fresh exporter per send keeps
 * the timeout bound aligned with the current drain options.
 */
export function createOtlpFallbackTransport(
	connection: RestFallbackConnection,
): FallbackReplayTransport {
	return {
		sendSpans(spans, timeoutMs) {
			const exporter = new OTLPTraceExporter({
				url: `${connection.host.replace(/\/$/, "")}/api/public/otel/v1/traces`,
				headers: {
					Authorization: `Basic ${Buffer.from(
						`${connection.publicKey}:${connection.secretKey}`,
					).toString("base64")}`,
					"x-langfuse-public-key": connection.publicKey,
				},
				timeoutMillis: Math.max(timeoutMs, 1),
			});
			return new Promise((resolve, reject) => {
				exporter.export(spans, (result) => {
					if (result.code === ExportResultCode.SUCCESS) {
						resolve();
						return;
					}
					reject(
						result.error ??
							new Error("OTLP fallback export failed without a reason"),
					);
				});
			});
		},
	};
}

function mergeMetadata(
	current: RestFallbackMetadata | undefined,
	next: RestFallbackMetadata | undefined,
) {
	return next ? { ...current, ...next } : current;
}

function applyTraceBody(
	trace: RestFallbackTrace | undefined,
	body: RestFallbackTraceBody | undefined,
) {
	if (!trace || !body) return;
	if (typeof body.name === "string") trace.name = body.name;
	if ("input" in body) trace.input = body.input;
	if ("output" in body) trace.output = body.output;
	if (typeof body.sessionId === "string") trace.sessionId = body.sessionId;
	if (typeof body.userId === "string") trace.userId = body.userId;
	if (body.tags) trace.tags = [...body.tags];
	if (typeof body.release === "string") trace.release = body.release;
	if (typeof body.version === "string") trace.version = body.version;
	if (typeof body.environment === "string") {
		trace.environment = body.environment;
	}
	if (body.public !== undefined) trace.public = body.public;
	if (body.metadata)
		trace.metadata = mergeMetadata(trace.metadata, body.metadata);
}

function applyObservationBody(
	observation: RestFallbackObservation | undefined,
	body: RestFallbackObservationBody | undefined,
) {
	if (!observation || !body) return;
	if ("input" in body) observation.input = body.input;
	if ("output" in body) observation.output = body.output;
	if (body.metadata) {
		observation.metadata = mergeMetadata(observation.metadata, body.metadata);
	}
	if (typeof body.model === "string") observation.model = body.model;
	if (body.modelParameters) observation.modelParameters = body.modelParameters;
	if (body.usageDetails) {
		observation.usageDetails = {
			...observation.usageDetails,
			...body.usageDetails,
		};
	}
	if (body.usage && typeof body.usage === "object") {
		observation.usageDetails = {
			...observation.usageDetails,
			...(body.usage as Record<string, number>),
		};
	}
	if (body.costDetails) {
		observation.costDetails = {
			...observation.costDetails,
			...body.costDetails,
		};
	}
	if (body.isError !== undefined) {
		observation.level = body.isError ? "ERROR" : "DEFAULT";
	}
	if (body.statusMessage !== undefined) {
		observation.statusMessage = body.statusMessage;
	}
	if (body.completionStartTime instanceof Date) {
		observation.completionStartTime = body.completionStartTime.toISOString();
	}
}

export function recordTrace(
	store: RestFallbackStore,
	input: {
		id: string;
		timestamp: string;
		body: RestFallbackTraceBody;
	},
) {
	const trace: RestFallbackTrace = {
		id: input.id,
		timestamp: input.timestamp,
		name: input.body.name || "pi-agent",
		observations: [],
		completed: false,
		attempts: 0,
	};
	applyTraceBody(trace, input.body);
	store.traces.set(trace.id, trace);
	return trace;
}

export function updateTrace(
	store: RestFallbackStore,
	traceId: string,
	body: RestFallbackTraceBody,
) {
	applyTraceBody(store.traces.get(traceId), body);
}

export function recordObservation(
	store: RestFallbackStore,
	input: {
		id: string;
		traceId: string;
		name: string;
		type: RestFallbackObservationType;
		startTime: string;
		parentObservationId?: string;
		body?: RestFallbackObservationBody;
	},
) {
	const trace = store.traces.get(input.traceId);
	if (!trace) return undefined;
	const observation: RestFallbackObservation = {
		id: input.id,
		traceId: input.traceId,
		type: input.type,
		name: input.name,
		startTime: input.startTime,
		parentObservationId: input.parentObservationId,
	};
	applyObservationBody(observation, input.body);
	trace.observations.push(observation);
	store.observations.set(observation.id, observation);
	return observation;
}

export function updateObservation(
	store: RestFallbackStore,
	observationId: string,
	body: RestFallbackObservationBody,
) {
	applyObservationBody(store.observations.get(observationId), body);
}

export function endObservation(
	store: RestFallbackStore,
	observationId: string,
	endTime: string,
) {
	const observation = store.observations.get(observationId);
	if (observation) observation.endTime = endTime;
}

export function completeTrace(store: RestFallbackStore, traceId: string) {
	const trace = store.traces.get(traceId);
	if (trace) trace.completed = true;
}

function serializeAttributeValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function setFlattenedMetadata(
	attributes: Record<string, unknown>,
	prefix: string,
	metadata: RestFallbackMetadata | undefined,
) {
	if (!metadata) return;
	for (const [key, value] of Object.entries(metadata)) {
		const serialized = serializeAttributeValue(value);
		if (serialized !== undefined) attributes[`${prefix}.${key}`] = serialized;
	}
}

/**
 * Converts one recorded observation into the span shape the normal OTel
 * export path produces, mirroring the installed SDK's attribute vocabulary so
 * the server reconstructs identical traces and observations from a replay.
 * Span identity is the recorded trace and observation id, so repeated replays
 * of the same record upsert instead of duplicating.
 */
function replaySpan(
	trace: RestFallbackTrace,
	observation: RestFallbackObservation,
	isTraceRoot: boolean,
): ReadableSpan {
	const attributes: Record<string, unknown> = {
		"langfuse.observation.type":
			observation.type === "GENERATION" ? "generation" : "span",
	};
	if (observation.level === "ERROR") {
		attributes["langfuse.observation.level"] = "ERROR";
	}
	if (observation.statusMessage !== undefined) {
		attributes["langfuse.observation.status_message"] =
			observation.statusMessage;
	}
	const input = serializeAttributeValue(observation.input);
	if (input !== undefined) attributes["langfuse.observation.input"] = input;
	const output = serializeAttributeValue(observation.output);
	if (output !== undefined) {
		attributes["langfuse.observation.output"] = output;
	}
	setFlattenedMetadata(
		attributes,
		"langfuse.observation.metadata",
		observation.metadata,
	);
	if (observation.model !== undefined) {
		attributes["langfuse.observation.model.name"] = observation.model;
	}
	const modelParameters = serializeAttributeValue(observation.modelParameters);
	if (modelParameters !== undefined) {
		attributes["langfuse.observation.model.parameters"] = modelParameters;
	}
	const usageDetails = serializeAttributeValue(observation.usageDetails);
	if (usageDetails !== undefined) {
		attributes["langfuse.observation.usage_details"] = usageDetails;
	}
	const costDetails = serializeAttributeValue(observation.costDetails);
	if (costDetails !== undefined) {
		attributes["langfuse.observation.cost_details"] = costDetails;
	}
	if (observation.completionStartTime !== undefined) {
		attributes["langfuse.observation.completion_start_time"] =
			observation.completionStartTime;
	}
	if (trace.environment) attributes["langfuse.environment"] = trace.environment;
	if (trace.release) attributes["langfuse.release"] = trace.release;
	if (isTraceRoot) {
		attributes["langfuse.trace.name"] = trace.name;
		if (trace.sessionId !== undefined) {
			attributes["session.id"] = trace.sessionId;
		}
		if (trace.userId !== undefined) attributes["user.id"] = trace.userId;
		if (trace.tags && trace.tags.length > 0) {
			attributes["langfuse.trace.tags"] = [...trace.tags];
		}
		const traceInput = serializeAttributeValue(trace.input);
		if (traceInput !== undefined) {
			attributes["langfuse.trace.input"] = traceInput;
		}
		const traceOutput = serializeAttributeValue(trace.output);
		if (traceOutput !== undefined) {
			attributes["langfuse.trace.output"] = traceOutput;
		}
		setFlattenedMetadata(attributes, "langfuse.trace.metadata", trace.metadata);
		if (trace.public) attributes["langfuse.trace.public"] = true;
	}
	const startTime = timeInputToHrTime(new Date(observation.startTime));
	const endTime = timeInputToHrTime(
		new Date(observation.endTime ?? observation.startTime),
	);
	const spanContext = {
		traceId: trace.id,
		spanId: observation.id,
		traceFlags: TraceFlags.SAMPLED,
		isRemote: false,
	};
	const parentSpanContext = observation.parentObservationId
		? {
				...spanContext,
				spanId: observation.parentObservationId,
			}
		: undefined;
	return {
		name: observation.name,
		kind: SpanKind.INTERNAL,
		spanContext: () => spanContext,
		parentSpanContext,
		startTime,
		endTime,
		status:
			observation.level === "ERROR"
				? {
						code: SpanStatusCode.ERROR,
						message: observation.statusMessage,
					}
				: { code: SpanStatusCode.UNSET },
		attributes: attributes as ReadableSpan["attributes"],
		links: [],
		events: [],
		duration: [0, 0],
		ended: true,
		resource: FALLBACK_RESOURCE as unknown as ReadableSpan["resource"],
		instrumentationScope: FALLBACK_SCOPE,
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	};
}

function buildReplaySpans(trace: RestFallbackTrace): ReadableSpan[] {
	// Trace-level fields ride the root observation's span, matching how the
	// normal path propagates them onto the prompt root.
	const rootId = trace.observations.find(
		(observation) => !observation.parentObservationId,
	)?.id;
	return trace.observations.map((observation) =>
		replaySpan(trace, observation, observation.id === rootId),
	);
}

// Exact transmitted-size accounting. All replay spans share one resource and
// scope, so the serialized OTLP envelope is a constant. It is derived once
// from three probe serializations (envelope = wire(a) + wire(b) -
// wire(a, b) + 1, the +1 being the comma between the two probe spans), and a
// span's wire size is its own single-span serialization minus the envelope.
// A chunk's transmitted size is then exactly the envelope plus the spans'
// wire sizes plus one comma per additional span. This counts every array
// element and key/value frame the way the server receives it, and the cost
// is bounded: three tiny probe serializations per process plus one
// serialization per span per drain.
const FALLBACK_WIRE_PROBE_SPAN_IDS = ["p".repeat(32), "q".repeat(32)];

function wireProbeSpan(id: string): ReadableSpan {
	return {
		name: "pi-langfuse-rest-fallback-probe",
		kind: SpanKind.INTERNAL,
		spanContext: () => ({
			traceId: id,
			spanId: "0".repeat(16),
			traceFlags: TraceFlags.SAMPLED,
			isRemote: false,
		}),
		startTime: [0, 0],
		endTime: [0, 0],
		status: { code: SpanStatusCode.UNSET },
		attributes: {},
		links: [],
		events: [],
		duration: [0, 0],
		ended: true,
		resource: FALLBACK_RESOURCE as unknown as ReadableSpan["resource"],
		instrumentationScope: FALLBACK_SCOPE,
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	};
}

function serializeWire(spans: ReadableSpan[]): number {
	const serialized = JsonTraceSerializer.serializeRequest(spans);
	if (!serialized) {
		throw new Error("fallback span serialization produced no bytes");
	}
	return serialized.byteLength;
}

let replayEnvelopeCache: number | undefined;

function replayEnvelopeBytes(): number {
	if (replayEnvelopeCache === undefined) {
		const [probeA, probeB] = FALLBACK_WIRE_PROBE_SPAN_IDS.map(wireProbeSpan);
		replayEnvelopeCache =
			serializeWire([probeA]) +
			serializeWire([probeB]) -
			serializeWire([probeA, probeB]) +
			1;
	}
	return replayEnvelopeCache;
}

const spanWireBytesCache = new WeakMap<ReadableSpan, number>();

/**
 * Wire cost of one span including its list-comma slot, so a chunk's
 * transmitted size is exactly envelope + sum of costs - 1.
 */
function replaySpanWireCost(span: ReadableSpan): number {
	const cached = spanWireBytesCache.get(span);
	if (cached !== undefined) return cached;
	const cost = serializeWire([span]) - replayEnvelopeBytes() + 1;
	spanWireBytesCache.set(span, cost);
	return cost;
}

function replayChunkWireBytes(costSum: number, spanCount: number) {
	return replayEnvelopeBytes() + costSum - (spanCount > 0 ? 1 : 0);
}

function boundedEventList(ids: string[], max = MAX_REPORTED_FAILURE_REASONS) {
	const shown = ids.slice(0, max);
	const omitted = ids.length - shown.length;
	return `${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function enforceRetentionBound(
	store: RestFallbackStore,
	built: Array<{ trace: RestFallbackTrace; spans: ReadableSpan[] }>,
): string[] {
	const bytesOf = (entry: { spans: ReadableSpan[] }) =>
		entry.spans.reduce((sum, span) => sum + replaySpanWireCost(span), 0);
	let total = 0;
	for (const entry of built) total += bytesOf(entry);
	const discarded: string[] = [];
	// FIFO: the store Map preserves insertion order, so the oldest completed
	// traces give up their recovery copies first when the budget is exceeded.
	for (const entry of built) {
		if (total <= maxRetainedFallbackBytes) break;
		total -= bytesOf(entry);
		discarded.push(entry.trace.id);
		retireTrace(store, entry.trace);
	}
	return discarded;
}

export interface BuiltReplayChunks {
	chunks: ReadableSpan[][];
	/** Trace id plus rendered label for every dropped oversized span. */
	oversizedSpans: Array<{ traceId: string; label: string }>;
	/** Trace ids carried by each chunk, aligned with `chunks`. */
	chunkTraceIds: Array<Set<string>>;
}

function buildReplayChunks(
	entries: Array<{ trace: RestFallbackTrace; spans: ReadableSpan[] }>,
): BuiltReplayChunks {
	const chunks: ReadableSpan[][] = [];
	const oversizedSpans: Array<{ traceId: string; label: string }> = [];
	const chunkTraceIds: Array<Set<string>> = [];
	let current: ReadableSpan[] = [];
	let currentCost = 0;
	let currentOwners = new Set<string>();
	const closeCurrent = () => {
		if (current.length === 0) return;
		chunks.push(current);
		chunkTraceIds.push(currentOwners);
		current = [];
		currentCost = 0;
		currentOwners = new Set();
	};
	for (const { trace, spans } of entries) {
		for (const span of spans) {
			const cost = replaySpanWireCost(span);
			// One span whose transmitted size exceeds the request limit cannot
			// be delivered by any chunking, so it is dropped and reported
			// instead of poisoning the whole chunk that carries it.
			if (replayChunkWireBytes(cost, 1) > MAX_REST_BATCH_BYTES) {
				oversizedSpans.push({
					traceId: trace.id,
					label: `span ${span.spanContext().spanId} (${replayChunkWireBytes(cost, 1)} bytes)`,
				});
				continue;
			}
			if (
				replayChunkWireBytes(currentCost + cost, current.length + 1) >
				MAX_REST_BATCH_BYTES
			) {
				closeCurrent();
			}
			current.push(span);
			currentCost += cost;
			currentOwners.add(trace.id);
		}
	}
	closeCurrent();
	return { chunks, oversizedSpans, chunkTraceIds };
}

async function withTimeout<T>(
	label: string,
	operation: Promise<T> | undefined,
	timeoutMs: number,
	onTimeout: () => void,
) {
	if (!operation) return undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					onTimeout();
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the observation ids the server reports for a trace through the
 * supported v2 observations endpoint. `undefined` means the check could not
 * produce an answer (endpoint missing, HTTP error, timeout).
 */
async function serverObservationIds(
	client: LangfuseClient,
	traceId: string,
	expectedCount: number,
	timeoutMs: number,
): Promise<Set<string> | undefined> {
	const observationsApi = client.api?.observations;
	if (!observationsApi?.getMany) return undefined;
	const ids = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_VISIBILITY_PAGES; page += 1) {
		const controller = new AbortController();
		try {
			const response = await withTimeout(
				"Trace visibility check",
				observationsApi.getMany(
					{
						traceId,
						fields: "core",
						limit: 1000,
						...(cursor ? { cursor } : {}),
					},
					{
						timeoutInSeconds: Math.max(timeoutMs / 1000, 0.001),
						maxRetries: 0,
						abortSignal: controller.signal,
					},
				),
				timeoutMs,
				() => controller.abort(),
			);
			for (const observation of response?.data ?? []) {
				if (typeof observation?.id === "string") ids.add(observation.id);
			}
			if (ids.size >= expectedCount) return ids;
			cursor = response?.meta?.cursor;
			if (!cursor) return ids;
		} catch {
			return undefined;
		}
	}
	return ids;
}

/**
 * A trace only counts as delivered when every recorded observation is
 * confirmed on the server through the v2 observations endpoint. Existence of
 * the trace row alone is not enough: the exporter can split one trace across
 * batches and reject some of them. A failed or unavailable check is reported
 * as unconfirmed so the replay path re-sends with stable identities instead
 * of silently skipping; replays are idempotent because they carry the
 * original trace and span ids.
 */
async function traceIsCompleteOnServer(
	deps: RestFallbackDeps,
	trace: RestFallbackTrace,
	options: {
		requestTimeoutMs: number;
		visibilityTimeoutMs: number;
		pollIntervalMs: number;
	},
) {
	if (!deps.client.api?.observations?.getMany) {
		// The check cannot run at all; polling would only stall the drain.
		return false;
	}
	const expected = trace.observations.map((observation) => observation.id);
	const deadline = Date.now() + options.visibilityTimeoutMs;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		const serverIds = await serverObservationIds(
			deps.client,
			trace.id,
			expected.length,
			Math.min(options.requestTimeoutMs, remaining),
		);
		if (serverIds !== undefined) {
			if (expected.every((id) => serverIds.has(id))) return true;
			// Reachable but not yet complete: keep polling, the export may still
			// be settling server-side. A persistent gap is replayed after the
			// deadline.
		}
		const sleepMs = Math.min(options.pollIntervalMs, deadline - Date.now());
		if (sleepMs <= 0) break;
		await delay(sleepMs);
	}
	return false;
}

function boundedDiagnostic(value: unknown, maxChars = 500) {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			// JSON.stringify returns undefined for undefined, functions, and symbols.
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = String(value);
		}
	}
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > maxChars
		? `${singleLine.slice(0, maxChars - 1)}…`
		: singleLine;
}

function fallbackFailureMessage(reason: unknown) {
	return boundedDiagnostic(reason instanceof Error ? reason.message : reason);
}

function retireTrace(store: RestFallbackStore, trace: RestFallbackTrace) {
	for (const observation of trace.observations) {
		store.observations.delete(observation.id);
	}
	store.traces.delete(trace.id);
}

export interface RestFallbackDrainResult {
	/**
	 * Round diagnostics in reporting order; when joined they form the single
	 * bounded line the runtime error boundary reports for this drain.
	 */
	problems: string[];
	/**
	 * Permanently lost recovery content retired during this round:
	 * attempt-exhausted discards, retention-budget evictions, and traces
	 * retired while carrying undeliverable oversized spans. These survive a
	 * later round that recovers other traces and must be reported at the end
	 * of a teardown even when the final round is clean.
	 */
	terminalLosses: string[];
}

export async function drainCompletedRestFallback(
	store: RestFallbackStore,
	deps: RestFallbackDeps,
	options: {
		requestTimeoutMs: number;
		visibilityTimeoutMs: number;
		pollIntervalMs: number;
	},
): Promise<RestFallbackDrainResult> {
	const result: RestFallbackDrainResult = { problems: [], terminalLosses: [] };
	const { problems, terminalLosses } = result;
	const candidates = [...store.traces.values()].filter(
		(trace) => trace.completed,
	);
	if (candidates.length === 0) return result;
	const built = candidates.map((trace) => ({
		trace,
		spans: buildReplaySpans(trace),
	}));

	const evicted = enforceRetentionBound(store, built);
	if (evicted.length > 0) {
		const message = `REST fallback discarded ${evicted.length} trace(s) beyond the ${maxRetainedFallbackBytes}-byte retention budget: ${boundedEventList(evicted)}`;
		problems.push(message);
		terminalLosses.push(message);
	}
	const retained = built.filter((entry) => store.traces.has(entry.trace.id));
	if (retained.length === 0) {
		return result;
	}

	const checked = await Promise.all(
		retained.map(async (entry) => ({
			entry,
			complete: await traceIsCompleteOnServer(deps, entry.trace, options),
		})),
	);
	for (const { entry, complete } of checked) {
		if (complete) retireTrace(store, entry.trace);
	}
	const replay = checked
		.filter(({ complete }) => !complete)
		.map(({ entry }) => entry);
	if (replay.length === 0) {
		return result;
	}

	const { chunks, oversizedSpans, chunkTraceIds } = buildReplayChunks(replay);
	const results = await Promise.allSettled(
		chunks.map((spans) =>
			withTimeout(
				"REST fallback ingestion",
				deps.transport.sendSpans(spans, options.requestTimeoutMs),
				options.requestTimeoutMs,
				() => {},
			),
		),
	);
	const failedTraceIds = new Set<string>();
	const failures: PromiseRejectedResult[] = [];
	results.forEach((result, index) => {
		if (result.status !== "rejected") return;
		failures.push(result);
		for (const id of chunkTraceIds[index] ?? []) failedTraceIds.add(id);
	});

	// An accepted POST is not proof of delivery: the OTLP exporter reports
	// success even when the response carried partialSuccess rejections, and an
	// ambiguous failure may still have persisted data. Delivery is confirmed
	// only by the authoritative v2 completeness check; anything unconfirmed
	// consumes a retry attempt exactly like a failed chunk.
	const unconfirmed = (
		await Promise.all(
			replay.map(async (entry) => {
				if (failedTraceIds.has(entry.trace.id)) return undefined;
				const confirmed = await traceIsCompleteOnServer(
					deps,
					entry.trace,
					options,
				);
				return confirmed ? undefined : entry;
			}),
		)
	).filter((entry) => entry !== undefined);
	for (const entry of unconfirmed) failedTraceIds.add(entry.trace.id);

	const sentTraceIds = new Set<string>();
	for (const ids of chunkTraceIds) {
		for (const id of ids) sentTraceIds.add(id);
	}

	if (failures.length > 0) {
		const reasons = Array.from(
			new Set(
				failures.map((failure) => fallbackFailureMessage(failure.reason)),
			),
		);
		// Cap the joined reasons so one terminal line stays constant-bounded even
		// when every chunk fails for a different reason.
		const shown = reasons.slice(0, MAX_REPORTED_FAILURE_REASONS);
		const omitted = reasons.length - shown.length;
		problems.push(
			`REST fallback ingestion failed for ${failures.length}/${chunks.length} batch(es): ${shown.join("; ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`,
		);
	}
	const unconfirmedSent = unconfirmed.filter((entry) =>
		sentTraceIds.has(entry.trace.id),
	);
	const unconfirmedUndeliverable = unconfirmed.filter(
		(entry) => !sentTraceIds.has(entry.trace.id),
	);
	if (unconfirmedSent.length > 0) {
		problems.push(
			`REST fallback replay for ${unconfirmedSent.length} trace(s) was sent but not confirmed by the observations API: ${boundedEventList(unconfirmedSent.map((entry) => entry.trace.id))}`,
		);
	}
	if (unconfirmedUndeliverable.length > 0) {
		problems.push(
			`REST fallback replay for ${unconfirmedUndeliverable.length} trace(s) could not be delivered because no sendable span remained: ${boundedEventList(unconfirmedUndeliverable.map((entry) => entry.trace.id))}`,
		);
	}
	if (oversizedSpans.length > 0) {
		problems.push(
			`REST fallback ingestion dropped ${oversizedSpans.length} oversized span(s) beyond the ${MAX_REST_BATCH_BYTES}-byte limit: ${boundedEventList(oversizedSpans.map((span) => span.label))}`,
		);
	}

	// Settle every replayed trace: confirmed traces retire, failed or
	// unconfirmed traces consume one attempt and are either kept for a later
	// drain or discarded with an explicit loss diagnostic once the retry
	// budget is spent.
	// A trace whose spans could never be sent still consumes attempts as
	// unconfirmed and ends in the exhaustion discard below; the oversized
	// listing in this round's problems names exactly what no request carried.
	const exhausted: string[] = [];
	let keptForRetry = 0;
	for (const { trace } of replay) {
		if (!failedTraceIds.has(trace.id)) {
			retireTrace(store, trace);
			continue;
		}
		trace.attempts += 1;
		if (trace.attempts >= MAX_FALLBACK_ATTEMPTS) {
			exhausted.push(trace.id);
			retireTrace(store, trace);
		} else {
			keptForRetry += 1;
		}
	}
	if (keptForRetry > 0) {
		problems.push(`retaining ${keptForRetry} trace(s) for a later drain`);
	}
	if (exhausted.length > 0) {
		const message = `REST fallback discarded ${exhausted.length} trace(s) after ${MAX_FALLBACK_ATTEMPTS} failed attempts: ${boundedEventList(exhausted)}`;
		problems.push(message);
		terminalLosses.push(message);
	}
	return result;
}
