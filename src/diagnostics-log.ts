import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	mkdirSync,
	openSync,
	renameSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local record of every diagnostic the extension raised. Pi notifications
 * and stderr are not persisted, so without this file a warning seen mid-work
 * cannot be traced back later. Messages are already sanitized by the caller.
 */
export const DIAGNOSTICS_LOG_MAX_BYTES = 1_000_000;
const DIAGNOSTICS_DIR_MODE = 0o700;
const DIAGNOSTICS_FILE_MODE = 0o600;
// O_NOFOLLOW and O_NONBLOCK are unavailable on some platforms; 0 keeps the
// open portable where a flag is missing. O_NONBLOCK makes a FIFO that nothing
// reads fail at once instead of blocking Pi until a reader appears.
const NO_FOLLOW_FLAG =
	typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NONBLOCK_FLAG =
	typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

export function defaultDiagnosticsLogPath() {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"langfuse",
		"diagnostics.jsonl",
	);
}

/**
 * Append one diagnostic as a JSON line to an owner-only file. When the file
 * would grow past `maxBytes`, it becomes `<path>.1` (replacing the older
 * one) and a new file starts. Symlinks, non-regular files, and files with
 * more than one hard link are refused, as for raw traces, and an existing
 * file is made owner-only before it is written. Throws on I/O failure; the
 * caller decides how to report it.
 */
export function appendDiagnostic(
	path: string,
	entry: { message: string },
	maxBytes = DIAGNOSTICS_LOG_MAX_BYTES,
) {
	const line = `${JSON.stringify({
		timestamp: new Date().toISOString(),
		pid: process.pid,
		message: entry.message,
	})}\n`;
	mkdirSync(dirname(path), { recursive: true, mode: DIAGNOSTICS_DIR_MODE });
	let fd = openForAppend(path);
	try {
		if (fstatSync(fd).size + Buffer.byteLength(line) > maxBytes) {
			closeSync(fd);
			renameSync(path, `${path}.1`);
			fd = openForAppend(path);
		}
		writeSync(fd, line);
	} finally {
		closeSync(fd);
	}
}

function openForAppend(path: string) {
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_APPEND |
			constants.O_CREAT |
			NONBLOCK_FLAG |
			NO_FOLLOW_FLAG,
		DIAGNOSTICS_FILE_MODE,
	);
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) {
			throw new Error(`diagnostics log is not a regular file: ${path}`);
		}
		if (info.nlink > 1) {
			throw new Error(
				`diagnostics log has ${info.nlink} hard links; refusing to modify a shared inode: ${path}`,
			);
		}
		// The open mode applies only to a new file; tighten an older one.
		fchmodSync(fd, DIAGNOSTICS_FILE_MODE);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/**
 * The underlying cause of a diagnostic. Lifecycle code wraps a runtime error
 * as "Failed to <operation>: <error>"; when the error is itself a Langfuse
 * message, every operation that hit it shares one cause. Timings, attempt
 * counts, sizes, and span or trace ids differ between failures of one
 * outage, so they do not distinguish causes; HTTP statuses do.
 */
export function diagnosticCause(message: string) {
	let cause = message.replace(/^Langfuse:\s*/, "");
	for (;;) {
		const nested = /^Failed to [^:]+:\s*(Langfuse\b[\s\S]*)$/.exec(cause);
		if (!nested?.[1]) break;
		cause = nested[1].replace(/^Langfuse:\s*/, "");
	}
	return cause
		.replace(/\b[0-9a-f]{16,}\b/gi, "#")
		.replace(/(?<!HTTP )\b\d+/g, "#");
}

/** Past this many remembered causes, expired ones are dropped. */
const NOTIFICATION_GATE_PRUNE_AT = 64;

/**
 * Decide whether a cause is shown to the operator: once per `windowMs`.
 * Repeats inside the window still reach the log. Causes whose window has
 * passed are forgotten, so the gate stays small however long Pi runs.
 */
export function createNotificationGate(
	windowMs: number,
	now: () => number = Date.now,
) {
	const shownAt = new Map<string, number>();
	return (cause: string) => {
		const time = now();
		const last = shownAt.get(cause);
		if (last !== undefined && time - last < windowMs) return false;
		if (shownAt.size >= NOTIFICATION_GATE_PRUNE_AT) {
			for (const [key, at] of shownAt) {
				if (time - at >= windowMs) shownAt.delete(key);
			}
		}
		shownAt.set(cause, time);
		return true;
	};
}
