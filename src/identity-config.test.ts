import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canTrace, resolveConfig } from "./config.js";
import { exportRedactedData } from "./export.js";
import { loadOrCreateIdentitySalt } from "./identity-salt.js";
import { appendRawTrace, drainRawTraceQueue } from "./raw-trace.js";
import type { SettingsValues } from "./settings.js";

const SALT_PATTERN = /^[0-9a-f]{64}$/;
const IDENTITY_ENV = ["PI_LANGFUSE_IDENTITY", "PI_LANGFUSE_IDENTITY_KEEP_REPO"];
const pinnedConfigPath = process.env.PI_LANGFUSE_CONFIG;

let dir = "";
let configPath = "";

function settings(values: Record<string, unknown>) {
	return values as Partial<SettingsValues>;
}

function writeConfig(content: unknown) {
	writeFileSync(
		configPath,
		typeof content === "string" ? content : JSON.stringify(content, null, 2),
	);
}

function readConfig() {
	return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
		string,
		unknown
	>;
}

function directoryEntries() {
	return readdirSync(dir).sort();
}

beforeEach(() => {
	// Every path stays below the pinned temporary HOME from test/setup.ts.
	const home = process.env.HOME;
	if (!home || home !== homedir()) throw new Error("test HOME is not pinned");
	dir = mkdtempSync(join(home, "identity-config-"));
	configPath = join(dir, "pi-langfuse.json");
	process.env.PI_LANGFUSE_CONFIG = configPath;
	for (const key of IDENTITY_ENV) delete process.env[key];
});

afterEach(() => {
	for (const key of IDENTITY_ENV) delete process.env[key];
	process.env.PI_LANGFUSE_CONFIG = pinnedConfigPath;
	chmodSync(dir, 0o700);
	rmSync(dir, { recursive: true, force: true });
});

describe("identity configuration resolution", () => {
	it("defaults to raw, keeps repository identity off, and writes nothing", () => {
		const config = resolveConfig({});
		expect(config.identityMode).toBe("raw");
		expect(config.identityKeepRepo).toBe(false);
		expect(config.identitySalt).toBeUndefined();
		expect(config.identityError).toBeUndefined();
		expect(canTrace(config)).toBe(true);
		expect(directoryEntries()).toEqual([]);

		const content = '{"publicKey":"pk-from-file","unknown":{"keep":[1]}}\n';
		writeConfig(content);
		const withFile = resolveConfig({});
		expect(withFile.identityMode).toBe("raw");
		expect(readFileSync(configPath, "utf-8")).toBe(content);
		expect(directoryEntries()).toEqual(["pi-langfuse.json"]);
	});

	it("resolves settings before the config file before the environment", () => {
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";
		writeConfig({ identityMode: "raw" });
		expect(resolveConfig({}).identityMode).toBe("raw");
		expect(readConfig()).toEqual({ identityMode: "raw" });

		const fromSettings = resolveConfig(
			settings({ "identity-mode": "pseudonymous" }),
		);
		expect(fromSettings.identityMode).toBe("pseudonymous");
		expect(fromSettings.identitySalt).toMatch(SALT_PATTERN);

		rmSync(configPath);
		process.env.PI_LANGFUSE_IDENTITY = "Pseudonymous";
		expect(resolveConfig({}).identityMode).toBe("pseudonymous");
		// A blank higher-precedence value does not shadow a lower one.
		expect(resolveConfig(settings({ "identity-mode": " " })).identityMode).toBe(
			"pseudonymous",
		);

		process.env.PI_LANGFUSE_IDENTITY_KEEP_REPO = "true";
		expect(resolveConfig({}).identityKeepRepo).toBe(true);
		expect(
			resolveConfig(settings({ "identity-keep-repo": false })).identityKeepRepo,
		).toBe(false);
	});

	it("fails closed on an invalid mode or keep-repo value from any source", () => {
		const failing: Array<[string, () => ReturnType<typeof resolveConfig>]> = [
			[
				"identity-mode setting",
				() => resolveConfig(settings({ "identity-mode": "anonymous" })),
			],
			[
				"identityMode in the config file",
				() => {
					writeConfig({ identityMode: 5 });
					return resolveConfig({});
				},
			],
			[
				"PI_LANGFUSE_IDENTITY",
				() => {
					process.env.PI_LANGFUSE_IDENTITY = "pseudonym";
					return resolveConfig({});
				},
			],
			[
				"identity-keep-repo setting",
				() => resolveConfig(settings({ "identity-keep-repo": "maybe" })),
			],
			[
				"identityKeepRepo in the config file",
				() => {
					writeConfig({ identityKeepRepo: 1 });
					return resolveConfig({});
				},
			],
			[
				"PI_LANGFUSE_IDENTITY_KEEP_REPO",
				() => {
					process.env.PI_LANGFUSE_IDENTITY_KEEP_REPO = "sometimes";
					return resolveConfig({});
				},
			],
		];
		for (const [source, resolve] of failing) {
			for (const key of IDENTITY_ENV) delete process.env[key];
			rmSync(configPath, { force: true });
			const config = resolve();
			expect(config.identityError, source).toContain(source);
			// Never raw, never usable: the invalid input does not fall through.
			expect(config.identityMode, source).toBe("pseudonymous");
			expect(config.identitySalt, source).toBeUndefined();
			expect(canTrace(config), source).toBe(false);
		}
		// A higher-precedence invalid value is not rescued by a valid lower one.
		process.env.PI_LANGFUSE_IDENTITY = "raw";
		const config = resolveConfig(settings({ "identity-mode": "typo" }));
		expect(config.identityError).toContain("identity-mode setting");
		expect(canTrace(config)).toBe(false);
	});
});

