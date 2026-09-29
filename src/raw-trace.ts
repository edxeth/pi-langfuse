import {
	appendFileSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	type PayloadPolicyConfig,
	shapeRawTraceRecord,
} from "./payload-policy.js";
import { recordRuntimeError } from "./runtime-diagnostics.js";

// Raw traces hold private prompt/tool data, so new files are owner-only and
// new directories are private regardless of the process umask.
const RAW_TRACE_DIR_MODE = 0o700;
const RAW_TRACE_FILE_MODE = 0o600;
// O_NOFOLLOW and O_NONBLOCK are unavailable on some platforms; 0 keeps the
// open portable where a flag is missing.
const NO_FOLLOW_FLAG =
	typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NONBLOCK_FLAG =
	typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

interface RawTraceConfig extends PayloadPolicyConfig {
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

interface QueuedWrite {
	path: string;
	config: RawTraceConfig;
	record: RawTraceRecord;
}

const writeQueue: QueuedWrite[] = [];
let flushScheduled = false;

function scheduleFlush() {
	if (flushScheduled) return;
	flushScheduled = true;
	queueMicrotask(() => {
		flushScheduled = false;
		flushQueue();
	});
}

function flushQueue() {
	while (writeQueue.length > 0) {
		const item = writeQueue.shift();
		if (!item) break;
		const { path, config, record } = item;
		try {
			const sanitizedRecord = shapeRawTraceRecord(config, record);
			appendPrivateTrace(
				path,
				`${JSON.stringify(sanitizedRecord, jsonReplacer)}\n`,
			);
		} catch (error) {
			recordRuntimeError("Failed to write raw trace", error);
		}
	}
}

/**
 * Append to a raw trace file without widening access to it.
 *
 * New files are created owner-only (0600). The open is nonblocking and
 * no-follow (where the platform supports the flags), and the open descriptor
 * is checked before any write or mode change: non-regular files (e.g. a
 * planted FIFO or device) and multiply-linked inodes (hardlinks into
 * unrelated user files) are refused. Symlinked paths are refused outright so
 * trace bytes can never be redirected into an unrelated file. Pre-existing
 * directory modes are left untouched so unrelated files are never chmod'ed.
 * Known limitation: components between the trace root and the file are only
 * checked by name, so a component swapped to a symlink between that check
 * and the open is not detected (the final component is protected by
 * O_NOFOLLOW).
 */
function appendPrivateTrace(path: string, data: string) {
	if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`raw trace path is a symlink: ${path}`);
	}
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_APPEND |
			constants.O_CREAT |
			NONBLOCK_FLAG |
			NO_FOLLOW_FLAG,
		RAW_TRACE_FILE_MODE,
	);
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) {
			throw new Error(`raw trace path is not a regular file: ${path}`);
		}
		if (info.nlink > 1) {
			throw new Error(
				`raw trace path has ${info.nlink} hard links; refusing to modify a shared inode: ${path}`,
			);
		}
		// Tighten files created before private modes were applied.
		fchmodSync(fd, RAW_TRACE_FILE_MODE);
		appendFileSync(fd, data, "utf-8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Flush any pending raw trace writes synchronously.
 * Call before process exit to avoid losing queued records.
 */
export function drainRawTraceQueue() {
	flushScheduled = false;
	flushQueue();
}

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
	const candidate = relativePath.includes("/")
		? join(rawTraceDir, relativePath)
		: join(rawTraceDir, "--unknown--", relativePath);
	// Session paths are external input: `..` segments or any other escape
	// from the trace directory is refused instead of written outside it.
	const root = resolve(rawTraceDir);
	const resolved = resolve(candidate);
	if (resolved !== root && !resolved.startsWith(root + sep)) return undefined;
	return resolved;
}

/**
 * Refuse when any directory component below the trace root is a symlink:
 * writing through it would place trace bytes outside the trace directory.
 * Components at or above the trace root are not checked; a user-configured
 * symlinked trace root is user intent.
 */
function assertTraceComponentsSafe(path: string, root: string) {
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return;
	let current = root;
	for (const segment of rel.split(sep)) {
		if (!segment) continue;
		current = join(current, segment);
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`raw trace directory component is a symlink: ${current}`);
		}
	}
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

/**
 * Enqueue a raw trace record for asynchronous writing.
 * Returns immediately — actual redaction + file I/O happens on the next
 * microtask, so the Pi event handler is never blocked by regex redaction
 * or synchronous file writes.
 */
export function appendRawTrace(
	config: RawTraceConfig,
	sessionFile: string | undefined,
	record: RawTraceRecord,
) {
	if (!config.rawTraceEnabled || !sessionFile) return;
	const path = rawTracePathForSession(sessionFile, config.rawTraceDir);
	if (!path) return;
	try {
		assertTraceComponentsSafe(dirname(path), resolve(config.rawTraceDir));
		mkdirSync(dirname(path), { recursive: true, mode: RAW_TRACE_DIR_MODE });
	} catch (error) {
		// Unsafe path components and preparation failures both skip the
		// record; a write is never enqueued for a directory that could not be
		// prepared safely.
		recordRuntimeError("Failed to prepare raw trace directory", error);
		return;
	}
	writeQueue.push({ path, config, record });
	scheduleFlush();
}
