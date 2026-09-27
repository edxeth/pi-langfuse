import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

export const ISOLATED_TEST_TRACE_NAME = "pi-langfuse-test";

type OtlpAttributeValue = { stringValue?: string };

type OtlpAttribute = {
	key: string;
	value: OtlpAttributeValue;
};

type OtlpSpan = {
	traceId: string;
	spanId: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttribute[];
};

type OtlpExportRequest = {
	resourceSpans: Array<{
		resource: { attributes: OtlpAttribute[] };
		scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
	}>;
};

function id() {
	return randomUUID().replaceAll("-", "");
}

function attribute(key: string, value: string): OtlpAttribute {
	return { key, value: { stringValue: value } };
}

function unixNano(iso: string) {
	return `${new Date(iso).getTime()}000000`;
}

function authorizationHeader(config: Config) {
	return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

/**
 * Sends one isolated trace through the supported OpenTelemetry ingestion
 * endpoint. The legacy `/api/public/ingestion` route is unavailable on
 * Langfuse server v4, while the OTLP route is shared by v3 and v4, so a pass
 * here means the same transport the extension exports with is reachable and
 * authenticated.
 */
export async function sendIsolatedTestTrace(
	config: Config,
	signal: AbortSignal,
) {
	const traceId = id();
	const spanId = id().slice(0, 16);
	const timestamp = new Date().toISOString();
	const request: OtlpExportRequest = {
		resourceSpans: [
			{
				resource: { attributes: [attribute("service.name", "pi-langfuse")] },
				scopeSpans: [
					{
						scope: { name: "pi-langfuse-connectivity-test" },
						spans: [
							{
								traceId,
								spanId,
								name: ISOLATED_TEST_TRACE_NAME,
								kind: 1,
								startTimeUnixNano: unixNano(timestamp),
								endTimeUnixNano: unixNano(timestamp),
								attributes: [
									attribute("langfuse.trace.name", ISOLATED_TEST_TRACE_NAME),
									attribute("langfuse.trace.metadata.command", "langfuse-test"),
									attribute("langfuse.trace.metadata.isolated", "true"),
									attribute("langfuse.trace.output", "ok"),
								],
							},
						],
					},
				],
			},
		],
	};
	const response = await fetch(
		`${config.host.replace(/\/$/, "")}/api/public/otel/v1/traces`,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: authorizationHeader(config),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`isolated test trace returned HTTP ${response.status}`);
	}
	const responseBody = await response.text();
	if (responseBody.trim()) {
		// The standard OTLP trace response reports partial rejection through
		// rejectedSpans and errorMessage; proto3 JSON may encode the int64
		// rejected count as a string.
		let parsed:
			| {
					partialSuccess?: {
						rejectedSpans?: number | string;
						errorMessage?: unknown;
					};
			  }
			| undefined;
		try {
			parsed = JSON.parse(responseBody) as {
				partialSuccess?: {
					rejectedSpans?: number | string;
					errorMessage?: unknown;
				};
			};
		} catch {
			parsed = undefined;
		}
		const partial = parsed?.partialSuccess;
		const rejected = Number(partial?.rejectedSpans ?? 0);
		if (Number.isFinite(rejected) && rejected > 0) {
			throw new Error(
				`isolated test trace was rejected: server reported ${rejected} rejected span(s)`,
			);
		}
		if (
			typeof partial?.errorMessage === "string" &&
			partial.errorMessage.trim()
		) {
			throw new Error(
				`isolated test trace was rejected: ${partial.errorMessage.trim()}`,
			);
		}
	}
	return { traceId };
}

export interface TraceObservationsPollOptions {
	auth: string;
	baseUrl: string;
	traceId: string;
	expectedNames: string[];
	intervalMs?: number;
	maxAttempts?: number;
}

/**
 * Polls the supported v2 observations endpoint until every expected
 * observation name is queryable for the trace. An HTTP 200 with an empty
 * page means indexing has not caught up, so the poll continues instead of
 * resolving early.
 */
export async function pollForTraceObservations(
	options: TraceObservationsPollOptions,
): Promise<
	Array<{
		id: string;
		name?: string | null;
		type?: string;
		model?: string | null;
		usageDetails?: Record<string, number>;
	}>
> {
	const intervalMs = options.intervalMs ?? 2_000;
	const maxAttempts = options.maxAttempts ?? 10;
	const url = `${options.baseUrl.replace(/\/$/, "")}/api/public/v2/observations?traceId=${encodeURIComponent(options.traceId)}&fields=core,basic,model,usage`;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const response = await fetch(url, {
			headers: {
				Authorization: options.auth,
				"Content-Type": "application/json",
			},
		});
		if (response.ok) {
			const page = (await response.json()) as {
				data?: Array<{
					id: string;
					name?: string | null;
					type?: string;
					model?: string | null;
					usageDetails?: Record<string, number>;
				}>;
			};
			const observations = page.data ?? [];
			if (
				options.expectedNames.every((name) =>
					observations.some((observation) => observation.name === name),
				)
			) {
				return observations;
			}
		}
		if (attempt + 1 < maxAttempts) {
			await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
		}
	}
	throw new Error(
		`observations for trace ${options.traceId} were not queryable after ${maxAttempts} attempt(s)`,
	);
}
