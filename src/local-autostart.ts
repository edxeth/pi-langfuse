import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Config } from "./config.js";
import { recordRuntimeError } from "./runtime-diagnostics.js";

let attempted = false;
let warned = false;

/**
 * Environment keys the Docker CLI needs: PATH for credential helpers, HOME
 * for ~/.docker (contexts, plugins, config), DOCKER_* for the daemon address
 * and TLS, SSH_AUTH_SOCK for ssh:// hosts, and proxies for image pulls.
 * Everything else is withheld: Compose interpolates `${VAR:-default}` from
 * the invoking environment ahead of the stack's own `.env`, so a caller's
 * project variables (for example a devenv's POSTGRES_USER) would change the
 * service configuration and make Compose recreate running containers.
 * COMPOSE_* variables could point Compose at another project or file.
 */
const DOCKER_CLIENT_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"SSH_AUTH_SOCK",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
]);

function dockerClientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (DOCKER_CLIENT_ENV_KEYS.has(key) || key.startsWith("DOCKER_")) {
			env[key] = value;
		}
	}
	return env;
}

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

/**
 * One autostart attempt: probe the health endpoint and, only when the stack
 * does not answer, start its stopped containers. `--no-recreate` keeps the
 * attempt from ever reconfiguring a running stack. Never rejects.
 */
export async function runLocalAutostart(
	config: Config,
	spawnImpl: typeof spawn = spawn,
) {
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
		const child = spawnImpl(
			"docker",
			["compose", "up", "-d", "--no-recreate"],
			{
				cwd: config.localAutostartDir,
				detached: true,
				stdio: "ignore",
				env: dockerClientEnvironment(process.env),
			},
		);
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

/**
 * Start at most one autostart attempt per process, in the background. The
 * prompt never waits for the health probe: the exporter's own retries cover
 * a stack that is still starting.
 */
export async function ensureLocalLangfuseStarted(
	config: Config,
	spawnImpl: typeof spawn = spawn,
) {
	if (!config.localAutostart) return;
	if (process.env.PI_LANGFUSE_AUTOSTART === "0") return;
	if (attempted) return;
	attempted = true;
	void runLocalAutostart(config, spawnImpl);
}
