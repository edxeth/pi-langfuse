import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadOrCreateIdentitySalt,
	type SaltFileOperations,
} from "./identity-salt.js";

/**
 * Real files in a temporary directory. The salt writer takes the three
 * operations whose failures an operating system produces only on demand (a
 * failing fsync, close, or unlink). Each test wraps the real functions to
 * inject one such fault; lock files are changed on disk, never faked.
 */
const REAL: SaltFileOperations = { closeSync, fsyncSync, unlinkSync };

function systemError(code: string) {
	return Object.assign(new Error(`${code}: injected fault`), { code });
}

/** The failing regression already closed this probe-owned descriptor. */
function releaseProbeDescriptor(fd: number) {
	try {
		closeSync(fd);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EBADF"
		) {
			throw error;
		}
	}
}

/** Real operations, except that fsync fails after the real call ran. */
function failingFsync(
	overrides: Partial<SaltFileOperations> = {},
): SaltFileOperations {
	return {
		...REAL,
		fsyncSync: (fd) => {
			fsyncSync(fd);
			throw systemError("EIO");
		},
		...overrides,
	};
}

/** Real operations, with `change` run while the creation lock is held. */
function changingLockDuringWrite(change: () => void): SaltFileOperations {
	return {
		...REAL,
		fsyncSync: (fd) => {
			change();
			fsyncSync(fd);
		},
	};
}

let dir = "";
let configPath = "";
let lockPath = "";

