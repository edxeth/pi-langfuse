import { randomUUID } from "node:crypto";
import type { LangfuseClient } from "@langfuse/client";

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
	attempted: boolean;
}

export interface RestFallbackStore {
	readonly traces: Map<string, RestFallbackTrace>;
	readonly observations: Map<string, RestFallbackObservation>;
}

type RestIngestionRequest = Parameters<
	LangfuseClient["api"]["ingestion"]["batch"]
>[0];

type RestFallbackEvent = {
	type: "trace-create" | "span-create" | "generation-create";
	id: string;
	timestamp: string;
	body: Record<string, unknown>;
};

const MAX_REST_BATCH_BYTES = 3_500_000;
const MAX_REPORTED_FAILURE_REASONS = 3;
const FALLBACK_METADATA = {
	source: "pi-langfuse",
	fallback: "rest-ingestion",
	reason: "otel-trace-not-visible-after-flush",
};

export function createRestFallbackStore(): RestFallbackStore {
	return {
		traces: new Map(),
		observations: new Map(),
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
		attempted: false,
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

function eventTimestamp(record: {
	endTime?: string;
	startTime?: string;
	timestamp?: string;
}) {
	return (
		record.endTime ??
		record.startTime ??
		record.timestamp ??
		new Date().toISOString()
	);
}

function fallbackTraceEvent(trace: RestFallbackTrace): RestFallbackEvent {
	return {
		type: "trace-create",
		id: randomUUID(),
		timestamp: eventTimestamp(trace),
		body: {
			id: trace.id,
			timestamp: trace.timestamp,
			name: trace.name,
			input: trace.input,
			output: trace.output,
			metadata: trace.metadata,
			sessionId: trace.sessionId,
			userId: trace.userId,
			tags: trace.tags,
			release: trace.release,
			version: trace.version,
			environment: trace.environment,
			public: trace.public,
		},
	};
}

function fallbackObservationEvent(
	observation: RestFallbackObservation,
): RestFallbackEvent {
	const body: Record<string, unknown> = {
		id: observation.id,
		traceId: observation.traceId,
		name: observation.name,
		startTime: observation.startTime,
		parentObservationId: observation.parentObservationId,
		input: observation.input,
		output: observation.output,
		metadata: observation.metadata,
		level: observation.level,
		statusMessage: observation.statusMessage,
	};
	if (observation.completionStartTime) {
		body.completionStartTime = observation.completionStartTime;
	}
	if (observation.endTime) body.endTime = observation.endTime;
	if (observation.type === "GENERATION") {
		body.model = observation.model;
		body.modelParameters = observation.modelParameters;
		body.usageDetails = observation.usageDetails;
		body.costDetails = observation.costDetails;
	}
	return {
		type:
			observation.type === "GENERATION" ? "generation-create" : "span-create",
		id: randomUUID(),
		timestamp: eventTimestamp(observation),
		body,
	};
}

function batchSize(events: RestFallbackEvent[]) {
	return Buffer.byteLength(
		JSON.stringify({ batch: events, metadata: FALLBACK_METADATA }),
		"utf8",
	);
}

function buildBatches(traces: RestFallbackTrace[]) {
	const batches: RestFallbackEvent[][] = [];
	let current: RestFallbackEvent[] = [];
	for (const trace of traces) {
		const events = [
			fallbackTraceEvent(trace),
			...trace.observations.map(fallbackObservationEvent),
		];
		if (
			current.length > 0 &&
			batchSize([...current, ...events]) > MAX_REST_BATCH_BYTES
		) {
			batches.push(current);
			current = [];
		}
		if (batchSize(events) <= MAX_REST_BATCH_BYTES) {
			current.push(...events);
			continue;
		}
		for (const event of events) {
			if (
				current.length > 0 &&
				batchSize([...current, event]) > MAX_REST_BATCH_BYTES
			) {
				batches.push(current);
				current = [];
			}
			current.push(event);
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
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

async function traceIsVisible(
	client: LangfuseClient,
	traceId: string,
	timeoutMs: number,
) {
	const traceApi = client.api?.trace;
	if (!traceApi?.get) return false;
	const controller = new AbortController();
	try {
		const response = await withTimeout(
			"Trace visibility check",
			traceApi.get(traceId, undefined, {
				timeoutInSeconds: Math.max(timeoutMs / 1000, 0.001),
				maxRetries: 0,
				abortSignal: controller.signal,
			}),
			timeoutMs,
			() => controller.abort(),
		);
		return response !== undefined;
	} catch {
		return false;
	}
}

async function waitForTraceVisibility(
	client: LangfuseClient,
	traceId: string,
	options: {
		requestTimeoutMs: number;
		visibilityTimeoutMs: number;
		pollIntervalMs: number;
	},
) {
	const deadline = Date.now() + options.visibilityTimeoutMs;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		if (
			await traceIsVisible(
				client,
				traceId,
				Math.min(options.requestTimeoutMs, remaining),
			)
		)
			return true;
		const sleepMs = Math.min(options.pollIntervalMs, deadline - Date.now());
		if (sleepMs <= 0) break;
		await delay(sleepMs);
	}
	return false;
}

async function sendBatch(
	client: LangfuseClient,
	events: RestFallbackEvent[],
	timeoutMs: number,
) {
	const ingestion = client.api?.ingestion;
	if (!ingestion?.batch) return;
	const request = {
		batch: events,
		metadata: FALLBACK_METADATA,
	} as unknown as RestIngestionRequest;
	const controller = new AbortController();
	const response = await withTimeout(
		"REST fallback ingestion",
		ingestion.batch(request, {
			timeoutInSeconds: Math.max(timeoutMs / 1000, 0.001),
			maxRetries: 0,
			abortSignal: controller.signal,
		}),
		timeoutMs,
		() => controller.abort(),
	);
	const errors = (response as { errors?: unknown[] } | undefined)?.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		throw new Error(
			`REST fallback ingestion reported ${errors.length} error(s); first error: ${ingestionErrorSummary(errors[0])}`,
		);
	}
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

function ingestionErrorSummary(value: unknown) {
	if (!value || typeof value !== "object") return boundedDiagnostic(value);
	const error = value as Record<string, unknown>;
	const details: string[] = [];
	if (typeof error.id === "string") {
		details.push(`id=${boundedDiagnostic(error.id, 120)}`);
	}
	if (typeof error.status === "number") details.push(`status=${error.status}`);
	if (typeof error.message === "string") {
		details.push(`message=${boundedDiagnostic(error.message)}`);
	}
	if (error.error !== undefined) {
		details.push(`error=${boundedDiagnostic(error.error)}`);
	}
	return details.length > 0 ? details.join(", ") : boundedDiagnostic(value);
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

export async function drainCompletedRestFallback(
	store: RestFallbackStore,
	client: LangfuseClient,
	options: {
		requestTimeoutMs: number;
		visibilityTimeoutMs: number;
		pollIntervalMs: number;
	},
) {
	const candidates = [...store.traces.values()].filter(
		(trace) => trace.completed && !trace.attempted,
	);
	if (candidates.length === 0) return;
	for (const trace of candidates) trace.attempted = true;
	try {
		const visible = await Promise.all(
			candidates.map(async (trace) => ({
				trace,
				visible: await waitForTraceVisibility(client, trace.id, options),
			})),
		);
		const missing = visible
			.filter(({ visible: isVisible }) => !isVisible)
			.map(({ trace }) => trace);
		if (missing.length === 0) return;
		const batches = buildBatches(missing);
		const results = await Promise.allSettled(
			batches.map((events) =>
				sendBatch(client, events, options.requestTimeoutMs),
			),
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length > 0) {
			const reasons = Array.from(
				new Set(
					failures.map((failure) => fallbackFailureMessage(failure.reason)),
				),
			);
			// Cap the joined reasons so one terminal line stays constant-bounded even
			// when every batch fails for a different reason.
			const shown = reasons.slice(0, MAX_REPORTED_FAILURE_REASONS);
			const omitted = reasons.length - shown.length;
			throw new Error(
				`REST fallback ingestion failed for ${failures.length}/${batches.length} batch(es): ${shown.join("; ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`,
			);
		}
	} finally {
		for (const trace of candidates) retireTrace(store, trace);
	}
}
