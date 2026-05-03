import { createHash } from "node:crypto";

export interface RedactionConfig {
	redactionEnabled: boolean;
	redactionAdditionalSecrets?: string[];
	secretKey?: string;
}

interface ExactSecret {
	value: string;
	reason: string;
}

const MIN_EXACT_SECRET_LENGTH = 8;
const MAX_EXACT_SECRET_LENGTH = 20_000;

const SENSITIVE_KEY_PATTERN =
	/(secret|password|passwd|authorization|cookie|credential|private[_-]?key|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret)/i;
const TOKEN_KEY_PATTERN = /(^|[_-])(token|tokens)$/i;
const TOKEN_COUNT_KEY_PATTERN =
	/^(?:(?:max|min|total|prompt|completion|input|output|cache|context|available|remaining|usage|used)[_-]?)*tokens?$/i;
const PUBLIC_KEY_PATTERN = /^public[-_]?key$/i;
const BINARY_KEY_PATTERN =
	/(image|screenshot|attachment|media|binary|blob|base64|data[_-]?url|file[_-]?bytes|content[_-]?bytes)/i;

const SECRET_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
	{
		reason: "private-key",
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{
		reason: "bearer-token",
		pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
	},
	{
		reason: "github-token",
		pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,255}\b/g,
	},
	{
		reason: "huggingface-token",
		pattern: /\bhf_[A-Za-z0-9]{20,}\b/g,
	},
	{
		reason: "anthropic-key",
		pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
	},
	{
		reason: "langfuse-secret-key",
		pattern: /\bsk-lf-[A-Za-z0-9_-]{10,}\b/g,
	},
	{
		reason: "openai-key",
		pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
	},
	{
		reason: "aws-access-key",
		pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	},
	{
		reason: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
	{
		reason: "url-embedded-credentials",
		pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
	},
	{
		reason: "data-url",
		pattern: /\bdata:[^\s;,]+(?:;[^\s,]+)?,[A-Za-z0-9+/=_-]{40,}/g,
	},
	{
		reason: "long-base64-blob",
		pattern: /\b(?:[A-Za-z0-9+/]{120,}={0,2}|[A-Za-z0-9_-]{160,})\b/g,
	},
	{
		reason: "long-hex-blob",
		pattern: /\b[a-fA-F0-9]{96,}\b/g,
	},
];

const PII_PATTERNS: Array<{
	reason: string;
	pattern: RegExp;
	validate?: (match: string) => boolean;
}> = [
	{
		reason: "email",
		pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
	},
	{
		reason: "phone-number",
		pattern:
			/\b(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
	},
	{
		reason: "ssn",
		pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
	},
	{
		reason: "credit-card",
		pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g,
		validate: luhnLike,
	},
];

const ASSIGNMENT_PATTERN =
	/\b([A-Za-z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|WEBHOOK[_-]?SECRET)[A-Za-z0-9_-]*)\s*([:=])\s*(["']?)([^\s"'`,}]{6,}|[^\n"']{12,})(\3)/gi;

function hashSecret(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function luhnLike(value: string) {
	const digits = value.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let double = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let digit = Number(digits[index]);
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
}

function normalizeReason(reason: string) {
	return reason
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function placeholder(reason: string, value?: string) {
	const normalized = normalizeReason(reason) || "secret";
	return value
		? `[REDACTED:${normalized}:${hashSecret(value)}]`
		: `[REDACTED:${normalized}]`;
}

function blobPlaceholder(reason: string, value: string) {
	return `${placeholder(reason, value)}(${value.length} chars)`;
}

function normalizeKey(key: string) {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

export function isSensitiveKey(key: string) {
	const normalized = normalizeKey(key);
	if (PUBLIC_KEY_PATTERN.test(normalized)) return false;
	if (TOKEN_COUNT_KEY_PATTERN.test(normalized)) return false;
	return (
		SENSITIVE_KEY_PATTERN.test(normalized) || TOKEN_KEY_PATTERN.test(normalized)
	);
}

function isBinaryKey(key: string) {
	return BINARY_KEY_PATTERN.test(normalizeKey(key));
}

function collectExactSecrets(
	config: RedactionConfig,
	env: NodeJS.ProcessEnv,
): ExactSecret[] {
	const secrets = new Map<string, string>();
	const add = (value: unknown, reason: string) => {
		if (typeof value !== "string") return;
		const secret = value.trim();
		if (
			secret.length < MIN_EXACT_SECRET_LENGTH ||
			secret.length > MAX_EXACT_SECRET_LENGTH
		) {
			return;
		}
		secrets.set(secret, reason);
	};

	add(config.secretKey, "langfuse-secret-key");
	for (const secret of config.redactionAdditionalSecrets ?? []) {
		add(secret, "configured-secret");
	}
	for (const [key, value] of Object.entries(env)) {
		if (key === "PI_LANGFUSE_REDACTION_SECRETS") continue;
		if (isSensitiveKey(key)) add(value, key);
	}

	return Array.from(secrets, ([value, reason]) => ({ value, reason })).sort(
		(a, b) => b.value.length - a.value.length,
	);
}

export function redactString(
	config: RedactionConfig,
	input: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	if (!config.redactionEnabled || !input) return input;
	let output = input;

	output = output.replace(
		ASSIGNMENT_PATTERN,
		(match, key: string, operator: string, quote: string, value: string) =>
			isSensitiveKey(key)
				? `${key}${operator}${quote}${placeholder(key, value)}${quote}`
				: match,
	);

	for (const secret of collectExactSecrets(config, env)) {
		if (output.includes(secret.value)) {
			output = output
				.split(secret.value)
				.join(placeholder(secret.reason, secret.value));
		}
	}

	for (const { reason, pattern } of SECRET_PATTERNS) {
		output = output.replace(pattern, (match) =>
			reason.endsWith("blob") || reason === "data-url"
				? blobPlaceholder(reason, match)
				: placeholder(reason, match),
		);
	}

	for (const { reason, pattern, validate } of PII_PATTERNS) {
		output = output.replace(pattern, (match) =>
			!validate || validate(match) ? placeholder(reason, match) : match,
		);
	}

	return output;
}

function redactSensitiveField(value: unknown, key: string) {
	if (value === null || value === undefined) return value;
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	return placeholder(key, serialized);
}

function redactBinaryField(value: unknown, key: string) {
	if (value === null || value === undefined) return value;
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	return blobPlaceholder(key, serialized);
}

export function sanitizeForTelemetry<T>(
	config: RedactionConfig,
	value: T,
	env: NodeJS.ProcessEnv = process.env,
	seen = new WeakSet<object>(),
): T {
	if (!config.redactionEnabled) return value;
	if (typeof value === "string") return redactString(config, value, env) as T;
	if (typeof value === "bigint") return value.toString() as T;
	if (typeof value === "function") {
		return `[function ${(value as { name?: string }).name || "anonymous"}]` as T;
	}
	if (!value || typeof value !== "object") return value;
	if (value instanceof Error) {
		return {
			name: redactString(config, value.name, env),
			message: redactString(config, value.message, env),
			stack: value.stack ? redactString(config, value.stack, env) : undefined,
		} as T;
	}
	if (seen.has(value)) return "[Circular]" as T;
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) =>
			sanitizeForTelemetry(config, item, env, seen),
		) as T;
	}

	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		output[key] = isSensitiveKey(key)
			? redactSensitiveField(item, key)
			: isBinaryKey(key)
				? redactBinaryField(item, key)
				: sanitizeForTelemetry(config, item, env, seen);
	}
	return output as T;
}

