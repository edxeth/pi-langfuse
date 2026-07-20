import { Langfuse } from "langfuse";
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

type ObservationEndBody = {
	metadata?: LangfuseMetadata;
	isError?: boolean;
	output?: unknown;
	usage?: unknown;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	model?: string;
	statusMessage?: string;
};

export interface LangfuseTrace {
	id: string;
	update(body?: TraceUpdateBody): void;
}

export interface LangfuseSpan {
	id: string;
	update?(body: {
		metadata?: LangfuseMetadata;
		input?: unknown;
		output?: unknown;
		statusMessage?: string;
	}): void;
	end(body?: ObservationEndBody): void;
}

export interface LangfuseGeneration {
	id: string;
	update?(body: {
		metadata?: LangfuseMetadata;
		usage?: unknown;
		usageDetails?: Record<string, number>;
		output?: unknown;
		costDetails?: Record<string, number>;
		model?: string;
		statusMessage?: string;
	}): void;
	end(body?: ObservationEndBody): void;
}

interface LangfuseClient {
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
	}): LangfuseGeneration;
	score(body: {
		name: string;
		value: number;
		traceId?: string;
		observationId?: string;
		sessionId?: string;
		comment?: string;
	}): void;
	flushAsync?(): Promise<void>;
	shutdownAsync(): Promise<void>;
}

let client: LangfuseClient | null = null;
let clientConfigKey = "";

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

function wrapTrace(config: Config, trace: LangfuseTrace): LangfuseTrace {
	return {
		id: trace.id,
		update(body) {
			trace.update(shapeBody(config, body, shapeLangfuseTraceBody));
		},
	};
}

function wrapSpan(
	config: Config,
	span: LangfuseSpan,
	name: string,
): LangfuseSpan {
	const shape = (
		policyConfig: PayloadPolicyConfig,
		body: Record<string, unknown>,
	) => shapeLangfuseObservationBody(policyConfig, name, body);
	return {
		id: span.id,
		update(body) {
			span.update?.(shapeBody(config, body, shape));
		},
		end(body) {
			span.end(shapeBody(config, body, shape));
		},
	};
}

function wrapGeneration(
	config: Config,
	generation: LangfuseGeneration,
	name: string,
): LangfuseGeneration {
	const shape = (
		policyConfig: PayloadPolicyConfig,
		body: Record<string, unknown>,
	) => shapeLangfuseObservationBody(policyConfig, name, body);
	return {
		id: generation.id,
		update(body) {
			generation.update?.(shapeBody(config, body, shape));
		},
		end(body) {
			generation.end(shapeBody(config, body, shape));
		},
	};
}

function wrapClient(config: Config, rawClient: LangfuseClient): LangfuseClient {
	return {
		trace(body) {
			return wrapTrace(
				config,
				rawClient.trace(shapeBody(config, body, shapeLangfuseTraceBody)),
			);
		},
		span(body) {
			const shapedBody = shapeBody(config, body, (policyConfig, value) =>
				shapeLangfuseObservationBody(policyConfig, body.name, value),
			);
			return wrapSpan(config, rawClient.span(shapedBody), body.name);
		},
		generation(body) {
			const shapedBody = shapeBody(config, body, (policyConfig, value) =>
				shapeLangfuseObservationBody(policyConfig, body.name, value),
			);
			return wrapGeneration(
				config,
				rawClient.generation(shapedBody),
				body.name,
			);
		},
		score(body) {
			rawClient.score(sanitizeForTelemetry(config, body));
		},
		flushAsync: rawClient.flushAsync?.bind(rawClient),
		shutdownAsync: rawClient.shutdownAsync.bind(rawClient),
	};
}

export async function flushClient() {
	if (client?.flushAsync) {
		await client.flushAsync();
	}
}

export async function shutdownClient() {
	if (client) {
		await client.shutdownAsync();
		client = null;
		clientConfigKey = "";
	}
}

export async function getClient(config: Config): Promise<LangfuseClient> {
	const nextConfigKey = JSON.stringify({
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		host: config.host,
	});

	if (client && clientConfigKey !== nextConfigKey) {
		await shutdownClient();
	}

	if (!client) {
		client = new Langfuse({
			publicKey: config.publicKey,
			secretKey: config.secretKey,
			baseUrl: config.host,
		}) as unknown as LangfuseClient;
		clientConfigKey = nextConfigKey;
	}

	return wrapClient(config, client);
}
