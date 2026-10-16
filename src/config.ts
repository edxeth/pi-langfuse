import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	IDENTITY_MODES,
	type IdentityConfig,
	type IdentityMode,
	parseIdentityMode,
	parseStrictBoolean,
} from "./identity.js";
import { describeError, loadOrCreateIdentitySalt } from "./identity-salt.js";
import {
	type CapturePolicy,
	DEFAULT_CAPTURE_POLICY,
	normalizeCapturePolicy,
} from "./payload-policy.js";
import { defaultRawTraceDir } from "./raw-trace.js";
import { recordRuntimeError } from "./runtime-diagnostics.js";
import { DEFAULT_SETTINGS, type SettingsValues } from "./settings.js";

export type RawTraceProviderRequestMode = "summary" | "full" | "off";
export type ConfigSource =
	| "settings"
	| "file"
	| "environment"
	| "defaults"
	| "mixed";

export interface Config extends IdentityConfig {
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
	capturePolicy?: CapturePolicy;
	capturePrompt?: boolean;
	captureSystemPrompt?: boolean;
	captureProviderInput?: boolean;
	captureAssistantOutput?: boolean;
	captureToolInput?: boolean;
	captureToolOutput?: boolean;
	captureMetadata?: boolean;
	payloadMaxStringChars?: number;
	payloadMaxToolChars?: number;
	payloadMaxDepth?: number;
	payloadMaxArrayItems?: number;
	payloadMaxObjectKeys?: number;
	payloadMaxNodes?: number;
	redactionEnabled: boolean;
	redactionAdditionalSecrets: string[];
	rawTraceEnabled: boolean;
	rawTraceDir: string;
	rawTraceProviderRequestMode: RawTraceProviderRequestMode;
	/**
	 * Operator-declared license text recorded in training exports. Empty means
	 * undeclared; the export does not verify it.
	 */
	exportLicense?: string;
	/**
	 * Operator-declared training consent: "unknown" (default), "granted", or
	 * "denied". Validated at export time; never inferred from scans or licenses.
	 */
	exportConsent?: string;
	/**
	 * Set when the config file holds an export declaration of the wrong JSON
	 * type. Only a `--format` export refuses on it; live telemetry is unaffected.
	 */
	exportLicenseError?: string;
	exportConsentError?: string;
	localAutostart: boolean;
	localAutostartDir: string;
	localAutostartHealthUrl: string;
	localAutostartTimeoutMs: number;
}

interface ConfigFileState {
	values: Partial<Config> & Record<string, unknown>;
	/** The file exists but could not be read as a JSON object. */
	unreadable: boolean;
}

function readConfigJson(path: string): ConfigFileState {
	if (!existsSync(path)) return { values: {}, unreadable: false };
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				// SAFETY: the guard above proved a JSON object; each key is
				// validated where it is read, as before this change.
				values: parsed as Partial<Config> & Record<string, unknown>,
				unreadable: false,
			};
		}
		recordRuntimeError(`Failed to load ${path}`, "not a JSON object");
	} catch (e) {
		recordRuntimeError(`Failed to load ${path}`, e);
	}
	return { values: {}, unreadable: true };
}

function loadConfigFileState(): ConfigFileState {
	return readConfigJson(getConfigFilePath());
}

