import { randomBytes } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { IDENTITY_SALT_KEY, IDENTITY_SALT_PATTERN } from "./identity.js";

const SALT_BYTES = 32;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
// Writers hold the lock only for one read and one rename. A waiter that
// cannot get the lock in this time fails closed. Lock age never proves its
// owner is dead (a paused process can resume), so an existing lock is never
// taken over or removed automatically.
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;

/**
 * The operations on the temporary salt file whose failures an operating
 * system produces only on demand (a failing fsync, close, or unlink). Tests
 * wrap the real functions to inject one such fault; every other operation
 * stays real.
 */
export interface SaltFileOperations {
	closeSync: (fd: number) => void;
	fsyncSync: (fd: number) => void;
	unlinkSync: (path: string) => void;
}

const REAL_FILE_OPERATIONS: SaltFileOperations = {
	closeSync,
	fsyncSync,
	unlinkSync,
};

export interface ConfigDocument {
	/** True when the file exists on disk. */
	exists: boolean;
	/** Parsed top-level JSON object; empty when the file is missing. */
	values: Record<string, unknown>;
}

/** The message of an error, or the text of any other thrown value. */
export function describeError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** The Node `code` of a system error, without assuming the error's shape. */
function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

/**
 * Read the config file strictly. Unlike the tolerant resolution path, a
 * malformed or non-object document is an error: it must never be rewritten,
 * and its identity settings cannot be known.
 */
export function readConfigDocument(path: string): ConfigDocument {
	if (!existsSync(path)) return { exists: false, values: {} };
	const content = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// The parser's message can quote file content, which may hold secrets.
		throw new Error(
			`${path} is not valid JSON; fix or remove it by hand. It was not modified.`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`${path} must contain a JSON object; fix or remove it by hand. It was not modified.`,
		);
	}
	// SAFETY: the guard above proved a non-null, non-array JSON object; its
	// values are validated key by key where they are used.
	return { exists: true, values: parsed as Record<string, unknown> };
}

function validSaltFrom(path: string, values: Record<string, unknown>) {
	if (!Object.hasOwn(values, IDENTITY_SALT_KEY)) return undefined;
	const salt = values[IDENTITY_SALT_KEY];
	if (typeof salt !== "string" || !IDENTITY_SALT_PATTERN.test(salt)) {
		// Regenerating would silently re-pseudonymize every earlier record.
		throw new Error(
			`${IDENTITY_SALT_KEY} in ${path} must be 64 lowercase hex characters; it was not replaced. Fix or remove that key by hand.`,
		);
	}
	return salt;
}

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the creation lock and return the token that proves ownership.
 * Waiting is bounded and measured on a monotonic clock. A lock that is still
 * there when the wait ends belongs to someone else: the caller fails closed
 * and the user decides, after checking that no initializer is running.
 */
function acquireLock(lockPath: string) {
	const token = randomBytes(16).toString("hex");
	const startedAt = performance.now();
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx", PRIVATE_FILE_MODE);
			try {
				writeFileSync(fd, token);
			} finally {
				closeSync(fd);
			}
			return token;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		if (performance.now() - startedAt >= LOCK_WAIT_MS) {
			throw new Error(
				`the identity salt lock ${lockPath} is still held after ${LOCK_WAIT_MS} ms. Another pi-langfuse process may be creating the salt, or one was killed while holding it. Verify that no Pi process is running, then delete the lock file yourself; pi-langfuse never removes it`,
			);
		}
		sleepSync(LOCK_POLL_MS);
	}
}

/** Remove the lock only while it still carries this process's token. */
function releaseLock(lockPath: string, token: string) {
	try {
		if (readFileSync(lockPath, "utf-8") !== token) return;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	unlinkSync(lockPath);
}

/**
 * Remove an unpublished temporary file after a failed write. Only an absent
 * file is ignored; any other failure is reported by code, never with content.
 */
function removeTemporary(
	temporary: string,
	cause: unknown,
	files: SaltFileOperations,
) {
	try {
		files.unlinkSync(temporary);
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT") return;
		throw new Error(
			`${describeError(cause)}; additionally the temporary file ${temporary} could not be removed (${code ?? "unknown error"})`,
			{ cause },
		);
	}
}

function writeAtomically(
	target: string,
	content: string,
	files: SaltFileOperations,
) {
	const temporary = join(
		dirname(target),
		`.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", PRIVATE_FILE_MODE);
		writeFileSync(fd, content, "utf-8");
		files.fsyncSync(fd);
		// Close may release the descriptor before reporting an error. Give up
		// ownership first so cleanup cannot close a number another thread reused.
		const closingFd = fd;
		fd = undefined;
		files.closeSync(closingFd);
		renameSync(temporary, target);
	} catch (error) {
		let failure: unknown = error;
		try {
			if (fd !== undefined) files.closeSync(fd);
		} catch (closeError) {
			failure = new Error(
				`${describeError(error)}; additionally the temporary file descriptor could not be closed (${errorCode(closeError) ?? "unknown error"})`,
				{ cause: error },
			);
		}
		removeTemporary(temporary, failure, files);
		throw failure;
	}
}

/**
 * Return the private identity salt stored beside the other config keys,
 * creating it on first use. Creation is serialized across processes by an
 * exclusive lock file, re-reads the document under the lock, preserves every
 * existing key, and replaces the file with an owner-only temp-file rename.
 * A lock held by another process is waited for, never taken over.
 * Throws when the path cannot be read or written, holds invalid data, or the
 * lock stays held.
 */
export function loadOrCreateIdentitySalt(
	configPath: string,
	files: SaltFileOperations = REAL_FILE_OPERATIONS,
): string {
	try {
		const current = readConfigDocument(configPath);
		const existing = validSaltFrom(configPath, current.values);
		if (existing) return existing;

		// Follow a symlinked config so the link keeps pointing at its target.
		const target = current.exists ? realpathSync(configPath) : configPath;
		if (current.exists) accessSync(target, constants.W_OK);
		mkdirSync(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
		const lockPath = `${target}.lock`;
		const token = acquireLock(lockPath);
		try {
			const locked = readConfigDocument(target);
			const concurrent = validSaltFrom(target, locked.values);
			if (concurrent) return concurrent;
			const salt = randomBytes(SALT_BYTES).toString("hex");
			writeAtomically(
				target,
				`${JSON.stringify({ ...locked.values, [IDENTITY_SALT_KEY]: salt }, null, 2)}\n`,
				files,
			);
			return salt;
		} finally {
			releaseLock(lockPath, token);
		}
	} catch (error) {
		throw new Error(
			`pi-langfuse identity salt unavailable for ${configPath}: ${describeError(error)}`,
		);
	}
}