describe("identity salt persistence", () => {
	it("creates a private salt at the configured path and keeps every existing key", () => {
		const existing = {
			publicKey: "pk-from-file",
			secretKey: "sk-from-file-secret",
			host: "http://127.0.0.1:9",
			defaultTags: ["a", "b"],
			identityKeepRepo: true,
			custom: { nested: [1, { two: 2 }], text: "kept" },
		};
		writeConfig(existing);
		chmodSync(configPath, 0o644);
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";

		const first = resolveConfig({});
		const stored = readConfig();

		expect(first.identityMode).toBe("pseudonymous");
		expect(first.identityKeepRepo).toBe(true);
		expect(first.identitySalt).toMatch(SALT_PATTERN);
		expect(stored).toEqual({ ...existing, identitySalt: first.identitySalt });
		// The resolved mode comes from the environment and is never persisted.
		expect(stored).not.toHaveProperty("identityMode");
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(directoryEntries()).toEqual(["pi-langfuse.json"]);
		// Credentials from the file still resolve.
		expect(first.publicKey).toBe("pk-from-file");
		expect(first.secretKey).toBe("sk-from-file-secret");

		const before = statSync(configPath);
		const second = resolveConfig({});
		expect(second.identitySalt).toBe(first.identitySalt);
		expect(statSync(configPath).ino).toBe(before.ino);
		expect(statSync(configPath).mtimeMs).toBe(before.mtimeMs);
	});

	it("honors PI_LANGFUSE_CONFIG and creates a missing private directory", () => {
		const nested = join(dir, "custom", "deeper", "pi-langfuse.json");
		process.env.PI_LANGFUSE_CONFIG = nested;
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";

		const config = resolveConfig({});

		expect(JSON.parse(readFileSync(nested, "utf-8"))).toEqual({
			identitySalt: config.identitySalt,
		});
		expect(statSync(nested).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "custom", "deeper")).mode & 0o077).toBe(0);
		// The default agent-dir location is not touched.
		const agentDir = process.env.PI_CODING_AGENT_DIR as string;
		expect(existsSync(join(agentDir, "langfuse", "pi-langfuse.json"))).toBe(
			false,
		);
	});

	it("keeps a symlinked config in place and writes the salt to its target", () => {
		const target = join(dir, "real.json");
		writeFileSync(target, '{"publicKey":"pk-linked"}');
		symlinkSync(target, configPath);
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";

		const config = resolveConfig({});

		expect(config.identitySalt).toMatch(SALT_PATTERN);
		expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({
			publicKey: "pk-linked",
			identitySalt: config.identitySalt,
		});
		expect(readFileSync(configPath, "utf-8")).toBe(
			readFileSync(target, "utf-8"),
		);
	});

	it("never overwrites malformed or non-object JSON and leaks no file content", () => {
		const cases = [
			'{"secretKey":"sk-snippet-aaaaaaaa" oops',
			"[]",
			"null",
			'"text"',
		];
		for (const content of cases) {
			writeConfig(content);
			// Settings decide the mode, so the salt step runs and must refuse.
			const config = resolveConfig(
				settings({ "identity-mode": "pseudonymous" }),
			);
			expect(config.identityError, content).toMatch(
				/identity salt unavailable/,
			);
			expect(config.identityError, content).not.toContain("sk-snippet");
			expect(config.identitySalt, content).toBeUndefined();
			expect(canTrace(config), content).toBe(false);
			expect(readFileSync(configPath, "utf-8"), content).toBe(content);
			expect(directoryEntries()).toEqual(["pi-langfuse.json"]);

			// Without a settings value the file's own mode cannot be known, and an
			// environment value (even raw) must not stand in for it.
			for (const envMode of ["pseudonymous", "raw", undefined]) {
				if (envMode) process.env.PI_LANGFUSE_IDENTITY = envMode;
				const undecided = resolveConfig({});
				expect(undecided.identityError, content).toMatch(
					/cannot be determined/,
				);
				expect(canTrace(undecided), content).toBe(false);
				delete process.env.PI_LANGFUSE_IDENTITY;
			}
			expect(readFileSync(configPath, "utf-8"), content).toBe(content);

			// An explicit raw setting is a decision and needs no salt.
			const raw = resolveConfig(settings({ "identity-mode": "raw" }));
			expect(raw.identityError, content).toBeUndefined();
			expect(readFileSync(configPath, "utf-8"), content).toBe(content);
		}
	});

	it("never regenerates an existing invalid salt", () => {
		for (const salt of ["short", "A".repeat(64), 7, null, ""]) {
			const content = JSON.stringify({ publicKey: "pk", identitySalt: salt });
			writeConfig(content);
			process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";

			const config = resolveConfig({});

			expect(config.identityError).toMatch(/identitySalt/);
			expect(config.identitySalt).toBeUndefined();
			expect(canTrace(config)).toBe(false);
			expect(readFileSync(configPath, "utf-8")).toBe(content);
		}
	});

	it("fails closed when the salt cannot be persisted", () => {
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";

		// The parent of the config path is a regular file.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		process.env.PI_LANGFUSE_CONFIG = join(blocker, "pi-langfuse.json");
		const blocked = resolveConfig({});
		expect(blocked.identityError).toMatch(/identity salt unavailable/);
		expect(blocked.identitySalt).toBeUndefined();
		expect(canTrace(blocked)).toBe(false);
		expect(readFileSync(blocker, "utf-8")).toBe("not a directory");

		// The config path is a directory.
		const asDirectory = join(dir, "is-a-directory");
		mkdirSync(asDirectory);
		process.env.PI_LANGFUSE_CONFIG = asDirectory;
		const directory = resolveConfig(
			settings({ "identity-mode": "pseudonymous" }),
		);
		expect(directory.identityError).toMatch(/identity salt unavailable/);
		expect(canTrace(directory)).toBe(false);
	});

	it.skipIf(process.getuid?.() === 0)(
		"refuses a read-only config file without changing it",
		() => {
			const content = '{"publicKey":"pk-read-only"}';
			writeConfig(content);
			chmodSync(configPath, 0o444);
			process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";

			const config = resolveConfig({});

			expect(config.identityError).toMatch(/identity salt unavailable/);
			expect(canTrace(config)).toBe(false);
			expect(readFileSync(configPath, "utf-8")).toBe(content);
			expect(directoryEntries()).toEqual(["pi-langfuse.json"]);
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"refuses an unwritable directory without leaving partial files",
		() => {
			process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";
			writeConfig({ publicKey: "pk" });
			chmodSync(dir, 0o500);

			const config = resolveConfig({});

			expect(config.identityError).toMatch(/identity salt unavailable/);
			expect(config.identitySalt).toBeUndefined();
			chmodSync(dir, 0o700);
			expect(directoryEntries()).toEqual(["pi-langfuse.json"]);
			expect(readConfig()).toEqual({ publicKey: "pk" });
		},
	);

	it("waits for a live process that owns an old lock and returns the salt it publishes", async () => {
		const existing = { publicKey: "pk-live-owner" };
		writeConfig(existing);
		const published = "d".repeat(64);
		const lock = `${configPath}.lock`;
		const script = join(dir, "live-owner.mjs");
		// The child plays a live initializer: it takes the lock, makes the lock
		// look very old (age must not matter), holds it, publishes a known
		// synthetic salt next to the existing keys, then releases the lock.
		writeFileSync(
			script,
			`import { closeSync, openSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
const [configPath, lock, salt] = process.argv.slice(2);
closeSync(openSync(lock, "wx", 0o600));
const old = new Date(Date.now() - 3_600_000);
utimesSync(lock, old, old);
process.stdout.write("locked\\n");
await new Promise((resolve) => setTimeout(resolve, 1_500));
const document = { ...JSON.parse(readFileSync(configPath, "utf-8")), identitySalt: salt };
writeFileSync(configPath + ".tmp", JSON.stringify(document));
renameSync(configPath + ".tmp", configPath);
unlinkSync(lock);
`,
		);
		const child = spawn(
			process.execPath,
			[script, configPath, lock, published],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		await new Promise<void>((resolve, reject) => {
			child.stdout.once("data", () => resolve());
			child.on("error", reject);
			child.on("close", () =>
				reject(new Error(`child exited before locking: ${stderr}`)),
			);
		});
		const startedAt = performance.now();

		// Blocks this thread, which is fine: the owner is another process.
		const salt = loadOrCreateIdentitySalt(configPath);

		expect(performance.now() - startedAt).toBeGreaterThan(500);
		expect(salt).toBe(published);
		expect(await exited).toBe(0);
		expect(readConfig()).toEqual({ ...existing, identitySalt: published });
		expect(existsSync(lock)).toBe(false);
		expect(directoryEntries()).toEqual(["live-owner.mjs", "pi-langfuse.json"]);
	}, 30_000);

	it("fails closed without touching an orphan lock after the bounded wait", () => {
		const content = '{"publicKey":"pk-orphan"}';
		writeConfig(content);
		const lock = `${configPath}.lock`;
		writeFileSync(lock, "owner-unknown");
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(lock, old, old);
		// Advance the monotonic clock past the wait instead of sleeping for it.
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => {
			now += 2_500;
			return now;
		});
		try {
			expect(() => loadOrCreateIdentitySalt(configPath)).toThrow(
				/lock .* still held.*delete the lock file yourself; pi-langfuse never removes it/,
			);
			process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";
			const config = resolveConfig({});
			expect(config.identityError).toMatch(/still held/);
			expect(canTrace(config)).toBe(false);
		} finally {
			clock.mockRestore();
		}

		// Neither the lock (however old) nor the config was taken over.
		expect(readFileSync(lock, "utf-8")).toBe("owner-unknown");
		expect(readFileSync(configPath, "utf-8")).toBe(content);
		expect(directoryEntries()).toEqual([
			"pi-langfuse.json",
			"pi-langfuse.json.lock",
		]);
	});

	it("shares one salt across processes that first use it concurrently", async () => {
		const existing = { publicKey: "pk-concurrent", custom: [1, 2, 3] };
		writeConfig(existing);
		const moduleUrl = new URL("./identity-salt.ts", import.meta.url).href;
		const script = join(dir, "first-use.mjs");
		writeFileSync(
			script,
			`import { loadOrCreateIdentitySalt } from ${JSON.stringify(moduleUrl)};
const startAt = Number(process.argv[3]);
while (Date.now() < startAt) {}
process.stdout.write(loadOrCreateIdentitySalt(process.argv[2]));
`,
		);
		const viteNode = fileURLToPath(
			new URL("../node_modules/.bin/vite-node", import.meta.url),
		);
		const startAt = Date.now() + 4_000;
		const outputs = await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise<string>((resolve, reject) => {
						const child = spawn(
							viteNode,
							[script, configPath, String(startAt)],
							{ stdio: ["ignore", "pipe", "pipe"] },
						);
						let stdout = "";
						let stderr = "";
						child.stdout.on("data", (chunk) => {
							stdout += chunk;
						});
						child.stderr.on("data", (chunk) => {
							stderr += chunk;
						});
						child.on("error", reject);
						child.on("close", (code) =>
							code === 0
								? resolve(stdout)
								: reject(new Error(`child exited ${code}: ${stderr}`)),
						);
					}),
			),
		);

		expect(new Set(outputs).size).toBe(1);
		expect(outputs[0]).toMatch(SALT_PATTERN);
		expect(readConfig()).toEqual({ ...existing, identitySalt: outputs[0] });
		expect(directoryEntries()).toEqual(["first-use.mjs", "pi-langfuse.json"]);
	}, 60_000);
});