beforeEach(() => {
	// Every path stays below the pinned temporary HOME from test/setup.ts.
	const home = process.env.HOME;
	if (!home || home !== homedir()) throw new Error("test HOME is not pinned");
	dir = mkdtempSync(join(home, "identity-salt-faults-"));
	configPath = join(dir, "pi-langfuse.json");
	lockPath = `${configPath}.lock`;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("identity salt write failures", () => {
	it("reports the failure and leaves no temporary file or lock behind", () => {
		expect(() => loadOrCreateIdentitySalt(configPath, failingFsync())).toThrow(
			`pi-langfuse identity salt unavailable for ${configPath}: EIO: injected fault`,
		);

		expect(readdirSync(dir)).toEqual([]);
	});

	it("names a temporary descriptor that also fails to close", () => {
		const files = failingFsync({
			closeSync: (fd) => {
				closeSync(fd);
				throw systemError("EBADF");
			},
		});

		expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
			"EIO: injected fault; additionally the temporary file descriptor could not be closed (EBADF)",
		);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("keeps an unrelated descriptor open after a failed close releases the salt descriptor", () => {
		const unrelatedPath = join(dir, "unrelated.txt");
		writeFileSync(unrelatedPath, "canary");
		let releasedFd: number | undefined;
		let reusedFd: number | undefined;
		const files: SaltFileOperations = {
			...REAL,
			closeSync(fd) {
				closeSync(fd);
				if (reusedFd === undefined) {
					// Linux can release an fd before close reports an I/O error.
					// Opening another real file models concurrent reuse of its number.
					releasedFd = fd;
					reusedFd = openSync(unrelatedPath, "r");
					throw systemError("EIO");
				}
			},
		};

		try {
			expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
				/EIO: injected fault$/,
			);
			if (reusedFd === undefined) throw new Error("Expected descriptor reuse");
			expect(reusedFd).toBe(releasedFd);
			const readableFd = reusedFd;
			const byte = Buffer.alloc(1);
			expect(() => readSync(readableFd, byte, 0, 1, 0)).not.toThrow();
			expect(byte.toString()).toBe("c");
			expect(readdirSync(dir)).toEqual(["unrelated.txt"]);
		} finally {
			if (reusedFd !== undefined) {
				releaseProbeDescriptor(reusedFd);
			}
		}
	});

	it("reports a temporary file it cannot remove, by code and path", () => {
		const files = failingFsync({
			unlinkSync: () => {
				throw systemError("EACCES");
			},
		});

		let message = "";
		try {
			loadOrCreateIdentitySalt(configPath, files);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain(
			"EIO: injected fault; additionally the temporary file ",
		);
		expect(message).toContain("could not be removed (EACCES)");
		const leftover = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(leftover).toHaveLength(1);
		expect(message).toContain(join(dir, leftover[0] ?? ""));
	});

	it("reports an unremovable temporary file whose failure carries no system code", () => {
		const files = failingFsync({
			unlinkSync: () => {
				throw new Error("unlink refused");
			},
		});

		expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
			/EIO: injected fault; additionally the temporary file .* could not be removed \(unknown error\)$/,
		);
	});

	it("names a temporary descriptor whose close failure carries no system code", () => {
		const files = failingFsync({
			closeSync: (fd) => {
				closeSync(fd);
				throw new Error("close refused");
			},
		});

		expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
			"EIO: injected fault; additionally the temporary file descriptor could not be closed (unknown error)",
		);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("reports a failure that is not an Error object by its text", () => {
		const files: SaltFileOperations = {
			...REAL,
			fsyncSync: (fd) => {
				fsyncSync(fd);
				throw "disk on fire";
			},
		};

		expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
			`pi-langfuse identity salt unavailable for ${configPath}: disk on fire`,
		);
		expect(readdirSync(dir)).toEqual([]);
	});

	it.each([
		["a string", () => "unlink refused"],
		["null", () => null],
		[
			"an error whose code is not a string",
			() => Object.assign(new Error("unlink refused"), { code: 13 }),
		],
	])(
		"reports an unremovable temporary file whose failure is %s as an unknown error",
		(_name, fault) => {
			const files = failingFsync({
				unlinkSync: () => {
					throw fault();
				},
			});

			expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
				/could not be removed \(unknown error\)$/,
			);
		},
	);

	it("ignores a temporary file that is already gone", () => {
		const files = failingFsync({
			unlinkSync: (path) => {
				unlinkSync(path);
				throw systemError("ENOENT");
			},
		});

		expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
			/EIO: injected fault$/,
		);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("identity salt lock wait", () => {
	it("waits for another process to release the creation lock, then creates the salt", async () => {
		writeFileSync(lockPath, "another-process");
		const releaser = spawn(
			process.execPath,
			[
				"-e",
				`setTimeout(() => require("node:fs").unlinkSync(process.argv[1]), 150)`,
				lockPath,
			],
			{ stdio: "ignore" },
		);
		const exited = new Promise<void>((resolve) =>
			releaser.on("exit", () => resolve()),
		);

		// The writer blocks this thread while it waits, so only another process
		// can release the lock.
		const salt = loadOrCreateIdentitySalt(configPath);
		await exited;

		expect(salt).toMatch(/^[0-9a-f]{64}$/);
		expect(existsSync(lockPath)).toBe(false);
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({
			identitySalt: salt,
		});
	});
});

describe("identity salt lock release", () => {
	it("leaves a lock that another owner has replaced", () => {
		const files = changingLockDuringWrite(() =>
			writeFileSync(lockPath, "another-owner"),
		);

		const salt = loadOrCreateIdentitySalt(configPath, files);

		expect(salt).toMatch(/^[0-9a-f]{64}$/);
		expect(readFileSync(lockPath, "utf-8")).toBe("another-owner");
	});

	it("accepts a lock that has already disappeared", () => {
		const files = changingLockDuringWrite(() => unlinkSync(lockPath));

		expect(loadOrCreateIdentitySalt(configPath, files)).toMatch(
			/^[0-9a-f]{64}$/,
		);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("fails closed when the lock cannot be read for another reason", () => {
		// A directory in place of the lock file: reading it fails with EISDIR.
		const files = changingLockDuringWrite(() => {
			unlinkSync(lockPath);
			mkdirSync(lockPath);
		});

		expect(() => loadOrCreateIdentitySalt(configPath, files)).toThrow(
			`pi-langfuse identity salt unavailable for ${configPath}: EISDIR`,
		);
	});
});
