import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, resolveConfig } from "./config.js";
import { runLocalAutostart } from "./local-autostart.js";
import { getLastRuntimeError } from "./runtime-diagnostics.js";

type SpawnCall = [
	string,
	string[],
	{ env?: NodeJS.ProcessEnv } & Record<string, unknown>,
];

function fakeSpawn(onChild?: (child: EventEmitter) => void) {
	const unref = vi.fn();
	const spawnImpl = vi.fn(() => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		child.unref = unref;
		onChild?.(child);
		return child;
	});
	return { spawnImpl, unref, typed: spawnImpl as unknown as typeof spawn };
}

/** Loopback health endpoint that answers 200 after `delayMs`, or when released. */
async function startHealthServer(delayMs: number | "held") {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let answered = 0;
	const server: Server = createServer((_request, response) => {
		const answer = () => {
			answered += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"status":"OK"}');
		};
		if (delayMs === "held") void released.then(answer);
		else setTimeout(answer, delayMs);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/api/public/health`,
		release,
		answered: () => answered,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

describe("local Langfuse autostart", () => {
	let stackDir: string;
	let realFetch: typeof globalThis.fetch;
	const savedEnvironment = new Map<string, string | undefined>();

	function setEnvironment(key: string, value: string | undefined) {
		if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	function autostartConfig(overrides: Partial<Config> = {}) {
		return {
			localAutostart: true,
			localAutostartDir: stackDir,
			// Port 9 (discard) is closed on loopback, so the probe is refused.
			localAutostartHealthUrl: "http://127.0.0.1:9/api/public/health",
			localAutostartTimeoutMs: 2_000,
			...overrides,
		} as Config;
	}

	beforeEach(async () => {
		stackDir = await mkdtemp(join(tmpdir(), "pi-langfuse-autostart-test-"));
		await writeFile(join(stackDir, "docker-compose.yml"), "services: {}\n");
		setEnvironment("PI_LANGFUSE_AUTOSTART", "1");
		realFetch = globalThis.fetch;
	});

	afterEach(async () => {
		globalThis.fetch = realFetch;
		for (const [key, value] of savedEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		savedEnvironment.clear();
		await rm(stackDir, { recursive: true, force: true });
	});

	it("handles asynchronous spawn errors without crashing or claiming success", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { spawnImpl, unref, typed } = fakeSpawn((child) => {
			// Node reports spawn failures (e.g. ENOENT) asynchronously.
			queueMicrotask(() => {
				child.emit(
					"error",
					Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
				);
			});
		});
		globalThis.fetch = async () => {
			throw new Error("connection refused");
		};

		await expect(
			runLocalAutostart(
				autostartConfig({ localAutostartTimeoutMs: 50 }),
				typed,
			),
		).resolves.toBeUndefined();
		await vi.waitFor(() =>
			expect(getLastRuntimeError()?.message).toContain("ENOENT"),
		);

		expect(spawnImpl).toHaveBeenCalledOnce();
		expect(unref).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		expect(getLastRuntimeError()?.message).toContain(
			"failed to autostart local Langfuse",
		);
		warn.mockRestore();
	});

	it("leaves a healthy stack alone when its health check answers in about 250 ms", async () => {
		// The real self-hosted health endpoint answers in a steady ~205 ms.
		const health = await startHealthServer(250);
		const { spawnImpl, typed } = fakeSpawn();
		try {
			await runLocalAutostart(
				autostartConfig({
					localAutostartHealthUrl: health.url,
					localAutostartTimeoutMs: resolveConfig({}).localAutostartTimeoutMs,
				}),
				typed,
			);
		} finally {
			await health.close();
		}

		expect(spawnImpl).not.toHaveBeenCalled();
		expect(health.answered()).toBe(1);
	});

	it("starts a stopped stack without recreating containers or leaking the caller's Compose variables", async () => {
		// Variables the Compose file interpolates, set by a project environment
		// such as devenv. Passing them would make Compose recreate Postgres.
		const leaked = {
			POSTGRES_USER: "project-user",
			POSTGRES_PASSWORD: "project-password",
			POSTGRES_DB: "project-db",
			DATABASE_URL: "postgresql://project",
			REDIS_HOST: "project-redis",
			CLICKHOUSE_URL: "http://project-clickhouse",
			LANGFUSE_INIT_PROJECT_ID: "other-project",
			COMPOSE_PROJECT_NAME: "other-stack",
			COMPOSE_FILE: "/elsewhere/docker-compose.yml",
		};
		for (const [key, value] of Object.entries(leaked))
			setEnvironment(key, value);
		setEnvironment("DOCKER_HOST", "unix:///run/user/1000/docker.sock");
		setEnvironment("DOCKER_CONFIG", "/home/user/.docker-alt");
		const { spawnImpl, typed } = fakeSpawn();

		await runLocalAutostart(autostartConfig(), typed);

		expect(spawnImpl).toHaveBeenCalledOnce();
		const [command, args, options] = spawnImpl.mock
			.calls[0] as unknown as SpawnCall;
		expect(command).toBe("docker");
		expect(args).toEqual(["compose", "up", "-d", "--no-recreate"]);
		expect(options).toMatchObject({
			cwd: stackDir,
			detached: true,
			stdio: "ignore",
		});
		const env = options.env ?? {};
		for (const key of Object.keys(leaked)) expect(env).not.toHaveProperty(key);
		expect(env.PATH).toBe(process.env.PATH);
		expect(env.HOME).toBe(process.env.HOME);
		expect(env.DOCKER_HOST).toBe("unix:///run/user/1000/docker.sock");
		expect(env.DOCKER_CONFIG).toBe("/home/user/.docker-alt");
	});

	it("returns to the prompt before the health check answers", async () => {
		vi.resetModules();
		const { ensureLocalLangfuseStarted } = await import("./local-autostart.js");
		const health = await startHealthServer("held");
		const { typed } = fakeSpawn();
		try {
			const outcome = await Promise.race([
				ensureLocalLangfuseStarted(
					autostartConfig({
						localAutostartHealthUrl: health.url,
						localAutostartTimeoutMs: 5_000,
					}),
					typed,
				).then(() => "returned"),
				new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
			]);
			expect(outcome).toBe("returned");
			expect(health.answered()).toBe(0);
		} finally {
			health.release();
			await vi.waitFor(() => expect(health.answered()).toBe(1));
			await health.close();
		}
	});
});