describe("identity reload safety", () => {
	it("stops raw traces, tracing, and export when a reload turns invalid", () => {
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";
		const valid = resolveConfig({});
		expect(canTrace(valid)).toBe(true);
		expect(valid.identityError).toBeUndefined();
		const salt = valid.identitySalt;

		// The same settings reload after the salt was corrupted by hand.
		writeConfig({ ...readConfig(), identitySalt: "corrupted" });
		const reloaded = resolveConfig({});
		expect(reloaded.identityError).toMatch(/identitySalt/);
		expect(reloaded.identityMode).toBe("pseudonymous");
		expect(reloaded.identitySalt).toBeUndefined();
		expect(canTrace(reloaded)).toBe(false);
		expect(JSON.stringify(reloaded)).not.toContain(salt as string);
		// The corrupted value was kept for the user to repair, not replaced.
		expect(readConfig().identitySalt).toBe("corrupted");

		const rawTraceDir = join(dir, "raw");
		const sessionFile = join(dir, "sessions", "--project--", "s.jsonl");
		appendRawTrace(
			{ ...reloaded, rawTraceEnabled: true, rawTraceDir },
			sessionFile,
			{
				type: "session_start",
				timestamp: "2026-10-14T00:00:00.000Z",
				sessionFile,
			},
		);
		drainRawTraceQueue();
		expect(existsSync(rawTraceDir)).toBe(false);

		const out = join(dir, "export");
		const report = exportRedactedData(reloaded, ["--out", out]);
		expect(report.status).toBe("failed");
		expect(report.error?.code).toBe("identity-unavailable");
		expect(existsSync(out)).toBe(false);
	});

	it("exports under pseudonymous mode with home paths and user ids transformed", () => {
		process.env.PI_LANGFUSE_IDENTITY = "pseudonymous";
		const config = {
			...resolveConfig({}),
			rawTraceDir: join(dir, "raw"),
			redactionEnabled: false,
		};
		const home = config.identityHome as string;
		const rawProject = join(dir, "raw", "--project--");
		mkdirSync(rawProject, { recursive: true });
		writeFileSync(
			join(rawProject, "trace.jsonl"),
			`${JSON.stringify({ type: "x", userId: "someone", cwd: `${home}/work` })}\n`,
		);
		const out = join(dir, "export");

		const report = exportRedactedData(config, [
			"--out",
			out,
			"--raw-only",
			"--no-trufflehog",
		]);

		expect(report.status).not.toBe("failed");
		const exported = readFileSync(
			join(out, "raw-traces", "--project--", "trace.jsonl"),
			"utf-8",
		);
		// Export forces secret redaction on but keeps the identity policy.
		expect(exported).toContain("~/work");
		expect(exported).toMatch(/pseudonym-user-[0-9a-f]{24}/);
		expect(exported).not.toContain("someone");
	});
});
