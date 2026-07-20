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
import {
	type PayloadPolicyConfig,
	shapeLangfuseObservationBody,
	shapeLangfuseTraceBody,
} from "./payload-policy.js";
import { sanitizeForTelemetry } from "./redaction.js";

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
	readonly scoreClient: LangfuseClient;
	readonly observations: Map<string, VendorObservation>;
	readonly traces: Map<string, RuntimeTrace>;
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

function isBase64DataUri(value: string): boolean {
	return /^data:[^,;]+(?:;[^,;]+)*;base64,[A-Za-z0-9+/=_-]+$/i.test(value);
}

function neutralizeLangfuseMediaPrefix<T>(
	value: T,
	seen = new WeakSet<object>(),
): T {
	if (typeof value === "string") {
		return (
			value.startsWith("data:") && !isBase64DataUri(value)
				? `data\\:${value.slice("data:".length)}`
				: value
		) as T;
	}
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]" as T;
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => neutralizeLangfuseMediaPrefix(item, seen)) as T;
	}

	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		output[key] = neutralizeLangfuseMediaPrefix(item, seen);
	}
	return output as T;
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
	return neutralizeLangfuseMediaPrefix(
		shape(config, body as Record<string, unknown>),
	) as T;
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
	const root = propagateAttributes(propagationAttributes(shaped), () =>
		startVendorObservation(
			"agent.prompt",
			observationAttributes(shaped as ObservationBody),
		),
	);
	const vendorRoot = root as unknown as VendorObservation;
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
				runWithVendorContext(vendorRoot, () => {
					propagateAttributes(
						propagationAttributes(runtimeTrace.lastUpdate),
						() => {
							vendorRoot.update({
								...runtimeTrace.lastUpdate,
								...traceAttributes(runtimeTrace.lastUpdate),
							});
						},
					);
				});
			},
			setTraceIO(io) {
				runWithVendorContext(vendorRoot, () => {
					vendorRoot.setTraceIO(io);
				});
			},
			end(endBody) {
				if (runtimeTrace.ended) return;
				if (endBody) vendorRoot.update(observationAttributes(endBody));
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
					metadata: {
						...rootTrace.lastUpdate.metadata,
						...shaped.metadata,
					},
				}
			: shaped;
		if (rootTrace) {
			rootTrace.lastUpdate = effective as TraceUpdateBody;
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
	const parent = shaped.parentObservationId
		? rt.observations.get(shaped.parentObservationId)
		: rt.traces.get(shaped.traceId)?.root;
	const observation = parent
		? startChildObservation(
				parent,
				shaped.name,
				observationAttributes(shaped as ObservationBody),
				{ asType },
			)
		: startVendorObservation(
				shaped.name,
				observationAttributes(shaped as ObservationBody),
				{ asType },
			);
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
			rt.scoreClient.score.create(sanitizeForTelemetry(config, body));
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
	const processor = new LangfuseSpanProcessor({
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.host,
		release: config.release || undefined,
		environment: config.environment || undefined,
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
		scoreClient: new LangfuseClient({
			publicKey: config.publicKey,
			secretKey: config.secretKey,
			baseUrl: config.host,
		}),
		observations: new Map(),
		traces: new Map(),
	};
}

async function shutdownRuntime(rt: RuntimeState) {
	try {
		await rt.tracerProvider.forceFlush();
	} catch (error) {
		console.warn("📊 Langfuse: Failed to flush OpenTelemetry spans", error);
	}
	try {
		await rt.scoreClient.flush();
	} catch (error) {
		console.warn("📊 Langfuse: Failed to flush Langfuse scores", error);
	}
	try {
		await rt.scoreClient.shutdown();
	} catch (error) {
		console.warn("📊 Langfuse: Failed to shut down Langfuse client", error);
	}
	try {
		await rt.tracerProvider.shutdown();
	} catch (error) {
		console.warn("📊 Langfuse: Failed to shut down OpenTelemetry", error);
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
		if (!runtime) return;
		await runtime.tracerProvider.forceFlush();
		await runtime.scoreClient.flush();
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
		const key = runtimeKey(config);
		if (
			runtime &&
			runtime.configKey !== key &&
			runtime.observations.size === 0 &&
			runtime.traces.size === 0
		) {
			const current = runtime;
			runtime = null;
			await shutdownRuntime(current);
		}
		if (!runtime) runtime = createRuntime(config);
		return wrapRuntime(runtime, config);
	});
}
