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
		let parsed: { partialSuccess?: { message?: unknown } } | undefined;
		try {
			parsed = JSON.parse(responseBody) as {
				partialSuccess?: { message?: unknown };
			};
		} catch {
			parsed = undefined;
		}
		const partialMessage = parsed?.partialSuccess?.message;
		if (typeof partialMessage === "string" && partialMessage.trim()) {
			throw new Error(
				`isolated test trace was rejected: ${partialMessage.trim()}`,
			);
		}
	}
	return { traceId };
}
