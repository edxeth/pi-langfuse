import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { ensureLocalLangfuseStarted } from "./local-autostart.js";
import { getLastRuntimeError } from "./runtime-diagnostics.js";

describe("ensureLocalLangfuseStarted", () => {
	let stackDir: string;
	let realFetch: typeof globalThis.fetch;

	beforeEach(async () => {
		stackDir = await mkdtemp(join(tmpdir(), "pi-langfuse-autostart-test-"));
		await writeFile(join(stackDir, "docker-compose.yml"), "services: {}\n");
		process.env.PI_LANGFUSE_AUTOSTART = "1";
		// Health probe that never sees a healthy stack, like a down Compose service.
		realFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("connection refused");
		};
	});

	afterEach(async () => {
		globalThis.fetch = realFetch;
		await rm(stackDir, { recursive: true, force: true });
	});

	it("handles asynchronous spawn errors without crashing or claiming success", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const unref = vi.fn();
		const spawnImpl = vi.fn(() => {
			const child = new EventEmitter() as EventEmitter & { unref: () => void };
			child.unref = unref;
			// Node reports spawn failures (e.g. ENOENT) asynchronously.
			queueMicrotask(() => {
				child.emit(
					"error",
					Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
				);
			});
			return child;
		}) as unknown as typeof spawn;
		const config = {
			localAutostart: true,
			localAutostartDir: stackDir,
			localAutostartHealthUrl: "http://127.0.0.1:3100/api/public/health",
			localAutostartTimeoutMs: 50,
		} as Config;

		await expect(
			ensureLocalLangfuseStarted(config, spawnImpl),
		).resolves.toBeUndefined();

		expect(spawnImpl).toHaveBeenCalledOnce();
		expect(unref).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		expect(getLastRuntimeError()?.message).toContain(
			"failed to autostart local Langfuse",
		);
		expect(getLastRuntimeError()?.message).toContain("ENOENT");
		warn.mockRestore();
	});
});
