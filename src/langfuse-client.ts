import { randomUUID } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
	type LangfuseObservation,
	type PropagateAttributesParams,
	propagateAttributes,
	setLangfuseTracerProvider,
	startObservation,
} from "@langfuse/tracing";
import { context, trace as otelTrace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { Config } from "./config.js";
import { createOtlpExporter, OtlpExportError } from "./otlp-export.js";
import {
	type PayloadPolicyConfig,
	shapeLangfuseObservationBody,
	shapeLangfuseTraceBody,
} from "./payload-policy.js";
import { sanitizeForTelemetry } from "./redaction.js";
import {
	getLastRuntimeError,
	recordRuntimeError,
} from "./runtime-diagnostics.js";

export type { RuntimeError } from "./runtime-diagnostics.js";
// Compatibility re-exports: the runtime error boundary lives in
// runtime-diagnostics.ts and feeds the Pi UI subscription; existing callers
// import it from here.
export { getLastRuntimeError, recordRuntimeError };

type LangfuseMetadata = Record<string, unknown>;

type TraceUpdateBody = {
	id?: string | null;
	name?: string;
	metadata?: LangfuseMetadata;
	output?: unknown;
	input?: unknown;
	sessionId?: string;
	userId?: string;
	tags?: string[];
	release?: string;
	version?: string;
	environment?: string;
	public?: boolean;
};

type ObservationBody = {
	metadata?: LangfuseMetadata;
	isError?: boolean;
	output?: unknown;
	input?: unknown;
	usage?: unknown;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	model?: string;
	statusMessage?: string;
	version?: string;
	modelParameters?: Record<string, string | number>;
	completionStartTime?: Date;
};

export interface LangfuseTrace {
	readonly id: string;
	update(body?: TraceUpdateBody): void;
	setTraceIO?(body: { input?: unknown; output?: unknown }): void;
	end?(body?: ObservationBody): void;
}

export interface LangfuseSpan {
	readonly id: string;
	readonly traceId: string;
	update?(body: ObservationBody): void;
	end(body?: ObservationBody): void;
}

export interface LangfuseGeneration {
	readonly id: string;
	readonly traceId: string;
	update?(body: ObservationBody): void;
	end(body?: ObservationBody): void;
}

export interface LangfuseRuntime {
	trace(body?: {
		id?: string | null;
		name: string;
		metadata?: LangfuseMetadata;
		input?: unknown;
		output?: unknown;
		sessionId?: string;
		userId?: string;
		tags?: string[];
		release?: string;
		version?: string;
		environment?: string;
		public?: boolean;
	}): LangfuseTrace;
	span(body: {
		name: string;
		traceId: string;
		parentObservationId?: string;
		metadata?: LangfuseMetadata;
		input?: unknown;
		output?: unknown;
		statusMessage?: string;
	}): LangfuseSpan;
	generation(body: {
		name: string;
		traceId: string;
		parentObservationId?: string;
		metadata?: LangfuseMetadata;
		input?: unknown;
		output?: unknown;
		usage?: unknown;
		usageDetails?: Record<string, number>;
		model?: string;
		costDetails?: Record<string, number>;
		version?: string;
		modelParameters?: Record<string, string | number>;
	}): LangfuseGeneration;
	score(body: {
		name: string;
		value: number;
		traceId?: string;
		observationId?: string;
		sessionId?: string;
		comment?: string;
		dataType?: "NUMERIC" | "BOOLEAN";
	}): void;
	withContext<T>(
		observation: LangfuseSpan | LangfuseGeneration,
		fn: () => T,
	): T;
}

interface VendorObservation {
	readonly id: string;
	readonly traceId: string;
	readonly otelSpan?: unknown;
	update(attributes: Record<string, unknown>): VendorObservation;
	end(): void;
	setTraceAsPublic(): void;
	setTraceIO(attributes: {
		input?: unknown;
		output?: unknown;
	}): VendorObservation;
	startObservation(
		name: string,
		attributes?: Record<string, unknown>,
		options?: { asType?: string },
	): VendorObservation;
}

interface RuntimeTrace {
	readonly root: VendorObservation;
	readonly initialBody: TraceUpdateBody;
	lastUpdate: TraceUpdateBody;
	ended: boolean;
	readonly handle: LangfuseTrace;
}

interface RuntimeState {
	readonly configKey: string;
	readonly idGenerator: RuntimeIdGenerator;
	readonly tracerProvider: BasicTracerProvider;
	readonly processor: LangfuseSpanProcessor;
	readonly scoreClient: LangfuseClient;
	readonly observations: Map<string, VendorObservation>;
	readonly traces: Map<string, RuntimeTrace>;
	/** In-flight direct score deliveries, awaited on flush and shutdown. */
	readonly pendingScores: Set<Promise<void>>;
}

class RuntimeIdGenerator {
	private requestedTraceId: string | undefined;

	requestTraceId(value: string | undefined) {
		this.requestedTraceId = /^[0-9a-f]{32}$/i.test(value || "")
			? value?.toLowerCase()
			: undefined;
	}

	generateTraceId() {
		const traceId = this.requestedTraceId;
		this.requestedTraceId = undefined;
		return traceId || randomUUID().replaceAll("-", "");
	}

	generateSpanId() {
		return randomUUID().replaceAll("-", "").slice(0, 16);
	}
}

let runtime: RuntimeState | null = null;
let runtimeTransition: Promise<void> = Promise.resolve();
let registeredContextManager: AsyncHooksContextManager | undefined;
// Deadlines belong to HTTP requests, not the operations awaiting them.
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const DEFAULT_SCORE_REQUEST_TIMEOUT_MS = 2_000;
let exportTimeoutMs = DEFAULT_EXPORT_TIMEOUT_MS;
let scoreRequestTimeoutMs = DEFAULT_SCORE_REQUEST_TIMEOUT_MS;

/** Override HTTP request deadlines in isolated tests; return their restoration. */
export function setRuntimeTimeoutsForTest(timeouts: {
	exportMs: number;
	scoreMs?: number;
}) {
	const previous = { exportTimeoutMs, scoreRequestTimeoutMs };
	exportTimeoutMs = timeouts.exportMs;
	scoreRequestTimeoutMs = timeouts.scoreMs ?? timeouts.exportMs;
	return () => {
		exportTimeoutMs = previous.exportTimeoutMs;
		scoreRequestTimeoutMs = previous.scoreRequestTimeoutMs;
	};
}

function runtimeErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** Records one contextual runtime diagnostic; the runtime never writes to console. */
function recordRuntimeFailure(label: string, error: unknown) {
	// The provider aggregates processor failures; the exporter has already
	// reported its own errors, including failures from background batches.
	if (error instanceof OtlpExportError) return;
	if (Array.isArray(error)) {
		for (const cause of error) recordRuntimeFailure(label, cause);
		return;
	}
	recordRuntimeError(`Langfuse: ${label}: ${runtimeErrorMessage(error)}`);
}

function recordScoreFailure(error: unknown) {
	// Langfuse API exception messages embed response bodies, which may echo
	// private score content. Report only the HTTP status, never that message.
	const status =
		error && typeof error === "object" && "statusCode" in error
			? error.statusCode
			: undefined;
	recordRuntimeError(
		`Failed to send Langfuse score${typeof status === "number" ? ` (HTTP ${status})` : ": request failed"}`,
	);
}

async function sendScore(
	scoresApi: LangfuseClient["api"]["scores"],
	body: Parameters<LangfuseClient["api"]["scores"]["create"]>[0],
): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), scoreRequestTimeoutMs);
	try {
		await scoresApi.create(body, {
			// SDK 5.11.1 clears its own timer at response headers. The caller
			// signal stays active through the body read. Keep the SDK header
			// budget equal: it cannot be disabled via public options and its
			// timer can survive a rejected fetch until the deadline expires.
			timeoutInSeconds: Math.max(scoreRequestTimeoutMs / 1000, 0.001),
			maxRetries: 0,
			abortSignal: controller.signal,
		});
	} catch (error) {
		recordScoreFailure(error);
	} finally {
		clearTimeout(timer);
	}
}