export interface RedactionFinding {
	reason: string;
	count: number;
}

function addFinding(findings: Map<string, number>, reason: string, count = 1) {
	findings.set(reason, (findings.get(reason) ?? 0) + count);
}

export function scanForSecrets(
	config: RedactionConfig,
	input: string,
	env: NodeJS.ProcessEnv = process.env,
): RedactionFinding[] {
	const findings = new Map<string, number>();
	if (!input) return [];

	const scanInput = input.replace(/\[REDACTED:[^\]]+\]/g, "[REDACTED]");

	for (const secret of collectExactSecrets(config, env)) {
		if (scanInput.includes(secret.value)) {
			addFinding(
				findings,
				normalizeReason(secret.reason) || "configured-secret",
				scanInput.split(secret.value).length - 1,
			);
		}
	}

	const jsonSensitiveFieldPattern =
		/["']([^"']*(?:secret|password|passwd|authorization|cookie|credential|private[_-]?key|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret)[^"']*)["']\s*:\s*["']([^"']{6,})["']/gi;
	for (const match of scanInput.matchAll(jsonSensitiveFieldPattern)) {
		const key = match[1] || "sensitive-field";
		const value = match[2] || "";
		if (!value.startsWith("[REDACTED"))
			addFinding(findings, normalizeReason(key));
	}

	for (const match of scanInput.matchAll(ASSIGNMENT_PATTERN)) {
		const key = match[1] || "assignment";
		const value = match[4] || "";
		if (isSensitiveKey(key) && !value.startsWith("[REDACTED")) {
			addFinding(findings, normalizeReason(key));
		}
	}

	for (const { reason, pattern } of SECRET_PATTERNS) {
		const matches = scanInput.match(pattern);
		if (matches?.length) addFinding(findings, reason, matches.length);
	}

	for (const { reason, pattern, validate } of PII_PATTERNS) {
		const matches = Array.from(scanInput.matchAll(pattern))
			.map((match) => match[0])
			.filter((match) => !validate || validate(match));
		if (matches.length) addFinding(findings, reason, matches.length);
	}

	return Array.from(findings, ([reason, count]) => ({ reason, count })).sort(
		(a, b) => a.reason.localeCompare(b.reason),
	);
}

export function redactionMetadata(config: RedactionConfig) {
	return { applied: config.redactionEnabled };
}