function loadConfigFile(): Partial<Config> {
	return loadConfigFileState().values;
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

export function getConfigFilePath() {
	// PI_LANGFUSE_CONFIG lets init target a custom directory that config
	// loading can still find; unset keeps the historical default path.
	return (
		process.env.PI_LANGFUSE_CONFIG ||
		join(defaultLocalAutostartDir(), "pi-langfuse.json")
	);
}

function hasConfiguredValue(value: unknown) {
	return typeof value === "string"
		? value.trim().length > 0
		: value !== undefined;
}

function addConfigSource(
	sources: Set<Exclude<ConfigSource, "mixed">>,
	settingValue: unknown,
	fileValue: unknown,
	environmentValue: unknown,
) {
	if (hasConfiguredValue(settingValue)) sources.add("settings");
	else if (hasConfiguredValue(fileValue)) sources.add("file");
	else if (hasConfiguredValue(environmentValue)) sources.add("environment");
	else sources.add("defaults");
}

export function getConfigSources(
	settings: Partial<SettingsValues>,
): Array<Exclude<ConfigSource, "mixed">> {
	const fileConfig = loadConfigFile() as Partial<Config> &
		Record<string, unknown>;
	const sources = new Set<Exclude<ConfigSource, "mixed">>();
	addConfigSource(sources, settings.enabled, fileConfig.enabled, undefined);
	addConfigSource(
		sources,
		settings["public-key"],
		fileConfig.publicKey,
		process.env.LANGFUSE_PUBLIC_KEY,
	);
	addConfigSource(
		sources,
		settings["secret-key"],
		fileConfig.secretKey,
		process.env.LANGFUSE_SECRET_KEY,
	);
	addConfigSource(
		sources,
		settings["base-url"],
		fileConfig.host,
		process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST,
	);
	addConfigSource(
		sources,
		settings["user-id"],
		fileConfig.userId,
		process.env.PI_LANGFUSE_USER_ID || process.env.LANGFUSE_USER_ID,
	);
	addConfigSource(
		sources,
		settings["default-tags"],
		fileConfig.defaultTags,
		process.env.PI_LANGFUSE_TAGS,
	);
	addConfigSource(
		sources,
		settings.release,
		fileConfig.release,
		process.env.LANGFUSE_RELEASE || process.env.PI_LANGFUSE_RELEASE,
	);
	addConfigSource(
		sources,
		settings.environment,
		fileConfig.environment,
		process.env.LANGFUSE_ENV || process.env.PI_LANGFUSE_ENV,
	);
	addConfigSource(
		sources,
		settings["capture-policy"],
		fileConfig.capturePolicy,
		process.env.PI_LANGFUSE_CAPTURE_POLICY,
	);
	return [...sources];
}

export function getConfigSource(
	settings: Partial<SettingsValues>,
): ConfigSource {
	const sources = getConfigSources(settings);
	return sources.length === 1 ? sources[0] : "mixed";
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

function parseOptionalBoolean(value: unknown) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "inherit") return undefined;
	if (normalized === "on") return true;
	if (normalized === "off") return false;
	return parseBooleanEnv(normalized);
}

function parsePayloadLimit(value: unknown, max: number): number | undefined {
	if (
		value === Infinity ||
		(typeof value === "string" && value.trim().toLowerCase() === "unlimited")
	) {
		return Infinity;
	}
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric) || numeric < 0) return undefined;
	return Math.min(max, Math.max(0, Math.round(numeric)));
}

function resolveOptionalBoolean(
	settingValue: unknown,
	fileValue: unknown,
	envValue: string | undefined,
) {
	return (
		parseOptionalBoolean(settingValue) ??
		parseOptionalBoolean(fileValue) ??
		parseBooleanEnv(envValue)
	);
}

function resolvePayloadLimit(
	settingValue: unknown,
	fileValue: unknown,
	envValue: string | undefined,
	max: number,
) {
	let sawInvalid = false;
	for (const candidate of [settingValue, fileValue, envValue]) {
		if (
			candidate === undefined ||
			(typeof candidate === "string" && candidate.trim().length === 0)
		)
			continue;
		const parsed = parsePayloadLimit(candidate, max);
		if (parsed !== undefined) return parsed;
		sawInvalid = true;
	}
	return sawInvalid ? 0 : Infinity;
}

function resolveCapturePolicy(
	settingValue: unknown,
	fileValue: unknown,
	envValue: string | undefined,
) {
	let sawInvalid = false;
	for (const candidate of [settingValue, fileValue, envValue]) {
		if (
			candidate === undefined ||
			(typeof candidate === "string" && candidate.trim().length === 0)
		)
			continue;
		const parsed = normalizeCapturePolicy(candidate);
		if (parsed) return parsed;
		sawInvalid = true;
	}
	return sawInvalid ? "metadata-only" : DEFAULT_CAPTURE_POLICY;
}

function isBlank(value: unknown) {
	return (
		value === undefined || (typeof value === "string" && value.trim() === "")
	);
}

/** First non-blank candidate in precedence order, or undefined. */
function firstConfigured(
	...candidates: Array<{ source: string; value: unknown }>
) {
	return candidates.find(({ value }) => !isBlank(value));
}

