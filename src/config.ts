import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRawTraceDir } from "./raw-trace.js";
import { DEFAULT_SETTINGS, type SettingsValues } from "./settings.js";

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
	rawTraceEnabled: boolean;
	rawTraceDir: string;
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

export function loadConfigFile(): Partial<Config> {
	const extensionConfigPath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"config.json",
	);
	const localConfigPath = join(defaultLocalAutostartDir(), "pi-langfuse.json");

	return {
		...readConfigJson(extensionConfigPath),
		...readConfigJson(localConfigPath),
	};
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

function parseTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((item) => String(item).trim())
			.filter(Boolean)
			.slice(0, 20);
	}
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean)
		.slice(0, 20);
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
		rawTraceEnabled:
			(fileConfig.rawTraceEnabled as boolean | undefined) ??
			process.env.PI_LANGFUSE_RAW_TRACE === "1",
		rawTraceDir: String(
			fileConfig.rawTraceDir ??
				process.env.PI_LANGFUSE_RAW_TRACE_DIR ??
				defaultRawTraceDir(),
		),
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
	return warnings;
}
