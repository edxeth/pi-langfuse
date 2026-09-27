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
		reason: "stripe-key",
		pattern: /\b(?:sk|pk)_(?:test|live|prod)_[A-Za-z0-9]{20,}\b/g,
	},
	{
		reason: "sendgrid-key",
		pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
	},
	{
		reason: "docker-pat",
		pattern: /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g,
	},
	{
		reason: "slack-webhook-url",
		pattern:
			/\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+\b/g,
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

// Secret assignments in free text: quoted keys (`"password":"value"`,
// `'password':'value'`, JSONL-escaped `\"password\":\"value\"`, and the same
// at any repeated-serialization depth) and unquoted keys
// (`LANGFUSE_SECRET_KEY=...`, `token: abcdef`). All forms are parsed by one
// forward tokenization shared between telemetry redaction and the export
// residual scanner; the regexes this replaces were measured quadratic on
// word-dense input.
const SUSPICIOUS_TEXT_MARKER = "[REDACTED:suspicious-text]";

// A value counts as already redacted only when the whole value is one
// complete standalone placeholder. Prefixes, suffixes, and broken markers do
// not count.
const COMPLETE_REDACTED_MARKER = /^\[REDACTED:[a-z0-9-]+(?::[0-9a-f]+)?\]$/;

// Sensitive-word test for candidate key spans. Non-global: stateless per
// span.
const SENSITIVE_WORD_TEST =
	/(?:secret|password|passwd|authorization|cookie|credential|private[ _-]?key|api[ _-]?key|access[ _-]?key|refresh[ _-]?token|client[ _-]?secret|webhook[ _-]?secret)/i;

interface SecretReplacement {
	// Byte span of the value to replace (excludes surrounding quote tokens).
	start: number;
	end: number;
	reason: string;
	// Raw value bytes; the replacement hashes them into the placeholder.
	value: string;
}

interface SecretAssignmentScan {
	replacements: SecretReplacement[];
	// False when some assignment's value extent could not be proven; the
	// caller must then omit the whole string instead of patching regions.
	allResolved: boolean;
}

function isQuoteChar(ch: string) {
	return ch === '"' || ch === "'";
}

function isQuotedKeyChar(ch: string) {
	return ch !== '"' && ch !== "'" && ch !== "\\" && ch !== "\n" && ch !== "\r";
}

function isUnquotedKeyChar(ch: string) {
	return (
		(ch >= "0" && ch <= "9") ||
		(ch >= "a" && ch <= "z") ||
		(ch >= "A" && ch <= "Z") ||
		ch === "_" ||
		ch === "-"
	);
}

function isAssignmentWhitespace(ch: string) {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Find every recognizable secret assignment and classify its value.
 *
 * One left-to-right pass. Candidate key spans are visited exactly once:
 * maximal quoted (`"..."`, backslash runs skipped by loop) or unquoted
 * (`[A-Za-z0-9_-]+`) spans, each checked for a sensitive word, then a
 * separator tolerant of backslash runs and escaped newlines around `:` (or
 * `=` for unquoted keys), then a value.
 *
 * Quoted values are delimited by the symmetric escape token: the closing
 * quote must be preceded by exactly as many backslashes as the opening
 * quote. That makes the value extent provable at any uniform serialization
 * depth, so the value is replaced with a hashed placeholder in place.
 * Provably empty values and complete standalone `[REDACTED` markers are
 * kept. Ambiguous extents — content backslashes, bare or mismatched-run
 * closing quotes, unterminated values — are unresolvable: the caller omits
 * the whole string rather than guess. Unquoted values are whitespace-
 * delimited and always provable; they are replaced in place. There is no
 * depth cap, occurrence cap, or backtracking regex.
 *
 * Shared by telemetry redaction and the export residual scanner so both
 * layers fail closed on the same shapes per the omit-suspicious-text policy.
 */
function scanSecretAssignments(input: string): SecretAssignmentScan {
	const replacements: SecretReplacement[] = [];
	let allResolved = true;
	const len = input.length;

	/**
	 * Backslash run length immediately before a quote position.
	 */
	const escapeRunOf = (quotePos: number): number => {
		let run = 0;
		while (quotePos - run - 1 >= 0 && input[quotePos - run - 1] === "\\")
			run += 1;
		return run;
	};

	/**
	 * Structural continuation after a closing quote: whitespace or separator
	 * junk (including backslash runs left by asymmetric serialization)
	 * followed by a JSON structural character or the end of input.
	 */
	/**
	 * Advance past separator whitespace and its serialized or escaped forms:
	 * raw space/tab/CR/LF, backslash runs left by asymmetric serialization,
	 * and backslash + one serialized whitespace escape (n, t, r). Stops at
	 * the first other character. Monotone: each character is consumed at
	 * most once, so the scan is linear.
	 */
	const skipSeparatorJunk = (pos: number): number => {
		while (pos < len) {
			const ch = input[pos];
			if (
				ch === " " ||
				ch === "\t" ||
				ch === "\n" ||
				ch === "\r" ||
				ch === "\\"
			) {
				pos += 1;
				continue;
			}
			if (
				(ch === "n" || ch === "t" || ch === "r") &&
				pos > 0 &&
				input[pos - 1] === "\\"
			) {
				pos += 1;
				continue;
			}
			break;
		}
		return pos;
	};

	const isStructuralAfter = (pos: number): boolean => {
		const a = skipSeparatorJunk(pos);
		return (
			a >= len ||
			input[a] === "," ||
			input[a] === "}" ||
			input[a] === "]" ||
			input[a] === ":"
		);
	};

	/**
	 * Parse a quoted value whose opening quote sits at valueOpen. The extent
	 * is provable only when the content between the opening quote and the
	 * close token is clean: no backslash (an escape could hide a boundary at
	 * any serialization depth) and no newline. Per the omit-suspicious-text
	 * policy anything else makes the caller omit the whole string.
	 *
	 * Close recognition:
	 * - unescaped opening quote (no backslash run before it): the first bare
	 *   same-quote closes; the content is clean by construction.
	 * - escaped opening quote (a backslash run of length r before it): a
	 *   same-quote whose own backslash run also has length r closes it when
	 *   followed by structural continuation; any other backslash sequence is
	 *   content and scanning continues, so an inner escaped quote can never
	 *   truncate the value and a non-structural tail omits the whole string.
	 */
	const parseQuotedValue = (
		valueOpen: number,
	): { valueEnd: number; closeStart: number; closeEnd: number } | null => {
		const valueQuote = input[valueOpen];
		const escapeRun = escapeRunOf(valueOpen);
		let v = valueOpen + 1;
		while (v < len) {
			const ch = input[v];
			if (ch === "\\") {
				let closeRun = 0;
				while (v + closeRun < len && input[v + closeRun] === "\\")
					closeRun += 1;
				const afterRun = v + closeRun;
				if (
					afterRun < len &&
					input[afterRun] === valueQuote &&
					closeRun === escapeRun &&
					isStructuralAfter(afterRun + 1)
				) {
					return {
						valueEnd: v,
						closeStart: v,
						closeEnd: afterRun + 1,
					};
				}
				// Not the close: the escape sequence is content. Skip the run and,
				// when a quote follows it, that quote too (it is content).
				v =
					afterRun < len && isQuoteChar(input[afterRun])
						? afterRun + 1
						: afterRun;
				continue;
			}
			if (ch === "\n") return null;
			if (ch === valueQuote) {
				if (escapeRun !== 0) return null;
				return { valueEnd: v, closeStart: v, closeEnd: v + 1 };
			}
			v += 1;
		}
		return null;
	};

	/**
	 * Parse the value after a confirmed separator. `cursor` sits just past
	 * the separator character. Returns the next scan cursor, or null when
	 * there is no recognizable value (the caller then resumes at keyEnd).
	 */
	const parseValue = (
		cursor: number,
		keyStart: number,
		keyEnd: number,
		allowUnquoted: boolean,
	): number => {
		const v = skipSeparatorJunk(cursor);
		if (v < len && isQuoteChar(input[v])) {
			const parsed = parseQuotedValue(v);
			if (parsed === null) {
				allResolved = false;
				return len;
			}
			const value = input.slice(v + 1, parsed.valueEnd);
			if (value !== "" && !COMPLETE_REDACTED_MARKER.test(value)) {
				replacements.push({
					start: v + 1,
					end: parsed.valueEnd,
					reason: normalizeReason(input.slice(keyStart, keyEnd)),
					value,
				});
			}
			return parsed.closeEnd;
		}
		if (!allowUnquoted) return keyEnd;
		// Unquoted value: whitespace-delimited run without quotes or the
		// punctuation that would make a JSON value ambiguous.
		let end = v;
		while (end < len) {
			const ch = input[end];
			if (
				isAssignmentWhitespace(ch) ||
				ch === '"' ||
				ch === "'" ||
				ch === "`" ||
				ch === "," ||
				ch === "}" ||
				ch === "]"
			) {
				break;
			}
			end += 1;
		}
		let value = input.slice(v, end);
		if (value.length < 6) {
			// Long free-text values may contain punctuation: fall back to the
			// rest of the line (12+ characters), mirroring the historical
			// assignment semantics.
			let lineEnd = v;
			while (
				lineEnd < len &&
				input[lineEnd] !== "\n" &&
				input[lineEnd] !== "\r" &&
				input[lineEnd] !== '"' &&
				input[lineEnd] !== "'"
			) {
				lineEnd += 1;
			}
			if (lineEnd - v < 12) return keyEnd;
			end = lineEnd;
			value = input.slice(v, end);
		}
		if (!COMPLETE_REDACTED_MARKER.test(value)) {
			replacements.push({
				start: v,
				end,
				reason: normalizeReason(input.slice(keyStart, keyEnd)),
				value,
			});
		}
		return end;
	};

	/** Quoted-key candidate whose opening quote sits at openQuote. */
	const scanQuotedKey = (openQuote: number): number => {
		const keyStart = openQuote + 1;
		let keyEnd = keyStart;
		while (keyEnd < len && isQuotedKeyChar(input[keyEnd])) keyEnd += 1;
		const key = input.slice(keyStart, keyEnd);
		if (!SENSITIVE_WORD_TEST.test(key) || !isSensitiveKey(key)) {
			return keyEnd;
		}
		// Key close: optional backslash run then a quote, or a backslash run
		// followed directly by a colon (malformed run form).
		let close = keyEnd;
		while (close < len && input[close] === "\\") close += 1;
		let separator: number;
		if (close < len && isQuoteChar(input[close])) {
			separator = close + 1;
		} else if (close > keyEnd && input[close] === ":") {
			separator = close;
		} else {
			return keyEnd;
		}
		// Separator: JSON whitespace, its serialized/escaped forms, and
		// asymmetric backslash runs around the colon.
		const s = skipSeparatorJunk(separator);
		if (s < len && input[s] === ":") {
			return parseValue(s + 1, keyStart, keyEnd, false);
		}
		return keyEnd;
	};

	/** Unquoted-key candidate spanning [spanStart, spanEnd). */
	const scanUnquotedKey = (spanStart: number, spanEnd: number): number => {
		const key = input.slice(spanStart, spanEnd);
		if (!SENSITIVE_WORD_TEST.test(key) || !isSensitiveKey(key)) {
			return spanEnd;
		}
		const s = skipSeparatorJunk(spanEnd);
		if (s >= len || (input[s] !== ":" && input[s] !== "=")) {
			return spanEnd;
		}
		return parseValue(s + 1, spanStart, spanEnd, true);
	};

	let cursor = 0;
	while (cursor < len && allResolved) {
		const ch = input[cursor];
		if (ch === "\\") {
			let runEnd = cursor;
			while (runEnd < len && input[runEnd] === "\\") runEnd += 1;
			if (runEnd < len && isQuoteChar(input[runEnd])) {
				cursor = scanQuotedKey(runEnd);
			} else {
				cursor = runEnd;
			}
			continue;
		}
		if (isQuoteChar(ch)) {
			cursor = scanQuotedKey(cursor);
			continue;
		}
		if (isUnquotedKeyChar(ch)) {
			let spanEnd = cursor;
			while (spanEnd < len && isUnquotedKeyChar(input[spanEnd])) spanEnd += 1;
			cursor = scanUnquotedKey(cursor, spanEnd);
			continue;
		}
		cursor += 1;
	}
	return { replacements, allResolved };
}

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

export function isBinaryKey(key: string) {
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

/**
 * Redact one string against a precomputed exact-secret list. The list must
 * come from `collectExactSecrets` for the same config/env pair; callers own
 * its lifetime (see `sanitizeForTelemetry` for payload-granularity reuse).
 */
function redactStringWithSecrets(
	config: RedactionConfig,
	input: string,
	exactSecrets: ExactSecret[],
): string {
	if (!config.redactionEnabled || !input) return input;
	// Secret assignments are parsed by one shared forward tokenization. When
	// any value extent is unprovable, the whole string is omitted per the
	// omit-suspicious-text policy; provable values get structure-preserving
	// hashed placeholders.
	const scan = scanSecretAssignments(input);
	if (!scan.allResolved) return SUSPICIOUS_TEXT_MARKER;
	let output = input;
	if (scan.replacements.length > 0) {
		const parts: string[] = [];
		let cursor = 0;
		for (const replacement of scan.replacements) {
			parts.push(
				input.slice(cursor, replacement.start),
				placeholder(replacement.reason, replacement.value),
			);
			cursor = replacement.end;
		}
		parts.push(input.slice(cursor));
		output = parts.join("");
	}

	// Regex patterns run before exact secrets so longer pattern matches
	// are not fragmented by shorter exact-secret replacements.
	for (const { reason, pattern } of SECRET_PATTERNS) {
		output = output.replace(pattern, (match) =>
			reason.endsWith("blob") || reason === "data-url"
				? blobPlaceholder(reason, match)
				: placeholder(reason, match),
		);
	}

	for (const secret of exactSecrets) {
		if (output.includes(secret.value)) {
			output = output
				.split(secret.value)
				.join(placeholder(secret.reason, secret.value));
		}
	}

	for (const { reason, pattern, validate } of PII_PATTERNS) {
		output = output.replace(pattern, (match) =>
			!validate || validate(match) ? placeholder(reason, match) : match,
		);
	}

	return output;
}

export function redactString(
	config: RedactionConfig,
	input: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	// Direct calls collect exact secrets fresh per string, so env/config
	// changes are always visible at one-string granularity.
	if (!config.redactionEnabled || !input) return input;
	return redactStringWithSecrets(
		config,
		input,
		collectExactSecrets(config, env),
	);
}

const MAX_STRUCTURED_REDACTION_CHARS = 100_000;

function redactFieldValue(value: unknown, bounded: boolean) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return value;
	try {
		const serialized = JSON.stringify(value);
		if (
			serialized !== undefined &&
			(!bounded || serialized.length <= MAX_STRUCTURED_REDACTION_CHARS)
		)
			return serialized;
	} catch {
		// Circular and unserializable structured values use a constant safe marker.
	}
	return "[structured-value]";
}

function redactSensitiveField(value: unknown, key: string, bounded = false) {
	const serialized = redactFieldValue(value, bounded);
	return serialized === null || serialized === undefined
		? serialized
		: placeholder(key, serialized);
}

function redactBinaryField(value: unknown, key: string, bounded = false) {
	const serialized = redactFieldValue(value, bounded);
	return serialized === null || serialized === undefined
		? serialized
		: blobPlaceholder(key, serialized);
}

export interface TelemetrySanitizeLimits {
	maxStringChars?: number;
	maxDepth?: number;
	maxArrayItems?: number;
	maxObjectKeys?: number;
	maxNodes?: number;
}

export function sanitizeForTelemetry<T>(
	config: RedactionConfig,
	value: T,
	env: NodeJS.ProcessEnv = process.env,
	seen = new WeakSet<object>(),
	limits?: TelemetrySanitizeLimits,
): T {
	if (!config.redactionEnabled && !limits) return value;
	const nodes = { count: 0 };

	// Exact secrets are collected lazily once per top-level call and reused
	// for every string in the payload, so the O(env) collection runs once
	// per payload instead of once per string. Env/config changes between
	// top-level calls stay visible; mutations made while one synchronous
	// traversal runs are not observed until the next call (payload-
	// granularity snapshot).
	let exactSecrets: ExactSecret[] | undefined;
	const exactSecretsForPayload = (): ExactSecret[] => {
		exactSecrets ??= collectExactSecrets(config, env);
		return exactSecrets;
	};

	const sanitize = (current: unknown, depth: number): unknown => {
		if (limits && nodes.count >= (limits.maxNodes ?? Infinity))
			return undefined;
		nodes.count += 1;

		if (typeof current === "string") {
			const redacted =
				config.redactionEnabled && current
					? redactStringWithSecrets(config, current, exactSecretsForPayload())
					: current;
			const maxChars = limits?.maxStringChars ?? Infinity;
			return Number.isFinite(maxChars) && redacted.length > maxChars
				? redacted.slice(0, maxChars)
				: redacted;
		}
		if (typeof current === "bigint") {
			return config.redactionEnabled ? current.toString() : current;
		}
		if (typeof current === "function") {
			return config.redactionEnabled
				? `[function ${(current as { name?: string }).name || "anonymous"}]`
				: current;
		}
		if (!current || typeof current !== "object") return current;
		if (current instanceof Date) return current;
		if (depth >= (limits?.maxDepth ?? Infinity)) return "[TRUNCATED:depth]";
		if (current instanceof Error) {
			return {
				name: sanitize(current.name, depth + 1),
				message: sanitize(current.message, depth + 1),
				stack: current.stack ? sanitize(current.stack, depth + 1) : undefined,
			};
		}
		if (seen.has(current)) return "[Circular]";
		seen.add(current);

		if (Array.isArray(current)) {
			const output: unknown[] = [];
			const itemLimit = Math.min(
				current.length,
				limits?.maxArrayItems ?? Infinity,
			);
			for (let index = 0; index < itemLimit; index += 1) {
				const item = sanitize(current[index], depth + 1);
				if (item !== undefined) output.push(item);
			}
			return output;
		}

		const output: Record<string, unknown> = {};
		const entries = Object.entries(current as Record<string, unknown>);
		const keyLimit = Math.min(
			entries.length,
			limits?.maxObjectKeys ?? Infinity,
		);
		for (let index = 0; index < keyLimit; index += 1) {
			if (limits && nodes.count >= (limits.maxNodes ?? Infinity)) break;
			const entry = entries[index];
			if (!entry) continue;
			const [key, item] = entry;
			const sanitized =
				config.redactionEnabled && isSensitiveKey(key)
					? redactSensitiveField(item, key, Boolean(limits))
					: config.redactionEnabled && isBinaryKey(key)
						? redactBinaryField(item, key, Boolean(limits))
						: sanitize(item, depth + 1);
			if (sanitized !== undefined) output[key] = sanitized;
		}
		return output;
	};

	return sanitize(value, 0) as T;
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

	// Secret assignments are parsed by the same shared forward tokenization
	// redaction uses, so the scanner and redaction fail closed on identical
	// shapes: exact values are reported by field reason, unprovable extents
	// are reported as suspicious text (the caller omits such strings).
	const scan = scanSecretAssignments(input);
	if (!scan.allResolved) {
		addFinding(findings, "suspicious-text");
	}
	for (const replacement of scan.replacements) {
		addFinding(findings, replacement.reason);
	}

	for (const secret of collectExactSecrets(config, env)) {
		if (input.includes(secret.value)) {
			addFinding(
				findings,
				normalizeReason(secret.reason) || "configured-secret",
				input.split(secret.value).length - 1,
			);
		}
	}

	for (const { reason, pattern } of SECRET_PATTERNS) {
		const matches = input.match(pattern);
		if (matches?.length) addFinding(findings, reason, matches.length);
	}

	for (const { reason, pattern, validate } of PII_PATTERNS) {
		const matches = Array.from(input.matchAll(pattern))
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