function shapeBody<T>(
	config: PayloadPolicyConfig,
	body: T,
	shape: (
		config: PayloadPolicyConfig,
		body: Record<string, unknown>,
	) => Record<string, unknown>,
): T {
	if (!body || typeof body !== "object") return body;
	return shape(config, body as Record<string, unknown>) as T;
}

function stringPropagationMetadata(
	metadata: LangfuseMetadata | undefined,
): Record<string, string> | undefined {
	if (!metadata) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		)
			continue;
		const text = String(value);
		if (text.length <= 200) result[key] = text;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function observationAttributes(body: ObservationBody | undefined) {
	if (!body) return {};
	const attributes: Record<string, unknown> = {};
	for (const key of [
		"input",
		"output",
		"metadata",
		"statusMessage",
		"version",
		"model",
		"modelParameters",
		"usageDetails",
		"costDetails",
		"completionStartTime",
	]) {
		const value = body[key as keyof ObservationBody];
		if (value !== undefined) attributes[key] = value;
	}
	if (body.usage && typeof body.usage === "object") {
		attributes.usageDetails = {
			...(attributes.usageDetails as Record<string, number> | undefined),
			...(body.usage as Record<string, number>),
		};
	}
	if (body.isError) attributes.level = "ERROR";
	return attributes;
}

