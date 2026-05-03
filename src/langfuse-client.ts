import { Langfuse } from "langfuse";
import type { Config } from "./config.js";
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

export interface LangfuseClient {
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

function sanitizeBody<T>(config: Config, body: T): T {
	return sanitizeForTelemetry(config, body);
}

function wrapTrace(config: Config, trace: LangfuseTrace): LangfuseTrace {
	return {
		id: trace.id,
		update(body) {
			trace.update(sanitizeBody(config, body));
		},
	};
}

function wrapSpan(config: Config, span: LangfuseSpan): LangfuseSpan {
	return {
		id: span.id,
		update(body) {
			span.update?.(sanitizeBody(config, body));
		},
		end(body) {
			span.end(sanitizeBody(config, body));
		},
	};
}

function wrapGeneration(
	config: Config,
	generation: LangfuseGeneration,
): LangfuseGeneration {
	return {
		id: generation.id,
		update(body) {
			generation.update?.(sanitizeBody(config, body));
		},
		end(body) {
			generation.end(sanitizeBody(config, body));
		},
	};
}

function wrapClient(config: Config, rawClient: LangfuseClient): LangfuseClient {
	return {
		trace(body) {
			return wrapTrace(config, rawClient.trace(sanitizeBody(config, body)));
		},
		span(body) {
			return wrapSpan(config, rawClient.span(sanitizeBody(config, body)));
		},
		generation(body) {
			return wrapGeneration(
				config,
				rawClient.generation(sanitizeBody(config, body)),
			);
		},
		score(body) {
			rawClient.score(sanitizeBody(config, body));
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
