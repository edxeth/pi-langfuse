import { createHmac } from "node:crypto";
import { homedir } from "node:os";

/**
 * Identity pseudonymization.
 *
 * `pseudonymous` mode is applied at the shared output sanitizer
 * (`sanitizeForTelemetry` / `redactString`), so Langfuse bodies, raw traces,
 * scores, and exports share one policy. It replaces the user's home
 * directory prefix with `~`, replaces the home directory inside Pi's encoded
 * session-folder names, and hashes the OS-level user id and known repository
 * identity fields with a private per-config salt.
 *
 * This is pseudonymization, not anonymization: file names below the home
 * directory, branch names, commit hashes, code, prompts, and tool output stay
 * as captured and can still identify a person or repository.
 */

/** Supported identity modes; `raw` is the default. */
export const IDENTITY_MODES = ["raw", "pseudonymous"] as const;
/** One resolved identity mode. */
export type IdentityMode = (typeof IDENTITY_MODES)[number];

/** Identity settings shared by outgoing telemetry sanitizers. */
export interface IdentityConfig {
	/** Absent or `raw` leaves every payload untouched. */
	identityMode?: IdentityMode;
	/** Keep repository identity metadata readable in pseudonymous mode. */
	identityKeepRepo?: boolean;
	/** Private per-config salt (64 lowercase hex characters). */
	identitySalt?: string;
	/** Home directory to normalize; defaults to the current user's home. */
	identityHome?: string;
	/**
	 * Set when the identity configuration is invalid or its salt could not be
	 * loaded or persisted. Telemetry and raw traces must not be emitted.
	 */
	identityError?: string;
}

/** A valid salt is 32 random bytes written as lowercase hex. */
export const IDENTITY_SALT_PATTERN = /^[0-9a-f]{64}$/;
/** Key under which the salt is stored in `pi-langfuse.json`. */
export const IDENTITY_SALT_KEY = "identitySalt";

const SALT_MARKER = "[REDACTED:identity-salt]";
const PSEUDONYM_PATTERN = /^pseudonym-[a-z-]+-[0-9a-f]{24}$/;
const PSEUDONYM_HEX_CHARS = 24;
const PROJECT_TAG_PREFIX = "project:";
const REPO_KEYS: ReadonlySet<string> = new Set([
	"repo_identity",
	"repo_owner",
	"repo_name",
	"git_remote_path",
	"repo_root_name",
]);

/** Parse a mode spelling (trimmed, case-insensitive); undefined when invalid. */
export function parseIdentityMode(value: unknown): IdentityMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return IDENTITY_MODES.find((mode) => mode === normalized);
}

/** Accept only unambiguous boolean spellings; anything else is invalid. */
export function parseStrictBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

/** Output transformations derived from one validated identity configuration. */
export interface IdentityTransform {
	/** Normalize home prefixes (plain and encoded) and the salt literal. */
	string(value: string): string;
	/** Same normalization for object keys. */
	key(key: string): string;
	/**
	 * Replace the value of a known identity field (user id, repository
	 * identity, project tag, salt). Other keys return the value unchanged.
	 * Already pseudonymized values are never hashed again.
	 */
	entry(key: string, value: unknown): unknown;
}