function traceAttributes(body: TraceUpdateBody | undefined) {
	if (!body) return {};
	return observationAttributes(body);
}

/**
 * Publishing is one-way on the server, so only an explicit true sets the
 * OTel public attribute; false or omitted values never attempt to unpublish.
 */
function applyPublicTraceFlag(
	vendorRoot: VendorObservation,
	body: TraceUpdateBody | undefined,
) {
	if (body?.public === true) vendorRoot.setTraceAsPublic();
}

function traceIOAttributes(body: TraceUpdateBody | undefined): {
	input?: unknown;
	output?: unknown;
} {
	if (!body) return {};
	return {
		input: body.input,
		output: body.output,
	};
}

function mergeTraceBody(
	base: TraceUpdateBody,
	next: TraceUpdateBody,
): TraceUpdateBody {
	return {
		...base,
		...next,
		metadata: {
			...base.metadata,
			...next.metadata,
		},
	};
}

function propagationAttributes(
	body: TraceUpdateBody,
): PropagateAttributesParams {
	const attributes: PropagateAttributesParams = {};
	if (body.name !== undefined) attributes.traceName = body.name;
	if (body.sessionId !== undefined) attributes.sessionId = body.sessionId;
	if (body.userId !== undefined) attributes.userId = body.userId;
	if (body.tags !== undefined) attributes.tags = body.tags;
	if (body.version !== undefined) attributes.version = body.version;
	const metadata = stringPropagationMetadata(body.metadata);
	if (metadata !== undefined) attributes.metadata = metadata;
	return attributes;
}

function runtimeKey(config: Config) {
	return JSON.stringify({
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		host: config.host,
		release: config.release,
		environment: config.environment,
	});
}

function ensureOtelContextManager() {
	if (registeredContextManager) return true;
	const manager = new AsyncHooksContextManager().enable();
	if (context.setGlobalContextManager(manager)) {
		registeredContextManager = manager;
		return true;
	}
	manager.disable();
	return false;
}

function asVendorObservation(value: LangfuseObservation): VendorObservation {
	return value as unknown as VendorObservation;
}

function startVendorObservation(
	name: string,
	attributes: Record<string, unknown>,
	options?: { asType?: string },
) {
	return asVendorObservation(
		(
			startObservation as unknown as (
				name: string,
				attributes: Record<string, unknown>,
				options?: { asType?: string },
			) => LangfuseObservation
		)(name, attributes, options),
	);
}

function startChildObservation(
	parent: VendorObservation,
	name: string,
	attributes: Record<string, unknown>,
	options?: { asType?: string },
) {
	return parent.startObservation(name, attributes, options);
}