const FAIL_CLOSED_IDENTITY = {
	identityMode: "pseudonymous",
	identityKeepRepo: false,
} as const;

/** One checked identity setting, or the reason it is unusable. */
type Resolved<T> = { value: T } | { error: string };

function resolveIdentityMode(
	settings: Partial<SettingsValues>,
	file: ConfigFileState,
): Resolved<IdentityMode> {
	const mode = firstConfigured(
		{ source: "identity-mode setting", value: settings["identity-mode"] },
		{
			source: "identityMode in the config file",
			value: file.values.identityMode,
		},
		{ source: "PI_LANGFUSE_IDENTITY", value: process.env.PI_LANGFUSE_IDENTITY },
	);
	// An unreadable file outranks the environment, so its mode is unknown
	// unless the settings panel already decided.
	if (file.unreadable && isBlank(settings["identity-mode"])) {
		return {
			error: `the config file ${getConfigFilePath()} is not a readable JSON object, so the identity mode cannot be determined`,
		};
	}
	const parsedMode = mode ? parseIdentityMode(mode.value) : "raw";
	if (!parsedMode) {
		return {
			error: `${mode?.source} must be one of ${IDENTITY_MODES.join(", ")}`,
		};
	}
	return { value: parsedMode };
}

function resolveKeepRepository(
	settings: Partial<SettingsValues>,
	file: ConfigFileState,
): Resolved<boolean> {
	const keepRepo = firstConfigured(
		{
			source: "identity-keep-repo setting",
			value: settings["identity-keep-repo"],
		},
		{
			source: "identityKeepRepo in the config file",
			value: file.values.identityKeepRepo,
		},
		{
			source: "PI_LANGFUSE_IDENTITY_KEEP_REPO",
			value: process.env.PI_LANGFUSE_IDENTITY_KEEP_REPO,
		},
	);
	const parsedKeepRepo = keepRepo ? parseStrictBoolean(keepRepo.value) : false;
	if (parsedKeepRepo === undefined) {
		return { error: `${keepRepo?.source} must be true or false` };
	}
	return { value: parsedKeepRepo };
}

function failClosedIdentity(message: string): IdentityConfig {
	return { ...FAIL_CLOSED_IDENTITY, identityError: message };
}

function pseudonymousIdentity(keepRepo: boolean): IdentityConfig {
	try {
		return {
			identityMode: "pseudonymous",
			identityKeepRepo: keepRepo,
			identitySalt: loadOrCreateIdentitySalt(getConfigFilePath()),
			identityHome: homedir(),
		};
	} catch (error) {
		return failClosedIdentity(describeError(error));
	}
}

/**
 * Resolve the identity policy with strict validation. A setting that cannot
 * be understood never falls back to raw output: the result carries
 * `identityError`, and telemetry, raw traces, and exports refuse to run.
 * Only a missing configuration resolves to the legacy raw default, and raw
 * mode never reads, creates, or rewrites the salt.
 */
function resolveIdentity(
	settings: Partial<SettingsValues>,
	file: ConfigFileState,
): IdentityConfig {
	const mode = resolveIdentityMode(settings, file);
	if ("error" in mode) return failClosedIdentity(mode.error);
	const keepRepo = resolveKeepRepository(settings, file);
	if ("error" in keepRepo) return failClosedIdentity(keepRepo.error);
	if (mode.value === "raw") {
		return { identityMode: "raw", identityKeepRepo: keepRepo.value };
	}
	return pseudonymousIdentity(keepRepo.value);
}

/**
 * Resolve the operator's export declarations. A file value outranks the
 * environment. Only a missing (or blank) declaration gets the default; a
 * present value of the wrong JSON type is reported instead of being coerced
 * to a different declaration (`["granted"]` must not become "granted", `{}`
 * must not become "[object Object]").
 */
function resolveExportDeclarations(
	file: Record<string, unknown>,
): Pick<
	Config,
	| "exportLicense"
	| "exportConsent"
	| "exportLicenseError"
	| "exportConsentError"
