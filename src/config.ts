import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRawTraceDir } from "./raw-trace.js";
import { DEFAULT_SETTINGS, type SettingsValues } from "./settings.js";

export type RawTraceProviderRequestMode = "summary" | "full" | "off";

export interface Config {
	publicKey: string;
	secretKey: string;
	host: string;
	enabled: boolean;
	userId: string;
	defaultTags: string[];
	release: string;
	environment: string;
	traceInputMaxChars: number;
	traceOutputMaxChars: number;
	toolArgsMaxChars: number;
	toolOutputMaxChars: number;
	captureToolProgress: boolean;
	captureMessageUpdates: boolean;
	skipUnpersistedSessions: boolean;
	captureProviderPayload: boolean;
	providerPayloadMaxChars: number;
	redactionEnabled: boolean;
	redactionAdditionalSecrets: string[];
	rawTraceEnabled: boolean;
	rawTraceDir: string;
	rawTraceProviderRequestMode: RawTraceProviderRequestMode;
	localAutostart: boolean;
	localAutostartDir: string;
	localAutostartHealthUrl: string;
	localAutostartTimeoutMs: number;
}

function readConfigJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as Partial<Config>;
	} catch (e) {
		console.warn(`📊 Langfuse: Failed to load ${path}`, e);
		return {};
	}
}

function loadConfigFile(): Partial<Config> {
	return readConfigJson(join(defaultLocalAutostartDir(), "pi-langfuse.json"));
}

function clampNumber(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
) {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(max, Math.max(min, Math.round(numeric)));
}

function defaultAgentDir() {
	return (
		process.env.PI_CODING_AGENT_DIR ||
		join(process.env.HOME || "", ".pi", "agent")
	);
}

function defaultLocalAutostartDir() {
	return join(defaultAgentDir(), "langfuse");
}

function parseList(value: unknown, maxItems: number): string[] {
	if (Array.isArray(value)) {
		return value
			.map((item) => String(item).trim())
			.filter(Boolean)
			.slice(0, maxItems);
	}
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean)
		.slice(0, maxItems);
}

function parseTags(value: unknown): string[] {
	return parseList(value, 20);
}

function parseBooleanEnv(value: string | undefined) {
	if (value === undefined) return undefined;
	if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
	return undefined;
}

function parseProviderRequestMode(
	value: unknown,
): RawTraceProviderRequestMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "summary" ||
		normalized === "full" ||
		normalized === "off"
	) {
		return normalized;
	}
	return undefined;
}