function createTrace(
	rt: RuntimeState,
	config: Config,
	body: Parameters<LangfuseRuntime["trace"]>[0],
): LangfuseTrace {
	const shaped = shapeBody(config, body, shapeLangfuseTraceBody) as NonNullable<
		Parameters<LangfuseRuntime["trace"]>[0]
	>;
	rt.idGenerator.requestTraceId(shaped.id || undefined);
	// Each Pi prompt is an independent trace: strip any ambient OTel parent so
	// the root cannot inherit an unrelated active trace id and an unsampled
	// external parent cannot suppress export (ParentBasedSampler).
	const root = context.with(otelTrace.deleteSpan(context.active()), () =>
		propagateAttributes(propagationAttributes(shaped), () =>
			startVendorObservation(
				"agent.prompt",
				observationAttributes(shaped as ObservationBody),
			),
		),
	);
	const vendorRoot = root as unknown as VendorObservation;
	applyPublicTraceFlag(vendorRoot, shaped);
	const initialTraceIO = traceIOAttributes(shaped);
	if (
		initialTraceIO.input !== undefined ||
		initialTraceIO.output !== undefined
	) {
		vendorRoot.setTraceIO(initialTraceIO);
	}
	const runtimeTrace: RuntimeTrace = {
		root: vendorRoot,
		initialBody: shaped,
		lastUpdate: shaped,
		ended: false,
		handle: {
			get id() {
				return vendorRoot.traceId;
			},
			update(updateBody) {
				const shapedUpdate = shapeBody(
					config,
					updateBody,
					shapeLangfuseTraceBody,
				) as TraceUpdateBody | undefined;
				if (!shapedUpdate) return;
				runtimeTrace.lastUpdate = mergeTraceBody(
					runtimeTrace.lastUpdate,
					shapedUpdate,
				);
				applyPublicTraceFlag(vendorRoot, shapedUpdate);
				runWithVendorContext(vendorRoot, () => {
					propagateAttributes(
						propagationAttributes(runtimeTrace.lastUpdate),
						() => {
							vendorRoot.update({
								...runtimeTrace.lastUpdate,
								...traceAttributes(runtimeTrace.lastUpdate),
							});
							const traceIO = traceIOAttributes(runtimeTrace.lastUpdate);
							if (traceIO.input !== undefined || traceIO.output !== undefined) {
								vendorRoot.setTraceIO(traceIO);
							}
						},
					);
				});
			},
			setTraceIO(io) {
				const shapedIO = shapeBody(config, io, shapeLangfuseTraceBody) as {
					input?: unknown;
					output?: unknown;
				};
				runtimeTrace.lastUpdate = mergeTraceBody(
					runtimeTrace.lastUpdate,
					shapedIO,
				);
				runWithVendorContext(vendorRoot, () => {
					vendorRoot.setTraceIO(shapedIO);
				});
			},
			end(endBody) {
				if (runtimeTrace.ended) return;
				const shapedEnd = endBody
					? (shapeBody(config, endBody, (policyConfig, value) =>
							shapeLangfuseObservationBody(policyConfig, "agent.prompt", value),
						) as ObservationBody)
					: undefined;
				if (shapedEnd) {
					vendorRoot.update(observationAttributes(shapedEnd));
				}
				runtimeTrace.ended = true;
				vendorRoot.end();
				removeObservation(rt, vendorRoot);
			},
		},
	};
	rt.observations.set(vendorRoot.id, vendorRoot);
	rt.traces.set(vendorRoot.traceId, runtimeTrace);
	return runtimeTrace.handle;
}

function removeObservation(rt: RuntimeState, observation: VendorObservation) {
	rt.observations.delete(observation.id);
	for (const [traceId, trace] of rt.traces) {
		if (trace.root.id === observation.id) rt.traces.delete(traceId);
	}
}

function finalizeOpenTraces(rt: RuntimeState) {
	for (const runtimeTrace of rt.traces.values()) {
		if (runtimeTrace.ended) continue;
		runtimeTrace.ended = true;
		const root = runtimeTrace.root;
		try {
			root.end();
		} catch (error) {
			recordRuntimeFailure(
				"Failed to end open prompt root during shutdown",
				error,
			);
		}
	}
}

function wrapObservation<T extends LangfuseSpan | LangfuseGeneration>(
	rt: RuntimeState,
	config: Config,
	observation: VendorObservation,
	name: string,
): T {
	let ended = false;
	const rootTrace = Array.from(rt.traces.values()).find(
		(trace) => trace.root.id === observation.id,
	);
	const update = (body?: ObservationBody) => {
		if (!body || ended) return;
		const shaped = shapeBody(config, body, (policyConfig, value) =>
			shapeLangfuseObservationBody(policyConfig, name, value),
		) as ObservationBody;
		const effective = rootTrace
			? {
					...rootTrace.lastUpdate,
					...shaped,
					name: rootTrace.initialBody.name,
					metadata: {
						...rootTrace.lastUpdate.metadata,
						...shaped.metadata,
					},
				}
			: shaped;
		if (rootTrace) {
			rootTrace.lastUpdate = effective as TraceUpdateBody;
			applyPublicTraceFlag(rootTrace.root, effective as TraceUpdateBody);
		}
		observation.update(observationAttributes(effective));
	};
	const wrapped = {
		id: observation.id,
		traceId: observation.traceId,
		update,
		end(body?: ObservationBody) {
			if (ended) return;
			update(body);
			ended = true;
			if (rootTrace) {
				rootTrace.ended = true;
			}
			observation.end();
			removeObservation(rt, observation);
		},
	};
	rt.observations.set(observation.id, observation);
	return wrapped as T;
}