> {
	const declared = (key: "exportLicense" | "exportConsent", env: string) => {
		const value = Object.hasOwn(file, key) ? file[key] : process.env[env];
		if (value === undefined) return { text: "" };
		if (typeof value !== "string") {
			return {
				text: "",
				error: `${key} in the config file must be a string, not ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`,
			};
		}
		return { text: value.trim() };
	};
	const license = declared("exportLicense", "PI_LANGFUSE_EXPORT_LICENSE");
	const consent = declared("exportConsent", "PI_LANGFUSE_EXPORT_CONSENT");
	return {
		exportLicense: license.text,
		exportConsent: consent.text || "unknown",
		...(license.error ? { exportLicenseError: license.error } : {}),
		...(consent.error ? { exportConsentError: consent.error } : {}),
	};
}

export function resolveConfig(settings: Partial<SettingsValues>): Config {
	const fileState = loadConfigFileState();
	const fileConfig = fileState.values;
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
		capturePolicy: resolveCapturePolicy(
			settings["capture-policy"],
			fileConfig.capturePolicy,
			process.env.PI_LANGFUSE_CAPTURE_POLICY,
		),
		capturePrompt: resolveOptionalBoolean(
			settings["capture-prompt"],
			fileConfig.capturePrompt,
			process.env.PI_LANGFUSE_CAPTURE_PROMPT,
		),
		captureSystemPrompt: resolveOptionalBoolean(
			settings["capture-system-prompt"],
			fileConfig.captureSystemPrompt,
			process.env.PI_LANGFUSE_CAPTURE_SYSTEM_PROMPT,
		),
		captureProviderInput: resolveOptionalBoolean(
			settings["capture-provider-input"],
			fileConfig.captureProviderInput,
			process.env.PI_LANGFUSE_CAPTURE_PROVIDER_INPUT,
		),
		captureAssistantOutput: resolveOptionalBoolean(
			settings["capture-assistant-output"],
			fileConfig.captureAssistantOutput,
			process.env.PI_LANGFUSE_CAPTURE_ASSISTANT_OUTPUT,
		),
		captureToolInput: resolveOptionalBoolean(
			settings["capture-tool-input"],
			fileConfig.captureToolInput,
			process.env.PI_LANGFUSE_CAPTURE_TOOL_INPUT,
		),
		captureToolOutput: resolveOptionalBoolean(
			settings["capture-tool-output"],
			fileConfig.captureToolOutput,
			process.env.PI_LANGFUSE_CAPTURE_TOOL_OUTPUT,
		),
		captureMetadata: resolveOptionalBoolean(
			settings["capture-metadata"],
			fileConfig.captureMetadata,
			process.env.PI_LANGFUSE_CAPTURE_METADATA,
		),
		payloadMaxStringChars: resolvePayloadLimit(
			settings["payload-max-string-chars"],
			fileConfig.payloadMaxStringChars,
			process.env.PI_LANGFUSE_PAYLOAD_MAX_STRING_CHARS,
			1_000_000,
		),
		payloadMaxToolChars: resolvePayloadLimit(
			settings["payload-max-tool-chars"],
			fileConfig.payloadMaxToolChars,
			process.env.PI_LANGFUSE_PAYLOAD_MAX_TOOL_CHARS,
			1_000_000,
		),
		payloadMaxDepth: resolvePayloadLimit(
			settings["payload-max-depth"],
			fileConfig.payloadMaxDepth,
			process.env.PI_LANGFUSE_PAYLOAD_MAX_DEPTH,
			1_000,
		),
		payloadMaxArrayItems: resolvePayloadLimit(
			settings["payload-max-array-items"],
			fileConfig.payloadMaxArrayItems,
			process.env.PI_LANGFUSE_PAYLOAD_MAX_ARRAY_ITEMS,
			10_000,
		),
		payloadMaxObjectKeys: resolvePayloadLimit(
			settings["payload-max-object-keys"],
			fileConfig.payloadMaxObjectKeys,
			process.env.PI_LANGFUSE_PAYLOAD_MAX_OBJECT_KEYS,
			10_000,
		),
		payloadMaxNodes: resolvePayloadLimit(
			settings["payload-max-nodes"],
			fileConfig.payloadMaxNodes,
			process.env.PI_LANGFUSE_PAYLOAD_MAX_NODES,
			1_000_000,
		),
		redactionEnabled,
		...resolveIdentity(settings, fileState),
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
		...resolveExportDeclarations(fileConfig),
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
	return (
		config.enabled &&
		!config.identityError &&
		!!config.publicKey &&
		!!config.secretKey
	);
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
