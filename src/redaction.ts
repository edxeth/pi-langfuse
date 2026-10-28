import { createHash } from "node:crypto";
import { type IdentityConfig, identityTransformFor } from "./identity.js";

export interface RedactionConfig extends IdentityConfig {
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
	/(secret|password|passwd|authorization|cookie|credential|private[_-]?key|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|identity[_-]?salt|(?:^|_)(?:key|pass_?phrase|pin|otp)$)/i;
const SHORT_NUMERIC_VALUE_PATTERN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

// Composite formats add dot-continuation guards so sentence periods remain delimiters.
const SECRET_TOKEN_BOUNDARY = "[A-Za-z0-9_-]";

function boundedSecretPattern(source: string, flags = "g") {
	return new RegExp(
		`(?<!${SECRET_TOKEN_BOUNDARY})(?:${source})(?!${SECRET_TOKEN_BOUNDARY})`,
		flags,
	);
}

const TOKEN_KEY_PATTERN = /(^|[_-])(token|tokens)$/i;
// `tokens` and named counters are measurements; a bare `token` is a credential key.
const TOKEN_COUNT_KEY_PATTERN =
	/^(?:tokens|(?:(?:max|min|total|prompt|completion|input|output|cache|context|available|remaining|usage|used)[_-]?)+tokens?)$/i;
const PROVIDER_TOKEN_COUNT_KEYS: ReadonlySet<string> = new Set([
	"cached_tokens",
	"reasoning_tokens",
	"cache_read_input_tokens",
	"cache_creation_input_tokens",
]);
const PUBLIC_KEY_PATTERN = /^public[-_]?key$/i;
// This field carries trace correlation metadata, but its string value is still scanned.
const REQUEST_KEY_PATTERN = /^request_key$/i;
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
		reason: "google-api-key",
		pattern: boundedSecretPattern("AIza[A-Za-z0-9_-]{35}"),
	},
	{
		reason: "slack-token",
		// The xoxe.xapp prefix is documented; its bounded body follows the xapp form.
		pattern: boundedSecretPattern(
			"(?:" +
				[
					"xox[bpar]-[0-9]{10,13}-[0-9]{10,13}[A-Za-z0-9-]{0,128}",
					"xoxb-[0-9]{8,14}-[A-Za-z0-9]{18,26}",
					"xoxp-(?:[0-9]{1,13}-){2,3}[A-Za-z0-9-]{6,64}",
					"xox[os]-[0-9]{1,20}-[0-9]{1,20}-[0-9]{1,20}-[A-Fa-f0-9]{1,64}",
					"xox[ar]-(?:[0-9]{1,13}-)?[A-Za-z0-9]{8,48}",
					"xoxe-[0-9]-[A-Z0-9]{146}",
					"xoxe\\.xox[bp]-[0-9]-[A-Z0-9]{163,166}",
					"xoxe\\.xapp-[0-9]-[A-Z0-9]{1,64}-[0-9]{1,13}-[a-z0-9]{1,64}",
					"xapp-[0-9]-[A-Z0-9]{1,64}-[0-9]{1,13}-[a-z0-9]{1,64}",
				].join("|") +
				")(?!\\.[A-Za-z0-9_-])",
		),
	},
	{
		reason: "gitlab-pat",
		// GitLab instances can customize PAT prefixes; this covers the default glpat- family.
		pattern: boundedSecretPattern(
			"(?:" +
				[
					"glpat-[A-Za-z0-9_=-]{27,300}\\.[0-9a-z]{2}\\.[a-z0-9]{9}",
					"glpat-[A-Za-z0-9_=-]{27,300}\\.[0-9a-z]{2}[0-9a-z]{7}",
					"glpat-[A-Za-z0-9_-]{20,300}",
				].join("|") +
				")(?!=|\\.[A-Za-z0-9_-])",
		),
	},
	{
		reason: "npm-token",
		pattern: boundedSecretPattern("npm_[A-Za-z0-9]{36}"),
	},
	{
		reason: "groq-api-key",
		pattern: boundedSecretPattern("gsk_[A-Za-z0-9]{52}"),
	},
	{
		reason: "xai-api-key",
		pattern: boundedSecretPattern("xai-[A-Za-z0-9_]{80}"),
	},
	{
		reason: "digitalocean-token",
		pattern: boundedSecretPattern("(?:dop|doo|dor)_v1_[a-f0-9]{64}"),
	},
	{
		reason: "shopify-token",
		pattern: boundedSecretPattern(
			"(?:shpat|shpca|shppa|shpss)_[a-fA-F0-9]{32}",
		),
	},
	{
		reason: "telegram-bot-token",
		// Telegram does not publish a token grammar. Accept the common A-prefixed
		// shape and the 34/35-character lengths found in examples and detectors.
		pattern: boundedSecretPattern("[0-9]{5,16}:A[A-Za-z0-9_-]{33,34}"),
	},
	{
		reason: "discord-bot-token",
		// Discord does not publish its token grammar. Require same-line context
		// within 80 characters; newer formats may be missed.
		pattern: boundedSecretPattern(
			"(?<=\\bdiscord\\b[^\\r\\n]{0,80})[A-Za-z0-9_-]{24,27}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,38}(?!\\.[A-Za-z0-9_-])",
			"gi",
		),
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
const JSON_NUMBER_SOURCE =
	"-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";
const REDACTED_MARKER_SOURCE = "\\[REDACTED:[a-z0-9-]+(?::[0-9a-f]+)?\\]";
const COMPLETE_REDACTED_MARKER = new RegExp(`^${REDACTED_MARKER_SOURCE}$`);

// Candidate key spans use the same classifier as structured payload fields.
interface SecretReplacement {
	// Byte span of the value to replace (excludes surrounding quote tokens).
	start: number;
	end: number;
	reason: string;
	// Raw value bytes used to render the placeholder.
	value: string;
	// Quote JSON numeric replacements at the key serialization depth.
	quoteEscapeRun?: number;
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

/** An unquoted value stops at whitespace, a quote, or a structural delimiter. */
function isUnquotedValueStop(ch: string) {
	return isAssignmentWhitespace(ch) || isQuoteChar(ch) || "`,}]".includes(ch);
}

/** The free-text fallback of an unquoted value stops at a line end or quote. */
function isLineValueStop(ch: string) {
	return ch === "\n" || ch === "\r" || isQuoteChar(ch);
}

/**
 * Find every recognizable secret assignment and classify its value.
 *
 * One left-to-right pass. Every quote is probed as the opening quote of a
 * quoted key: the candidate is the text up to the next quote, backslash, or
 * newline, classified by `isSensitiveKey`, then a separator tolerant of
 * backslash runs and escaped newlines around `:`, then a value. Unquoted keys
 * (`[A-Za-z0-9_-]+`) are classified the same way, with `=` also accepted as
 * separator.
 *
 * A candidate that is not an assignment consumes nothing: scanning resumes
 * just after its opening quote, so unquoted assignments inside prose,
 * contractions, JSON string values, and the text between pairs are still
 * found. A quote that closes a quoted value is probed as the opening quote of
 * the next key (`"password":"a"token":"b"`) by resuming at that quote.
 * Candidates contain no quote, so the text each one inspects is disjoint from
 * every other candidate's: each character is visited a bounded number of
 * times and the scan stays linear. The pass never recurses through parsed
 * values, so a long chain of shared quotes costs no call stack.
 *
 * An unquoted key inside such text can sit at the end of a string, as in
 * `{"msg":"Enter password:"}`. Its closing quote then follows structure
 * rather than a value and does not open a quoted value, but only when
 * no word follows it before the next quote (see `parseCandidateClose`).
 *
 * A sensitive key's own text can hold an assignment (`"secret token=abc":"b"`).
 * It is scanned as a separate text before the value, which keeps the
 * replacements in ascending order. The key's value then reports its reason
 * from the key text with that assignment masked, so a secret never names a
 * placeholder.
 *
 * Quoted values are delimited by the symmetric escape token: the closing
 * quote must be preceded by as many backslashes as the opening quote, plus
 * any encoded trailing content backslashes. That makes the value extent
 * provable at any uniform serialization depth, so the value is replaced
 * with a hashed placeholder in place.
 * Provably empty values and complete standalone `[REDACTED` markers are
 * kept. Ambiguous extents — content backslashes, bare or mismatched-run
 * closing quotes, unterminated values — are unresolvable: the caller omits
 * the whole string rather than guess. Unquoted values use whitespace or
 * structural delimiters and also stop at a quote; a backslash run directly
 * before that quote escapes it for an enclosing serialized string and stays
 * outside the value. A bare word after a sensitive quoted key is parsed
 * the same way; JSON literals, objects, and arrays are left alone.
 * Malformed marker values also fail closed. There
 * is no depth or occurrence cap. Marker matches stay at the current cursor
 * and cannot cross another marker prefix.
 *
 * Shared by telemetry redaction and the export residual scanner so both
 * layers fail closed on the same shapes per the omit-suspicious-text policy.
 */
function scanSecretAssignments(input: string): SecretAssignmentScan {
	const replacements: SecretReplacement[] = [];
	let allResolved = true;
	const len = input.length;
	// Quote that ends the text of the last failed quoted-key candidate, or -1.
	let candidateClose = -1;
	// Escape run of that candidate's opening quote.
	let candidateOpenRun = 0;
	// Key text whose own assignments were replaced, which names its value's
	// reason in place of the raw text so a secret never names a placeholder.
	let maskedKey: { start: number; text: string } | null = null;
	const markerToken = new RegExp(REDACTED_MARKER_SOURCE, "y");
	const numberToken = new RegExp(JSON_NUMBER_SOURCE, "y");
	const jsonLiteralToken = /(?:true|false|null)(?![A-Za-z0-9_-])/y;
	// JSON literals and their Python spellings, for the no-value stretch only.
	const stretchLiteralToken =
		/(?:true|false|null|True|False|None)(?![A-Za-z0-9_-])/y;

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
	 * Whether a backslash run before a same-quote can close a value whose
	 * opening quote has a run of r. At the depth whose close token is r
	 * backslashes and a quote, each content backslash is r + 1 backslashes.
	 * An even count of content backslashes leaves the quote unescaped, so the
	 * close run is r + 2k(r + 1); an odd count escapes the quote as content.
	 */
	const isCloseRun = (run: number, r: number): boolean =>
		run >= r && (run - r) % (2 * (r + 1)) === 0;

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

	// A smaller escape run closes an enclosing serialized string, not this value.
	const isOuterStringEnd = (pos: number, innerEscapeRun: number): boolean =>
		isQuoteChar(input[pos]) && escapeRunOf(pos) < innerEscapeRun;

	const isStructuralAfter = (pos: number, innerEscapeRun: number): boolean => {
		const a = skipSeparatorJunk(pos);
		return (
			a >= len ||
			input[a] === "," ||
			input[a] === "}" ||
			input[a] === "]" ||
			input[a] === ":" ||
			isOuterStringEnd(a, innerEscapeRun)
		);
	};

	const isStandaloneMarkerEnd = (pos: number): boolean => {
		if (
			pos >= len ||
			isAssignmentWhitespace(input[pos]) ||
			",}]`".includes(input[pos])
		) {
			return true;
		}
		const quote = skipSeparatorJunk(pos);
		return (
			isQuoteChar(input[quote]) &&
			isStructuralAfter(quote + 1, escapeRunOf(quote))
		);
	};

	/**
	 * The close at a same-quote after a close run, null when the extent is
	 * unprovable, or undefined when the quote is content. Without structure
	 * after it, an unescaped value's quote is content: inside other
	 * serialized text, a JSON-encoded `\\'` carries an even run.
	 */
	const closeAfterRun = (
		afterRun: number,
		escapeRun: number,
	):
		| { valueEnd: number; closeStart: number; closeEnd: number }
		| null
		| undefined => {
		if (isStructuralAfter(afterRun + 1, escapeRun)) {
			// Trailing content backslashes belong to the value.
			const closeStart = afterRun - escapeRun;
			return { valueEnd: closeStart, closeStart, closeEnd: afterRun + 1 };
		}
		return escapeRun > 0 ? null : undefined;
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
	 *   same-quote closes.
	 * - any opening quote (a backslash run of length r >= 0 before it): a
	 *   same-quote whose run is a close run (`isCloseRun`: r, or r after
	 *   trailing content backslashes, as in `"a\\"`) closes it when followed
	 *   by structural continuation; without that continuation the extent of
	 *   an escaped value is unprovable, because content quotes at a uniform
	 *   depth never carry a close run, and for an unescaped value the quote
	 *   is content. Any other backslash sequence is content and scanning
	 *   continues, so an inner escaped quote can never truncate the value and
	 *   a non-structural tail omits the whole string.
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
					isCloseRun(closeRun, escapeRun)
				) {
					const closed = closeAfterRun(afterRun, escapeRun);
					if (closed !== undefined) return closed;
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

	/** A number ends at separator junk followed by a delimiter or the end. */
	const isNumberEnd = (pos: number, quoteEscapeRun: number): boolean => {
		const after = skipSeparatorJunk(pos);
		return (
			after >= len ||
			",}]".includes(input[after]) ||
			isOuterStringEnd(after, quoteEscapeRun)
		);
	};

	/** The reason a value reports: its key's text. */
	const reasonOf = (keyStart: number, keyEnd: number): string =>
		normalizeReason(
			maskedKey?.start === keyStart
				? maskedKey.text
				: input.slice(keyStart, keyEnd),
		);

	/**
	 * Parse one JSON number in a sensitive quoted-key value. The caller
	 * checks the key first, so short numeric values are only redacted in
	 * sensitive-key context. A prefix that is not followed by a delimiter
	 * (`1.`, `1e`, `01`) is not a number.
	 */
	const parseJsonNumberEnd = (
		start: number,
		quoteEscapeRun: number,
	): number | null => {
		numberToken.lastIndex = start;
		if (!numberToken.test(input)) return null;
		const end = numberToken.lastIndex;
		return isNumberEnd(end, quoteEscapeRun) ? end : null;
	};

	const isNumberLike = (pos: number): boolean =>
		input[pos] === "-" || (input[pos] >= "0" && input[pos] <= "9");

	/** The value of a sensitive quoted key, which is not itself quoted. */
	const parseNumericValue = (
		v: number,
		keyStart: number,
		keyEnd: number,
		quoteEscapeRun: number,
	): number => {
		const numericEnd = parseJsonNumberEnd(v, quoteEscapeRun);
		if (numericEnd === null) {
			// A number-like value with an ambiguous end must not escape scanning.
			if (!isNumberLike(v)) {
				return parseBareValue(v, keyStart, keyEnd, quoteEscapeRun);
			}
			allResolved = false;
			return len;
		}
		replacements.push({
			start: v,
			end: numericEnd,
			reason: reasonOf(keyStart, keyEnd),
			value: input.slice(v, numericEnd),
			quoteEscapeRun,
		});
		return numericEnd;
	};

	/** A `[REDACTED...` value is skipped only when it is a whole, standalone marker. */
	const parseMarkerValue = (v: number): number => {
		const markerEnd = input.indexOf("]", v) + 1;
		if (
			markerEnd > v &&
			COMPLETE_REDACTED_MARKER.test(input.slice(v, markerEnd)) &&
			isStandaloneMarkerEnd(markerEnd)
		) {
			return markerEnd;
		}
		// A marker prefix cannot authorize a malformed or secret-bearing tail.
		allResolved = false;
		return len;
	};

	/** A quoted value is replaced when its extent is provable and it is not already a marker. */
	const parseQuotedAssignment = (
		v: number,
		keyStart: number,
		keyEnd: number,
	): number => {
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
				reason: reasonOf(keyStart, keyEnd),
				value,
			});
		}
		// Both close forms end with the closing quote character. Resuming at it
		// lets the scan loop probe it as the opening quote of the next key, so
		// a long chain of shared quotes cannot recurse.
		return parsed.closeEnd - 1;
	};

	/**
	 * End of the unquoted value that starts at v and runs to the first stop
	 * character. A backslash run directly before a quote stop escapes that
	 * quote for an enclosing serialized string, so it is not value text:
	 * replacing it would break the string's structure. The run never reaches
	 * v, because the separator scan already consumed every backslash before it.
	 */
	const unquotedValueEnd = (
		v: number,
		isStop: (ch: string) => boolean,
	): number => {
		let end = v;
		while (end < len && !isStop(input[end])) end += 1;
		if (end < len && isQuoteChar(input[end])) {
			while (input[end - 1] === "\\") end -= 1;
		}
		return end;
	};

	/**
	 * A missing value, an object or array start, or a JSON literal that ends
	 * where a JSON value ends, after a sensitive quoted key. These are left
	 * alone; `true/x` is a word, not a literal.
	 */
	const isKeptBareValue = (v: number, quoteEscapeRun: number): boolean => {
		if (",}]{[".includes(input[v])) return true;
		jsonLiteralToken.lastIndex = v;
		return (
			jsonLiteralToken.test(input) &&
			isNumberEnd(jsonLiteralToken.lastIndex, quoteEscapeRun)
		);
	};

	/**
	 * A bare word after a sensitive quoted key, as in `"password": hunter2`, is
	 * parsed like the value of an unquoted key.
	 */
	const parseBareValue = (
		v: number,
		keyStart: number,
		keyEnd: number,
		quoteEscapeRun: number,
	): number =>
		v >= len || isKeptBareValue(v, quoteEscapeRun)
			? keyEnd
			: parseUnquotedValue(v, keyStart, keyEnd);

	/** An unquoted value is replaced unless it is already a complete marker. */
	const parseUnquotedValue = (
		v: number,
		keyStart: number,
		keyEnd: number,
	): number => {
		// Whitespace-delimited run without quotes or the punctuation that
		// would make a JSON value ambiguous.
		let end = unquotedValueEnd(v, isUnquotedValueStop);
		let value = input.slice(v, end);
		if (value.length < 6) {
			if (SHORT_NUMERIC_VALUE_PATTERN.test(value)) {
				replacements.push({
					start: v,
					end,
					reason: reasonOf(keyStart, keyEnd),
					value,
				});
				return end;
			}
			// Long free-text values may contain punctuation: fall back to the
			// rest of the line (12+ characters), mirroring the historical
			// assignment semantics.
			end = unquotedValueEnd(v, isLineValueStop);
			if (end - v < 12) return keyEnd;
			value = input.slice(v, end);
		}
		if (!COMPLETE_REDACTED_MARKER.test(value)) {
			replacements.push({
				start: v,
				end,
				reason: reasonOf(keyStart, keyEnd),
				value,
			});
		}
		return end;
	};

	/**
	 * The unquoted value of an assignment sits at the quote that may close the
	 * last failed quoted-key candidate, as in `{"msg":"Enter password:"}`. The
	 * quote either closes that string (no value) or opens a quoted value, as
	 * in `say "hi" then password=",abc"`. It closes the string only when
	 * structure follows it and the stretch after it holds nothing but
	 * separator junk (line breaks included), JSON or Python punctuation,
	 * numbers, and literals, Markdown fence backticks, and closes of enclosing
	 * strings, up to the end, an enclosing string end, or the opening quote of
	 * a sibling string (same character and escape run as the candidate's
	 * quotes). So no word and no possible content quote is left unread.
	 * Otherwise it opens the value, and an unprovable value extent omits the
	 * text. Limitations: a value made only of such tokens (`", 1234"`) reads
	 * as the string's close, and such a string followed by prose before the
	 * next sibling string (`{"msg":"Enter password:"} done`) is omitted.
	 */
	const parseCandidateClose = (
		v: number,
		keyStart: number,
		keyEnd: number,
	): number =>
		isStructuralAfter(v + 1, candidateOpenRun) && isNoValueStretch(v + 1)
			? keyEnd
			: parseQuotedAssignment(v, keyStart, keyEnd);

	/**
	 * End of the JSON punctuation, number, or literal at pos, or of a
	 * Markdown fence backtick, or -1.
	 */
	const jsonTokenEnd = (pos: number): number => {
		if (",:{}[]`".includes(input[pos])) return pos + 1;
		numberToken.lastIndex = pos;
		if (numberToken.test(input)) return numberToken.lastIndex;
		stretchLiteralToken.lastIndex = pos;
		return stretchLiteralToken.test(input) ? stretchLiteralToken.lastIndex : -1;
	};

	/** One separator junk character at pos: whitespace, a backslash, or an escape letter. */
	const isJunkAt = (pos: number): boolean =>
		" \t\n\r\\".includes(input[pos]) ||
		("ntr".includes(input[pos]) && input[pos - 1] === "\\");

	/**
	 * A quote of the candidate's character whose run is the candidate's
	 * (a sibling string opener) or shorter (the end of an enclosing string).
	 */
	const isSiblingOrOuterQuote = (pos: number): boolean =>
		input[pos] === input[candidateClose] &&
		escapeRunOf(pos) <= candidateOpenRun;

	/**
	 * Next stretch position after the quote at pos, or -1. A sibling opener
	 * or an enclosing string end (shorter run) ends the stretch (returns the
	 * text length). A quote of the other kind counts only as the close of an
	 * enclosing string, so structure or the end must follow it.
	 */
	const stretchQuoteEnd = (pos: number): number => {
		if (isSiblingOrOuterQuote(pos)) return len;
		return isStructuralAfter(pos + 1, escapeRunOf(pos)) ? pos + 1 : -1;
	};

	/** Next stretch position after the character at pos, or -1. */
	const stretchStepEnd = (pos: number): number => {
		if (isQuoteChar(input[pos])) return stretchQuoteEnd(pos);
		return isJunkAt(pos) ? pos + 1 : jsonTokenEnd(pos);
	};

	/** See `parseCandidateClose`: the stretch after a candidate close. */
	const isNoValueStretch = (pos: number): boolean => {
		let at = pos;
		while (at < len) {
			at = stretchStepEnd(at);
			if (at < 0) return false;
		}
		return true;
	};

	/**
	 * The quote that can close a failed quoted-key candidate, or -1: the
	 * first quote after the junk a value parse would skip (such as an encoded
	 * `\n`), with the opening quote's character and a run that closes it
	 * (trailing content backslashes may lengthen the run).
	 */
	const candidateCloseAfter = (openQuote: number, keyEnd: number): number => {
		const close = skipSeparatorJunk(keyEnd);
		return input[close] === input[openQuote] &&
			isCloseRun(escapeRunOf(close), escapeRunOf(openQuote))
			? close
			: -1;
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
		quoteEscapeRun = 0,
	): number => {
		const v = skipSeparatorJunk(cursor);
		if (v < len && isQuoteChar(input[v])) {
			return allowUnquoted && v === candidateClose
				? parseCandidateClose(v, keyStart, keyEnd)
				: parseQuotedAssignment(v, keyStart, keyEnd);
		}
		if (!allowUnquoted) {
			return parseNumericValue(v, keyStart, keyEnd, quoteEscapeRun);
		}
		if (input.startsWith("[REDACTED", v)) return parseMarkerValue(v);
		return parseUnquotedValue(v, keyStart, keyEnd);
	};

	/** End of the backslash run that starts at pos. */
	const backslashRunEnd = (pos: number): number => {
		let end = pos;
		while (end < len && input[end] === "\\") end += 1;
		return end;
	};

	/**
	 * The colon after a sensitive quoted key whose text stops at keyEnd, or
	 * -1. `close` is the end of the backslash run after the key. Key close: a
	 * quote after that run, or the run followed directly by the colon
	 * (malformed run form). Separator: JSON whitespace, its serialized/escaped
	 * forms, and asymmetric backslash runs around the colon.
	 */
	const keyColon = (keyEnd: number, close: number): number => {
		let separator = close;
		if (isQuoteChar(input[close])) separator = close + 1;
		else if (close === keyEnd || input[close] !== ":") return -1;
		const colon = skipSeparatorJunk(separator);
		return input[colon] === ":" ? colon : -1;
	};

	/**
	 * A sensitive key's own text can hold an unquoted assignment, as in
	 * `"secret token=abc":"b"`. The text has no quote, backslash, or newline,
	 * so a separate scan of it, bounded at the key end, finds exactly those
	 * assignments. They precede the key's value, which keeps the replacements
	 * in ascending order.
	 */
	const scanKeyText = (keyStart: number, keyEnd: number): void => {
		const keyText = input.slice(keyStart, keyEnd);
		if (!keyText.includes("=") && !keyText.includes(":")) return;
		const inner = scanSecretAssignments(keyText);
		for (const replacement of inner.replacements) {
			replacements.push({
				...replacement,
				start: replacement.start + keyStart,
				end: replacement.end + keyStart,
			});
		}
		if (!inner.allResolved) allResolved = false;
		if (inner.replacements.length > 0) {
			maskedKey = {
				start: keyStart,
				text: applyReplacements(keyText, inner.replacements),
			};
		}
	};

	/**
	 * Quoted-key candidate whose opening quote sits at openQuote. When the
	 * candidate is not an assignment, returns the position after the opening
	 * quote so its text is scanned as ordinary text.
	 */
	const scanQuotedKey = (openQuote: number): number => {
		const keyStart = openQuote + 1;
		let keyEnd = keyStart;
		while (keyEnd < len && isQuotedKeyChar(input[keyEnd])) keyEnd += 1;
		const close = backslashRunEnd(keyEnd);
		const colon = isSensitiveKey(input.slice(keyStart, keyEnd))
			? keyColon(keyEnd, close)
			: -1;
		if (colon < 0) {
			candidateClose = candidateCloseAfter(openQuote, keyEnd);
			candidateOpenRun = escapeRunOf(openQuote);
			return keyStart;
		}
		scanKeyText(keyStart, keyEnd);
		return parseValue(
			colon + 1,
			keyStart,
			keyEnd,
			false,
			escapeRunOf(openQuote),
		);
	};

	/** Unquoted-key candidate spanning [spanStart, spanEnd). */
	const scanUnquotedKey = (spanStart: number, spanEnd: number): number => {
		const key = input.slice(spanStart, spanEnd);
		if (!isSensitiveKey(key)) {
			return spanEnd;
		}
		const s = skipSeparatorJunk(spanEnd);
		if (s >= len || (input[s] !== ":" && input[s] !== "=")) {
			return spanEnd;
		}
		return parseValue(s + 1, spanStart, spanEnd, true);
	};

	/** Past a whole `[REDACTED:…]` marker at the cursor, else undefined. */
	const skipMarker = (cursor: number): number | undefined => {
		// A marker's reason can itself be a sensitive key. Keep the token
		// opaque; sticky matching bounds work even for malformed prefixes.
		if (!input.startsWith("[REDACTED:", cursor)) return undefined;
		markerToken.lastIndex = cursor;
		return markerToken.test(input) ? markerToken.lastIndex : undefined;
	};

	/** A backslash run is skipped, or leads to the quote that opens a key. */
	const scanBackslashRun = (cursor: number): number => {
		let runEnd = cursor;
		while (runEnd < len && input[runEnd] === "\\") runEnd += 1;
		return runEnd < len && isQuoteChar(input[runEnd])
			? scanQuotedKey(runEnd)
			: runEnd;
	};

	let cursor = 0;
	while (cursor < len && allResolved) {
		const ch = input[cursor];
		const afterMarker = skipMarker(cursor);
		if (afterMarker !== undefined) {
			cursor = afterMarker;
		} else if (ch === "\\") {
			cursor = scanBackslashRun(cursor);
		} else if (isQuoteChar(ch)) {
			cursor = scanQuotedKey(cursor);
		} else if (isUnquotedKeyChar(ch)) {
			let spanEnd = cursor;
			while (spanEnd < len && isUnquotedKeyChar(input[spanEnd])) spanEnd += 1;
			cursor = scanUnquotedKey(cursor, spanEnd);
		} else {
			cursor += 1;
		}
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
	const normalized = normalizeReason(reason);
	// PINs and OTPs have small value spaces; an unsalted fingerprint reveals them.
	const shortCode = /(?:^|-)(?:pin|otp)$/.test(normalized);
	return value && !shortCode
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

/**
 * Key names repeat across calls (environment variable names, payload field
 * names), and every redacted string checks the whole environment, so key
 * analysis is memoized. The result depends only on the name. The bound keeps
 * arbitrary payload keys from growing the caches without limit.
 */
const KEY_ANALYSIS_CACHE_LIMIT = 4_096;
const sensitiveKeyCache = new Map<string, boolean>();
const binaryKeyCache = new Map<string, boolean>();

function memoizedKeyTest(
	cache: Map<string, boolean>,
	key: string,
	test: (key: string) => boolean,
) {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const result = test(key);
	if (cache.size >= KEY_ANALYSIS_CACHE_LIMIT) cache.clear();
	cache.set(key, result);
	return result;
}

export function isSensitiveKey(key: string) {
	return memoizedKeyTest(sensitiveKeyCache, key, analyzeSensitiveKey);
}

function analyzeSensitiveKey(key: string) {
	const normalized = normalizeKey(key);
	if (
		PUBLIC_KEY_PATTERN.test(normalized) ||
		REQUEST_KEY_PATTERN.test(normalized)
	) {
		return false;
	}
	if (
		TOKEN_COUNT_KEY_PATTERN.test(normalized) ||
		PROVIDER_TOKEN_COUNT_KEYS.has(normalized)
	) {
		return false;
	}
	return (
		SENSITIVE_KEY_PATTERN.test(normalized) || TOKEN_KEY_PATTERN.test(normalized)
	);
}

export function isBinaryKey(key: string) {
	return memoizedKeyTest(binaryKeyCache, key, (name) =>
		BINARY_KEY_PATTERN.test(normalizeKey(name)),
	);
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
	add(config.identitySalt, "identity-salt");
	for (const secret of config.redactionAdditionalSecrets ?? []) {
		add(secret, "configured-secret");
	}
	// Reading process.env values crosses into native code, so only the
	// values of sensitive keys are read; every call still sees the current
	// environment.
	for (const key of Object.keys(env)) {
		if (key === "PI_LANGFUSE_REDACTION_SECRETS" || !isSensitiveKey(key)) {
			continue;
		}
		add(env[key], key);
	}

	return Array.from(secrets, ([value, reason]) => ({ value, reason })).sort(
		(a, b) => b.value.length - a.value.length,
	);
}

/**
 * Exact secrets that redaction replaces with fingerprint markers. In
 * pseudonymous mode the identity transform owns the salt and replaces it with
 * its fixed marker after redaction, so the salt is not also a redaction literal.
 */
function collectRedactionSecrets(
	config: RedactionConfig,
	env: NodeJS.ProcessEnv,
): ExactSecret[] {
	const secrets = collectExactSecrets(config, env);
	return config.identityMode === "pseudonymous"
		? secrets.filter((secret) => secret.reason !== "identity-salt")
		: secrets;
}

interface ExactSecretSnapshot {
	config: RedactionConfig;
	env: NodeJS.ProcessEnv;
	secrets: ExactSecret[];
}

let snapshotDepth = 0;
let exactSecretSnapshot: ExactSecretSnapshot | undefined;

/**
 * Run synchronous work that redacts many strings with one exact-secret
 * collection per config and environment object. No other code runs during a
 * synchronous call, so the result equals collecting per string, provided
 * `fn` itself changes neither. Collection reads the whole environment and
 * dominated the cost of shaping a record field by field. Async work started
 * inside `fn` collects afresh once the scope has returned.
 */
export function withRedactionSnapshot<T>(fn: () => T): T {
	snapshotDepth += 1;
	try {
		return fn();
	} finally {
		snapshotDepth -= 1;
		if (snapshotDepth === 0) exactSecretSnapshot = undefined;
	}
}

/** Exact secrets for one config/env pair, reused inside a snapshot scope. */
function redactionSecretsFor(
	config: RedactionConfig,
	env: NodeJS.ProcessEnv,
): ExactSecret[] {
	if (snapshotDepth === 0) return collectRedactionSecrets(config, env);
	if (
		exactSecretSnapshot?.config === config &&
		exactSecretSnapshot.env === env
	) {
		return exactSecretSnapshot.secrets;
	}
	const secrets = collectRedactionSecrets(config, env);
	exactSecretSnapshot = { config, env, secrets };
	return secrets;
}

/**
 * Redact one string against a precomputed exact-secret list. The list must
 * come from `collectRedactionSecrets` for the same config/env pair; callers own
 * its lifetime (see `sanitizeForTelemetry` for payload-granularity reuse).
 */
function serializedPlaceholder(replacement: SecretReplacement) {
	const text = placeholder(replacement.reason, replacement.value);
	if (replacement.quoteEscapeRun === undefined) return text;
	const escapes = "\\".repeat(replacement.quoteEscapeRun);
	return `${escapes}"${text}${escapes}"`;
}

/** Replace each located value by its placeholder; the replacements are in order. */
function applyReplacements(input: string, replacements: SecretReplacement[]) {
	const parts: string[] = [];
	let cursor = 0;
	for (const replacement of replacements) {
		parts.push(
			input.slice(cursor, replacement.start),
			serializedPlaceholder(replacement),
		);
		cursor = replacement.end;
	}
	parts.push(input.slice(cursor));
	return parts.join("");
}

/** Callers check that redaction is enabled and the input is not empty. */
function redactStringWithSecrets(
	input: string,
	exactSecrets: ExactSecret[],
): string {
	// Secret assignments are parsed by one shared forward tokenization. When
	// any value extent is unprovable, the whole string is omitted per the
	// omit-suspicious-text policy; provable values get structure-preserving
	// redaction placeholders.
	const scan = scanSecretAssignments(input);
	if (!scan.allResolved) return SUSPICIOUS_TEXT_MARKER;
	let output = applyReplacements(input, scan.replacements);

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

	// Existing derivatives can contain low-entropy fingerprints from older capture.
	return output.replace(
		/\[REDACTED:((?:[a-z0-9-]+-)?(?:pin|otp)):[0-9a-f]+\]/g,
		"[REDACTED:$1]",
	);
}

export function redactString(
	config: RedactionConfig,
	input: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	// Direct calls collect exact secrets fresh per string, so env/config
	// changes are always visible at one-string granularity; inside a
	// synchronous withRedactionSnapshot scope nothing can change between them.
	const identity = identityTransformFor(config);
	// Secret literals are matched against the original text: identity
	// normalization rewrites paths such as a configured secret that contains
	// the home directory, so it must run on the redacted result.
	const redacted =
		config.redactionEnabled && input
			? redactStringWithSecrets(input, redactionSecretsFor(config, env))
			: input;
	return identity ? identity.string(redacted) : redacted;
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
	rootKey?: string,
): T {
	// Identity protection is independent of secret redaction: pseudonymous
	// mode keeps the traversal even when redaction is disabled.
	const identity = identityTransformFor(config);
	if (!config.redactionEnabled && !limits && !identity) return value;
	const nodes = { count: 0 };

	// Exact secrets are collected lazily once per top-level call and reused
	// for every string in the payload, so the O(env) collection runs once
	// per payload instead of once per string. Env/config changes between
	// top-level calls stay visible; mutations made while one synchronous
	// traversal runs are not observed until the next call (payload-
	// granularity snapshot).
	let exactSecrets: ExactSecret[] | undefined;
	const exactSecretsForPayload = (): ExactSecret[] => {
		exactSecrets ??= redactionSecretsFor(config, env);
		return exactSecrets;
	};

	const redactText = (text: string): string =>
		config.redactionEnabled && text
			? redactStringWithSecrets(text, exactSecretsForPayload())
			: text;

	const boundText = (text: string): string => {
		const maxChars = limits?.maxStringChars ?? Infinity;
		return Number.isFinite(maxChars) && text.length > maxChars
			? text.slice(0, maxChars)
			: text;
	};

	const sanitizeString = (current: string): string => {
		// Redact the original text first; identity normalization could
		// otherwise rewrite a secret literal that contains the home path.
		const secretFree = redactText(current);
		return boundText(identity ? identity.string(secretFree) : secretFree);
	};

	/** One object field: sensitive and binary keys are masked, the rest recurse. */
	const sanitizeField = (
		key: string,
		item: unknown,
		depth: number,
	): unknown => {
		if (config.redactionEnabled && isSensitiveKey(key)) {
			return redactSensitiveField(item, key, Boolean(limits));
		}
		if (config.redactionEnabled && isBinaryKey(key)) {
			return redactBinaryField(item, key, Boolean(limits));
		}
		return sanitize(item, depth + 1);
	};

	const sanitize = (current: unknown, depth: number): unknown => {
		if (limits && nodes.count >= (limits.maxNodes ?? Infinity))
			return undefined;
		nodes.count += 1;

		if (typeof current === "string") return sanitizeString(current);
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
		for (const [key, rawItem] of entries.slice(0, keyLimit)) {
			if (limits && nodes.count >= (limits.maxNodes ?? Infinity)) break;
			const item = identity ? identity.entry(key, rawItem) : rawItem;
			const sanitized = sanitizeField(key, item, depth);
			if (sanitized !== undefined)
				output[identity ? identity.key(key) : key] = sanitized;
		}
		return output;
	};

	const start = identity && rootKey ? identity.entry(rootKey, value) : value;
	return sanitize(start, 0) as T;
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