function normalizeKey(key: string) {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spellings of one home directory as it appears in plain and JSON text. */
function homeSpellings(home: string) {
	const trimmed = home.replace(/[\\/]+$/, "");
	if (trimmed.length < 2) return [];
	return [
		...new Set([
			trimmed,
			trimmed.replaceAll("\\", "\\\\"),
			trimmed.replaceAll("\\", "/"),
		]),
	].sort((a, b) => b.length - a.length);
}

/** Pi names a session folder after the whole working directory. */
function encodedHome(home: string) {
	return home
		.replace(/[\\/]+$/, "")
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");
}

interface HomeRewrite {
	/** Substrings whose presence means a home spelling may need rewriting. */
	needles: string[];
	patterns: RegExp[];
}

function homeRewrite(home: string): HomeRewrite {
	const spellings = homeSpellings(home);
	if (spellings.length === 0) return { needles: [], patterns: [] };
	// Non-empty spellings have a non-empty encoded form: only a path made of
	// separators alone encodes to nothing, and it has no spelling.
	const encoded = encodedHome(home);
	// The match ends at a directory boundary, so `/home/dev` does not rewrite
	// `/home/developer`. It must also start an absolute path: a longer path
	// (`/srv/home/dev`) or a relative one (`./home/dev`, `~/home/dev`) is a
	// different directory. Text glued to the path by a flag or label
	// (`-I/home/dev`, `env-/home/dev`) still leaks the user, so it is rewritten.
	const homePattern = new RegExp(
		`(?<!/[A-Za-z0-9_.~-]+)(?<![.~])(?:${spellings.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
		"g",
	);
	const encodedPattern = new RegExp(
		`(?<=--)${escapeRegExp(encoded)}(?=-)`,
		"g",
	);
	return {
		needles: [...spellings, encoded],
		patterns: [homePattern, encodedPattern],
	};
}

function createStringTransform(salt: string, home: string) {
	const rewrite = homeRewrite(home);
	const needles = [...rewrite.needles, salt].filter(Boolean);
	return (value: string) => {
		if (!needles.some((needle) => value.includes(needle))) return value;
		return rewrite.patterns.reduce(
			(output, pattern) => output.replace(pattern, "~"),
			value.split(salt).join(SALT_MARKER),
		);
	};
}

function pseudonym(salt: string, label: string, value: string) {
	const digest = createHmac("sha256", salt)
		.update(`${label}\0${value}`)
		.digest("hex");
	return `pseudonym-${label}-${digest.slice(0, PSEUDONYM_HEX_CHARS)}`;
}

function hashOnce(salt: string, label: string, value: string) {
	return value === "" || PSEUDONYM_PATTERN.test(value)
		? value
		: pseudonym(salt, label, value);
}

function projectTag(salt: string, tag: unknown) {
	if (typeof tag !== "string" || !tag.startsWith(PROJECT_TAG_PREFIX)) {
		return tag;
	}
	return `${PROJECT_TAG_PREFIX}${hashOnce(salt, "project", tag.slice(PROJECT_TAG_PREFIX.length))}`;
}

function transformUserId(salt: string, value: unknown) {
	return typeof value === "string" || typeof value === "number"
		? hashOnce(salt, "user", String(value))
		: value;
}

function transformRepoEntry(salt: string, normalized: string, value: unknown) {
	if (REPO_KEYS.has(normalized) && typeof value === "string") {
		return hashOnce(salt, normalized.replaceAll("_", "-"), value);
	}
	if (normalized === "tags" && Array.isArray(value)) {
		return value.map((tag) => projectTag(salt, tag));
	}
	return value;
}

function transformEntry(
	salt: string,
	keepRepo: boolean,
	key: string,
	value: unknown,
) {
	const normalized = normalizeKey(key);
	if (normalized === "identity_salt") return SALT_MARKER;
	if (normalized === "user_id") return transformUserId(salt, value);
	if (keepRepo) return value;
	return transformRepoEntry(salt, normalized, value);
}

function createTransform(
	salt: string,
	home: string,
	keepRepo: boolean,
): IdentityTransform {
	const string = createStringTransform(salt, home);
	return {
		string,
		key: string,
		entry: (key, value) => transformEntry(salt, keepRepo, key, value),
	};
}

let cached: { key: string; transform: IdentityTransform } | undefined;

function requireValidSalt(salt: string | undefined): string {
	if (!salt || !IDENTITY_SALT_PATTERN.test(salt)) {
		throw new Error(
			"pi-langfuse: identity mode is pseudonymous but no valid identity salt is available; refusing to emit telemetry",
		);
	}
	return salt;
}

/**
 * Transform for the config's identity policy, or undefined in raw mode.
 * Pseudonymous mode without a valid salt throws: the output boundary must
 * never fall back to emitting raw identity.
 */
export function identityTransformFor(
	config: IdentityConfig,
): IdentityTransform | undefined {
	if (config.identityMode !== "pseudonymous") return undefined;
	const salt = requireValidSalt(config.identitySalt);
	const home = config.identityHome ?? homedir();
	const keepRepo = config.identityKeepRepo === true;
	const key = JSON.stringify([salt, home, keepRepo]);
	if (cached?.key !== key) {
		cached = { key, transform: createTransform(salt, home, keepRepo) };
	}
	return cached.transform;
}
