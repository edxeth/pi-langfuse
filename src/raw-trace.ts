import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type RedactionConfig, sanitizeForTelemetry } from "./redaction.js";

interface RawTraceConfig extends RedactionConfig {
	rawTraceEnabled: boolean;
	rawTraceDir: string;
}

interface RawTraceBaseRecord {
	type: string;
	timestamp: string;
	sessionId?: string;
	sessionFile?: string;
	traceId?: string;
	turnIndex?: number;
	provider?: string;
	model?: string;
	runtime?: string;
}

type RawTraceRecord = RawTraceBaseRecord & Record<string, unknown>;

export function defaultRawTraceDir() {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"langfuse",
		"raw-traces",
	);
}

export function rawTracePathForSession(
	sessionFile: string | undefined,
	rawTraceDir = defaultRawTraceDir(),
) {
	if (!sessionFile) return undefined;
	const marker = "/sessions/";
	const index = sessionFile.indexOf(marker);
	if (index === -1)
		return join(rawTraceDir, "--unknown--", basename(sessionFile));
	const relativePath = sessionFile.slice(index + marker.length);
	return join(
		rawTraceDir,
		relativePath.includes("/")
			? relativePath
			: join("--unknown--", relativePath),
	);
}

function jsonReplacer(_key: string, value: unknown) {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (typeof value === "function")
		return `[function ${value.name || "anonymous"}]`;
	return value;
}

export function appendRawTrace(
	config: RawTraceConfig,
	sessionFile: string | undefined,
	record: RawTraceRecord,
) {
	if (!config.rawTraceEnabled || !sessionFile) return;
	const path = rawTracePathForSession(sessionFile, config.rawTraceDir);
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const sanitizedRecord = sanitizeForTelemetry(config, record);
		appendFileSync(
			path,
			`${JSON.stringify(sanitizedRecord, jsonReplacer)}\n`,
			"utf-8",
		);
	} catch (error) {
		console.warn("📊 Langfuse: Failed to write raw trace", error);
	}
}
