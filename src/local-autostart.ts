import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Config } from "./config.js";
import { recordRuntimeError } from "./runtime-diagnostics.js";

let attempted = false;
let warned = false;

async function isHealthy(url: string, timeoutMs: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function warnOnce(message: string) {
	if (warned) return;
	warned = true;
	recordRuntimeError(`${message}`);
}

export async function ensureLocalLangfuseStarted(
	config: Config,
	spawnImpl: typeof spawn = spawn,
) {
	if (!config.localAutostart) return;
	if (process.env.PI_LANGFUSE_AUTOSTART === "0") return;
	if (attempted) return;
	attempted = true;

	if (!existsSync(`${config.localAutostartDir}/docker-compose.yml`)) {
		warnOnce(
			`local autostart enabled but no docker-compose.yml found at ${config.localAutostartDir}`,
		);
		return;
	}

	if (
		await isHealthy(
			config.localAutostartHealthUrl,
			config.localAutostartTimeoutMs,
		)
	) {
		return;
	}

	try {
		const child = spawnImpl("docker", ["compose", "up", "-d"], {
			cwd: config.localAutostartDir,
			detached: true,
			stdio: "ignore",
		});
		// Spawn failures surface asynchronously; without this listener an
		// ENOENT becomes an unhandled 'error' event that terminates Pi.
		child.on("error", (error) => {
			warnOnce(`failed to autostart local Langfuse: ${String(error)}`);
		});
		child.unref();
	} catch (error) {
		warnOnce(`failed to autostart local Langfuse: ${String(error)}`);
	}
}