function createObservation(
	rt: RuntimeState,
	config: Config,
	body: {
		name: string;
		traceId: string;
		parentObservationId?: string;
		[key: string]: unknown;
	},
	asType: "span" | "generation",
) {
	const shaped = shapeBody(config, body, (policyConfig, value) =>
		shapeLangfuseObservationBody(policyConfig, body.name, value),
	) as typeof body;
	const traceRoot = rt.traces.get(shaped.traceId)?.root;
	const parent = shaped.parentObservationId
		? (rt.observations.get(shaped.parentObservationId) ?? traceRoot)
		: traceRoot;
	if (!parent) {
		throw new Error(
			`Langfuse: cannot create observation "${shaped.name}" for trace ${shaped.traceId}: the trace is not registered`,
		);
	}
	const runtimeTrace = rt.traces.get(shaped.traceId);
	const identity = runtimeTrace
		? propagationAttributes(runtimeTrace.lastUpdate)
		: undefined;
	const startChild = () =>
		startChildObservation(
			parent,
			shaped.name,
			observationAttributes(shaped as ObservationBody),
			{ asType },
		);
	const observation = identity
		? runWithVendorContext(parent, () =>
				propagateAttributes(identity, startChild),
			)
		: startChild();
	rt.observations.set(observation.id, observation);
	return observation;
}

function runWithVendorContext<T>(
	observation: VendorObservation,
	fn: () => T,
): T {
	const span = observation.otelSpan;
	if (!span || typeof span !== "object") return fn();
	return context.with(
		otelTrace.setSpan(
			context.active(),
			span as Parameters<typeof otelTrace.setSpan>[1],
		),
		fn,
	);
}

function wrapRuntime(rt: RuntimeState, config: Config): LangfuseRuntime {
	return {
		trace(body) {
			return createTrace(rt, config, body);
		},
		span(body) {
			if (body.name === "agent.prompt") {
				const trace = rt.traces.get(body.traceId);
				if (trace) {
					const wrapped = wrapObservation<LangfuseSpan>(
						rt,
						config,
						trace.root,
						body.name,
					);
					wrapped.update?.(body);
					return wrapped;
				}
			}
			return wrapObservation<LangfuseSpan>(
				rt,
				config,
				createObservation(rt, config, body, "span"),
				body.name,
			);
		},
		generation(body) {
			return wrapObservation<LangfuseGeneration>(
				rt,
				config,
				createObservation(rt, config, body, "generation"),
				body.name,
			);
		},
		score(body) {
			try {
				// The SDK's queued score.create flushes through the legacy
				// /api/public/ingestion endpoint and swallows delivery failures,
				// so scores go directly through the supported scores endpoint and
				// every delivery is tracked until it settles.
				const scoresApi = rt.scoreClient.api?.scores;
				if (!scoresApi?.create) {
					throw new Error("Langfuse: score API is unavailable");
				}
				// Mirror the SDK's score precedence: configuration wins, the
				// LANGFUSE_TRACING_ENVIRONMENT variable fills the rest, matching
				// the environment the span processor stamps on spans.
				const shaped = sanitizeForTelemetry(config, {
					environment:
						config.environment ||
						process.env.LANGFUSE_TRACING_ENVIRONMENT ||
						undefined,
					...body,
				}) as Parameters<typeof scoresApi.create>[0];
				const delivery = sendScore(scoresApi, shaped);
				rt.pendingScores.add(delivery);
				void delivery.finally(() => {
					rt.pendingScores.delete(delivery);
				});
			} catch (error) {
				recordScoreFailure(error);
			}
		},
		withContext(observation, fn) {
			const raw = rt.observations.get(observation.id);
			return raw ? runWithVendorContext(raw, fn) : fn();
		},
	};
}

