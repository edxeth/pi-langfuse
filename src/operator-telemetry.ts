import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

export const ISOLATED_TEST_TRACE_NAME = "pi-langfuse-test";

interface IngestionEvent {
	type: "trace-create" | "span-create";
	id: string;
	timestamp: string;
	body: Record<string, unknown>;
}

function id() {
	return randomUUID().replaceAll("-", "");
}

function authorizationHeader(config: Config) {
	return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

export async function sendIsolatedTestTrace(
	config: Config,
	signal: AbortSignal,
) {
	const traceId = id();
	const observationId = id();
	const timestamp = new Date().toISOString();
	const metadata = {
		command: "langfuse-test",
		isolated: true,
	};
	const batch: IngestionEvent[] = [
		{
			type: "trace-create",
			id: randomUUID(),
			timestamp,
			body: {
				id: traceId,
				name: ISOLATED_TEST_TRACE_NAME,
				timestamp,
				metadata,
			},
		},
		{
			type: "span-create",
			id: randomUUID(),
			timestamp,
			body: {
				id: observationId,
				traceId,
				name: "agent.prompt",
				startTime: timestamp,
				endTime: timestamp,
				metadata,
				output: { status: "ok" },
			},
		},
	];
	const response = await fetch(
		`${config.host.replace(/\/$/, "")}/api/public/ingestion`,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: authorizationHeader(config),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				batch,
				metadata: {
					source: "pi-langfuse",
					command: "langfuse-test",
				},
			}),
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`isolated test trace returned HTTP ${response.status}`);
	}
	const responseBody = await response.text();
	if (responseBody.trim()) {
		let parsed: { errors?: unknown } | undefined;
		try {
			parsed = JSON.parse(responseBody) as { errors?: unknown };
		} catch {
			parsed = undefined;
		}
		if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
			throw new Error("isolated test trace ingestion reported errors");
		}
	}
	return { traceId };
}