export function resolveConfig(settings: Partial<SettingsValues>): Config {
	const fileConfig = loadConfigFile() as Partial<Config> &
		Record<string, unknown>;
	const host =
		settings["base-url"] ||
		fileConfig.host ||
		process.env.LANGFUSE_BASE_URL ||
		process.env.LANGFUSE_HOST ||
		DEFAULT_SETTINGS["base-url"];
	const envAutostart = process.env.PI_LANGFUSE_AUTOSTART;
	const localAutostart =
		envAutostart === "0"
			? false
			: envAutostart === "1"
				? true
				: ((fileConfig.localAutostart as boolean | undefined) ?? false);
	const envRedaction =
		process.env.PI_LANGFUSE_UNREDACTED === "1"
			? false
			: parseBooleanEnv(process.env.PI_LANGFUSE_REDACTION);
	const redactionEnabled =
		settings["redaction-enabled"] ??
		(fileConfig.redactionEnabled as boolean | undefined) ??
		envRedaction ??
		DEFAULT_SETTINGS["redaction-enabled"];

	return {
		enabled: settings.enabled ?? fileConfig.enabled ?? DEFAULT_SETTINGS.enabled,
		publicKey:
			settings["public-key"] ||
			fileConfig.publicKey ||
			process.env.LANGFUSE_PUBLIC_KEY ||
			"",
		secretKey:
			settings["secret-key"] ||
			fileConfig.secretKey ||
			process.env.LANGFUSE_SECRET_KEY ||
			"",
		host,
		userId:
			settings["user-id"] ||
			String(
				fileConfig.userId ??
					process.env.PI_LANGFUSE_USER_ID ??
					process.env.LANGFUSE_USER_ID ??
					process.env.USER ??
					process.env.LOGNAME ??
					"",
			),
		defaultTags: parseTags(
			settings["default-tags"] ||
				fileConfig.defaultTags ||
				process.env.PI_LANGFUSE_TAGS ||
				"",
		),
		release:
			settings.release ||
			String(
				fileConfig.release ??
					process.env.LANGFUSE_RELEASE ??
					process.env.PI_LANGFUSE_RELEASE ??
					"",
			),
		environment:
			settings.environment ||
			String(
				fileConfig.environment ??
					process.env.LANGFUSE_ENV ??
					process.env.PI_LANGFUSE_ENV ??
					"",
			),
		traceInputMaxChars: clampNumber(
			settings["trace-input-max-chars"] ?? fileConfig.traceInputMaxChars,
			DEFAULT_SETTINGS["trace-input-max-chars"],
			200,
			20_000,
		),
		traceOutputMaxChars: clampNumber(
			settings["trace-output-max-chars"] ?? fileConfig.traceOutputMaxChars,
			DEFAULT_SETTINGS["trace-output-max-chars"],
			200,
			20_000,
		),
		toolArgsMaxChars: clampNumber(
			settings["tool-args-max-chars"] ?? fileConfig.toolArgsMaxChars,
			DEFAULT_SETTINGS["tool-args-max-chars"],
			100,
			10_000,
		),
		toolOutputMaxChars: clampNumber(
			settings["tool-output-max-chars"] ?? fileConfig.toolOutputMaxChars,
			DEFAULT_SETTINGS["tool-output-max-chars"],
			100,
			20_000,
		),
		captureToolProgress:
			settings["capture-tool-progress"] ??
			(fileConfig.captureToolProgress as boolean | undefined) ??
			DEFAULT_SETTINGS["capture-tool-progress"],
		captureMessageUpdates:
			settings["capture-message-updates"] ??
			(fileConfig.captureMessageUpdates as boolean | undefined) ??
			DEFAULT_SETTINGS["capture-message-updates"],
		skipUnpersistedSessions:
			(fileConfig.skipUnpersistedSessions as boolean | undefined) ??
			process.env.PI_LANGFUSE_SKIP_UNPERSISTED !== "0",
		captureProviderPayload:
			(fileConfig.captureProviderPayload as boolean | undefined) ??
			process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD === "1",
		providerPayloadMaxChars: clampNumber(
			fileConfig.providerPayloadMaxChars ??
				process.env.PI_LANGFUSE_PROVIDER_PAYLOAD_MAX_CHARS,
			50_000,
			1_000,
			1_000_000,
		),
		redactionEnabled,
		redactionAdditionalSecrets: parseList(
			fileConfig.redactionAdditionalSecrets ??
				process.env.PI_LANGFUSE_REDACTION_SECRETS,
			100,
		),
		rawTraceEnabled:
			settings["raw-trace-enabled"] ??
			(fileConfig.rawTraceEnabled as boolean | undefined) ??
			parseBooleanEnv(process.env.PI_LANGFUSE_RAW_TRACE) ??
			false,
		rawTraceDir: String(
			settings["raw-trace-dir"] ||
				fileConfig.rawTraceDir ||
				process.env.PI_LANGFUSE_RAW_TRACE_DIR ||
				defaultRawTraceDir(),
		),
		rawTraceProviderRequestMode:
			parseProviderRequestMode(process.env.PI_LANGFUSE_RAW_PROVIDER_REQUEST) ??
			parseProviderRequestMode(fileConfig.rawTraceProviderRequestMode) ??
			"summary",
		localAutostart,
		localAutostartDir: String(
			fileConfig.localAutostartDir ??
				process.env.PI_LANGFUSE_AUTOSTART_DIR ??
				defaultLocalAutostartDir(),
		),
		localAutostartHealthUrl: String(
			fileConfig.localAutostartHealthUrl ??
				process.env.PI_LANGFUSE_AUTOSTART_HEALTH_URL ??
				`${host.replace(/\/$/, "")}/api/public/health`,
		),
		localAutostartTimeoutMs: clampNumber(
			fileConfig.localAutostartTimeoutMs ??
				process.env.PI_LANGFUSE_AUTOSTART_TIMEOUT_MS,
			200,
			50,
			5_000,
		),
	};
}

export function canTrace(config: Config): boolean {
	return config.enabled && !!config.publicKey && !!config.secretKey;
}

export function getConfigWarnings(config: Config): string[] {
	const warnings: string[] = [];
	if (!config.enabled) return warnings;
	if (!/^https?:\/\//.test(config.host)) {
		warnings.push("base URL should start with http:// or https://");
	}
	if (config.defaultTags.length >= 20) {
		warnings.push("default tags were capped at 20 entries");
	}
	if (!config.redactionEnabled) {
		warnings.push(
			"secret redaction is disabled; Langfuse and raw traces may store sensitive data",
		);
	}
	return warnings;
}