function createRuntime(config: Config): RuntimeState {
	ensureOtelContextManager();
	const idGenerator = new RuntimeIdGenerator();
	// The injected exporter owns one-way delivery: bounded native-fetch retry
	// and partial-rejection reporting through onError. There is no read-back,
	// no retained replay. Each send aborts at its own deadline; lifecycle
	// operations await actual completion instead of racing another timer.
	const exporter = createOtlpExporter({
		host: config.host,
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		timeoutMs: exportTimeoutMs,
		onError: (message) => recordRuntimeError(message),
	});
	const processor = new LangfuseSpanProcessor({
		// Immediate mode exposes every ended span to our bounded exporter and
		// awaits active sends on flush. The SDK batch mode silently drops a full
		// queue and its forceFlush does not await already-started batches.
		exportMode: "immediate",
		// SDK 5.11.1 media PUTs have no cancellation API. Keep telemetry in
		// the bounded OTLP path; revisit only when uploads are cancellable.
		mediaUploadEnabled: false,
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.host,
		release: config.release || undefined,
		environment: config.environment || undefined,
		exporter,
	});
	const tracerProvider = new BasicTracerProvider({
		spanProcessors: [processor],
		idGenerator,
	});
	setLangfuseTracerProvider(tracerProvider);
	return {
		configKey: runtimeKey(config),
		idGenerator,
		tracerProvider,
		processor,
		scoreClient: new LangfuseClient({
			publicKey: config.publicKey,
			secretKey: config.secretKey,
			baseUrl: config.host,
		}),
		observations: new Map(),
		traces: new Map(),
		pendingScores: new Set(),
	};
}

/** Drain the owned processor directly, without the provider's generic timer. */
async function flushRuntime(rt: RuntimeState) {
	try {
		// No media uploads, async masks, or async resource attributes are
		// configured. The remaining I/O is owned by the bounded exporter.
		await rt.processor.forceFlush();
	} catch (error) {
		recordRuntimeFailure("Failed to flush OpenTelemetry spans", error);
	}
	await Promise.all(rt.pendingScores);
}

/** End open roots, await request completion, then dispose the SDK resources. */
async function shutdownRuntime(rt: RuntimeState) {
	finalizeOpenTraces(rt);
	await flushRuntime(rt);
	try {
		// We send scores through api.scores, so the SDK queue is empty.
		await rt.scoreClient.shutdown();
	} catch (error) {
		recordRuntimeFailure("Failed to shut down Langfuse client", error);
	}
	try {
		await rt.tracerProvider.shutdown();
	} catch (error) {
		recordRuntimeFailure("Failed to shut down OpenTelemetry", error);
	}
	setLangfuseTracerProvider(null);
}

async function withRuntimeTransition<T>(
	operation: () => Promise<T>,
): Promise<T> {
	const previous = runtimeTransition;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	runtimeTransition = previous.then(() => gate);
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

export function flushClient() {
	return withRuntimeTransition(async () => {
		if (runtime) await flushRuntime(runtime);
	});
}

export function reconfigureRuntime() {
	return withRuntimeTransition(async () => {
		if (!runtime || runtime.observations.size > 0 || runtime.traces.size > 0)
			return;
		const current = runtime;
		runtime = null;
		await shutdownRuntime(current);
	});
}

export function shutdownClient() {
	return withRuntimeTransition(async () => {
		const current = runtime;
		if (!current) return;
		runtime = null;
		await shutdownRuntime(current);
	});
}

export function getRuntimeRegistrySizeForTest() {
	return {
		traces: runtime?.traces.size ?? 0,
		observations: runtime?.observations.size ?? 0,
	};
}

export function getRuntime(config: Config): Promise<LangfuseRuntime> {
	return withRuntimeTransition(async () => {
		try {
			const key = runtimeKey(config);
			if (runtime && runtime.configKey !== key) {
				if (runtime.observations.size > 0 || runtime.traces.size > 0) {
					// The installed Langfuse SDK binds export credentials to the
					// processor and score client at construction and keeps one global
					// tracer provider, so two differently-configured runtimes cannot
					// be live at once. Wrapping the old runtime with the new config
					// would send the request through the old project's destination.
					throw new Error(
						"Langfuse: a runtime with a different configuration is still active; its open prompts must finish before this configuration can be applied. The request was rejected so telemetry is not routed to the wrong project.",
					);
				}
				const current = runtime;
				runtime = null;
				await shutdownRuntime(current);
			}
			if (!runtime) runtime = createRuntime(config);
			return wrapRuntime(runtime, config);
		} catch (error) {
			recordRuntimeError(error);
			throw error;
		}
	});
}
