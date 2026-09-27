import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const DEFAULT_LOCAL_HOST = "http://localhost:3100";
const DEFAULT_REMOTE_HOST = "https://cloud.langfuse.com";
const DEFAULT_EMAIL = "local@example.test";
const DEFAULT_NAME = "Local User";

type InitMode = "local" | "remote";

type InitOptions = {
	yes: boolean;
	noStart: boolean;
	mode: InitMode;
	dir: string;
	host: string;
	email: string;
	name: string;
	password: string;
	passwordGenerated: boolean;
	publicKey: string;
	secretKey: string;
};

function agentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function defaultLangfuseDir() {
	return join(agentDir(), "langfuse");
}

function localConfigPath(dir = defaultLangfuseDir()) {
	return join(dir, "pi-langfuse.json");
}

type LocalBinding = { url: string; webPort: number };

function parseLocalHostBinding(host: string): LocalBinding | { error: string } {
	let parsed: URL;
	try {
		parsed = new URL(host);
	} catch {
		return {
			error: `--host must be a valid URL (got "${host}"), e.g. http://localhost:3100.`,
		};
	}
	if (parsed.protocol !== "http:") {
		return {
			error: `--host must use http:// for the local stack, which terminates no TLS (got "${host}").`,
		};
	}
	// The generated stack publishes 127.0.0.1 only, so IPv6 loopback would be unreachable.
	if (parsed.hostname === "[::1]") {
		return {
			error: `--host http://[::1] is not supported: the generated stack publishes IPv4 loopback (127.0.0.1) only. Use http://127.0.0.1:<port> instead.`,
		};
	}
	const loopbackHosts = ["localhost", "127.0.0.1"];
	if (!loopbackHosts.includes(parsed.hostname)) {
		return {
			error: `--host must be a loopback URL (localhost or 127.0.0.1) so the stack stays private (got "${host}").`,
		};
	}
	const webPort = parsed.port ? Number(parsed.port) : 3100;
	if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
		return { error: `--host port is not a valid TCP port (got "${host}").` };
	}
	return { url: `http://${parsed.hostname}:${webPort}`, webPort };
}

function token(bytes = 24) {
	return randomBytes(bytes).toString("base64url");
}

function secretHex(bytes = 32) {
	return randomBytes(bytes).toString("hex");
}

function splitArgs(args: string) {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | "" = "";
	let escaped = false;
	for (const ch of args) {
		if (escaped) {
			cur += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = "";
			else cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

function readOption(tokens: string[], name: string) {
	const prefix = `${name}=`;
	const exact = tokens.indexOf(name);
	if (exact >= 0) return tokens[exact + 1];
	const joined = tokens.find((token) => token.startsWith(prefix));
	return joined ? joined.slice(prefix.length) : undefined;
}

function parseMode(tokens: string[]): InitMode {
	const requested = readOption(tokens, "--mode");
	if (
		requested === "remote" ||
		tokens.includes("--remote") ||
		tokens.includes("--cloud")
	) {
		return "remote";
	}
	if (requested === "local" || tokens.includes("--local")) return "local";
	return "local";
}

function parseOptions(args: string): InitOptions {
	const tokens = splitArgs(args);
	const mode = parseMode(tokens);
	const dir = readOption(tokens, "--dir") || defaultLangfuseDir();
	const host =
		readOption(tokens, "--host") ||
		(mode === "remote" ? DEFAULT_REMOTE_HOST : DEFAULT_LOCAL_HOST);
	return {
		yes: tokens.includes("--yes") || tokens.includes("-y"),
		noStart: tokens.includes("--no-start"),
		mode,
		dir: dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(dir),
		host,
		email: readOption(tokens, "--email") || DEFAULT_EMAIL,
		name: readOption(tokens, "--name") || DEFAULT_NAME,
		password:
			readOption(tokens, "--password") || (mode === "local" ? token(12) : ""),
		passwordGenerated: mode === "local" && !readOption(tokens, "--password"),
		publicKey:
			readOption(tokens, "--public-key") ||
			process.env.LANGFUSE_PUBLIC_KEY ||
			"",
		secretKey:
			readOption(tokens, "--secret-key") ||
			process.env.LANGFUSE_SECRET_KEY ||
			"",
	};
}

async function promptValue(
	ctx: ExtensionCommandContext,
	title: string,
	current: string,
) {
	if (!ctx.hasUI) return current;
	const value = await ctx.ui.input(title, current);
	return value?.trim() || current;
}

async function promptMode(ctx: ExtensionCommandContext, current: InitMode) {
	if (!ctx.hasUI) return current;
	const choice = await ctx.ui.select("Langfuse setup type", [
		"Local self-hosted",
		"Remote / Langfuse Cloud",
	]);
	if (!choice) return current;
	return choice.startsWith("Remote") ? "remote" : "local";
}

function modeLabel(mode: InitMode) {
	return mode === "local" ? "local self-hosted" : "remote";
}

async function dirHasUserFiles(dir: string) {
	if (!existsSync(dir)) return false;
	const entries = await readdir(dir);
	return entries.length > 0;
}

function envFile(
	options: InitOptions,
	keys: { publicKey: string; secretKey: string },
) {
	const postgresPassword = token(36);
	const clickhousePassword = token(36);
	const redisPassword = token(36);
	const minioPassword = token(36);
	return `NEXTAUTH_URL=${options.host}
NEXTAUTH_SECRET=${token(48)}
SALT=${token(32)}
ENCRYPTION_KEY=${secretHex(32)}
TELEMETRY_ENABLED=false
NEXT_TELEMETRY_DISABLED=1
POSTGRES_PASSWORD=${postgresPassword}
CLICKHOUSE_PASSWORD=${clickhousePassword}
REDIS_AUTH=${redisPassword}
MINIO_ROOT_USER=langfuseminio
MINIO_ROOT_PASSWORD=${minioPassword}
LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=langfuseminio
LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=\${MINIO_ROOT_PASSWORD}
LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID=langfuseminio
LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=\${MINIO_ROOT_PASSWORD}
LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID=langfuseminio
LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY=\${MINIO_ROOT_PASSWORD}
LANGFUSE_INIT_ORG_ID=local-org
LANGFUSE_INIT_ORG_NAME=Local
LANGFUSE_INIT_PROJECT_ID=pi-traces
LANGFUSE_INIT_PROJECT_NAME=Pi Traces
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=${keys.publicKey}
LANGFUSE_INIT_PROJECT_SECRET_KEY=${keys.secretKey}
LANGFUSE_INIT_USER_EMAIL=${options.email}
LANGFUSE_INIT_USER_NAME=${options.name}
LANGFUSE_INIT_USER_PASSWORD=${options.password}
DATABASE_URL=postgresql://postgres:${postgresPassword}@postgres:5432/postgres
DIRECT_URL=postgresql://postgres:${postgresPassword}@postgres:5432/postgres
`;
}

function dockerComposeFile(webPort: number) {
	return `services:
  langfuse-worker:
    image: docker.io/langfuse/langfuse-worker:3
    restart: always
    depends_on: &langfuse-depends-on
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
      redis:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
    ports:
      - 127.0.0.1:3030:3030
    environment: &langfuse-worker-env
      NEXTAUTH_URL: \${NEXTAUTH_URL:-http://localhost:3100}
      DATABASE_URL: \${DATABASE_URL}
      SALT: \${SALT}
      ENCRYPTION_KEY: \${ENCRYPTION_KEY}
      TELEMETRY_ENABLED: \${TELEMETRY_ENABLED:-false}
      NEXT_TELEMETRY_DISABLED: \${NEXT_TELEMETRY_DISABLED:-1}
      LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES: \${LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES:-false}
      CLICKHOUSE_MIGRATION_URL: clickhouse://clickhouse:9000
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: \${CLICKHOUSE_PASSWORD}
      CLICKHOUSE_CLUSTER_ENABLED: "false"
      LANGFUSE_USE_AZURE_BLOB: "false"
      LANGFUSE_USE_OCI_NATIVE_OBJECT_STORAGE: "false"
      LANGFUSE_OCI_AUTH_TYPE: workload_identity
      LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_EVENT_UPLOAD_REGION: auto
      LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: \${LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID}
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: \${LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY}
      LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: http://minio:9000
      LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: "true"
      LANGFUSE_S3_EVENT_UPLOAD_PREFIX: events/
      LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_MEDIA_UPLOAD_REGION: auto
      LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: \${LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID}
      LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: \${LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY}
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://localhost:9190
      LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: "true"
      LANGFUSE_S3_MEDIA_UPLOAD_PREFIX: media/
      LANGFUSE_S3_BATCH_EXPORT_ENABLED: "false"
      LANGFUSE_S3_BATCH_EXPORT_BUCKET: langfuse
      LANGFUSE_S3_BATCH_EXPORT_PREFIX: exports/
      LANGFUSE_S3_BATCH_EXPORT_REGION: auto
      LANGFUSE_S3_BATCH_EXPORT_ENDPOINT: http://minio:9000
      LANGFUSE_S3_BATCH_EXPORT_EXTERNAL_ENDPOINT: http://localhost:9190
      LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID: \${LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID}
      LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: \${LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY}
      LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE: "true"
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      REDIS_AUTH: \${REDIS_AUTH}
      REDIS_TLS_ENABLED: "false"
      EMAIL_FROM_ADDRESS: ""
      SMTP_CONNECTION_URL: ""

  langfuse-web:
    image: docker.io/langfuse/langfuse:3
    restart: always
    depends_on: *langfuse-depends-on
    ports:
      - 127.0.0.1:${webPort}:3000
    environment:
      <<: *langfuse-worker-env
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      LANGFUSE_INIT_ORG_ID: \${LANGFUSE_INIT_ORG_ID}
      LANGFUSE_INIT_ORG_NAME: \${LANGFUSE_INIT_ORG_NAME}
      LANGFUSE_INIT_PROJECT_ID: \${LANGFUSE_INIT_PROJECT_ID}
      LANGFUSE_INIT_PROJECT_NAME: \${LANGFUSE_INIT_PROJECT_NAME}
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: \${LANGFUSE_INIT_PROJECT_PUBLIC_KEY}
      LANGFUSE_INIT_PROJECT_SECRET_KEY: \${LANGFUSE_INIT_PROJECT_SECRET_KEY}
      LANGFUSE_INIT_USER_EMAIL: \${LANGFUSE_INIT_USER_EMAIL}
      LANGFUSE_INIT_USER_NAME: \${LANGFUSE_INIT_USER_NAME}
      LANGFUSE_INIT_USER_PASSWORD: \${LANGFUSE_INIT_USER_PASSWORD}

  clickhouse:
    image: docker.io/clickhouse/clickhouse-server
    restart: always
    user: "101:101"
    environment:
      CLICKHOUSE_DB: default
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: \${CLICKHOUSE_PASSWORD}
    volumes:
      - langfuse_clickhouse_data:/var/lib/clickhouse
      - langfuse_clickhouse_logs:/var/log/clickhouse-server
    ports:
      - 127.0.0.1:18123:8123
      - 127.0.0.1:19000:9000
    healthcheck:
      test: wget --no-verbose --tries=1 --spider http://localhost:8123/ping || exit 1
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 1s

  minio:
    image: cgr.dev/chainguard/minio
    restart: always
    entrypoint: sh
    command: -c 'mkdir -p /data/langfuse && minio server --address ":9000" --console-address ":9001" /data'
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    ports:
      - 127.0.0.1:9190:9000
      - 127.0.0.1:9191:9001
    volumes:
      - langfuse_minio_data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 1s
      timeout: 5s
      retries: 5
      start_period: 1s

  redis:
    image: docker.io/redis:7
    restart: always
    command: >
      --requirepass \${REDIS_AUTH}
      --maxmemory-policy noeviction
    ports:
      - 127.0.0.1:16379:6379
    volumes:
      - langfuse_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 10s
      retries: 10

  postgres:
    image: docker.io/postgres:17
    restart: always
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 3s
      timeout: 3s
      retries: 10
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
      TZ: UTC
      PGTZ: UTC
    ports:
      - 127.0.0.1:15432:5432
    volumes:
      - langfuse_postgres_data:/var/lib/postgresql/data

volumes:
  langfuse_postgres_data:
  langfuse_clickhouse_data:
  langfuse_clickhouse_logs:
  langfuse_minio_data:
  langfuse_redis_data:
`;
}

function piLangfuseConfig(
	options: InitOptions,
	keys: { publicKey: string; secretKey: string },
) {
	return `${JSON.stringify(
		{
			enabled: true,
			publicKey: keys.publicKey,
			secretKey: keys.secretKey,
			host: options.host,
			defaultTags: options.mode === "local" ? "local,private" : "remote",
			environment: options.mode,
			skipUnpersistedSessions: true,
			captureProviderPayload: false,
			providerPayloadMaxChars: 50_000,
			localAutostart: options.mode === "local",
			// Pin the stack directory so autostart follows the file once it is discovered.
			...(options.mode === "local" ? { localAutostartDir: options.dir } : {}),
			traceInputMaxChars: 20_000,
			traceOutputMaxChars: 20_000,
			toolArgsMaxChars: 10_000,
			toolOutputMaxChars: 20_000,
		},
		null,
		2,
	)}\n`;
}

async function safeWrite(path: string, content: string) {
	if (existsSync(path)) {
		throw new Error(`Refusing to overwrite existing file: ${path}`);
	}
	// .env and pi-langfuse.json carry secrets; compose stays world-readable
	const ownerOnly = path.endsWith(".env") || path.endsWith("pi-langfuse.json");
	await writeFile(path, content, { mode: ownerOnly ? 0o600 : 0o644 });
}

export async function runLangfuseInit(
	args: string,
	ctx: ExtensionCommandContext,
) {
	let options = parseOptions(args);

	if (!options.yes) {
		const mode = await promptMode(ctx, options.mode);
		options = {
			...options,
			mode,
			host:
				options.host === DEFAULT_LOCAL_HOST && mode === "remote"
					? DEFAULT_REMOTE_HOST
					: options.host,
		};
		if (options.mode === "local") {
			options = {
				...options,
				email: await promptValue(ctx, "Langfuse login email", options.email),
				name: await promptValue(ctx, "Langfuse display name", options.name),
				password: await promptValue(
					ctx,
					options.passwordGenerated
						? "Langfuse password (generated, visible while typing)"
						: "Langfuse password (visible while typing)",
					options.password,
				),
			};
		} else {
			options = {
				...options,
				host: await promptValue(ctx, "Langfuse host", options.host),
				publicKey: await promptValue(
					ctx,
					"Langfuse public key",
					options.publicKey,
				),
				secretKey: await promptValue(
					ctx,
					"Langfuse secret key",
					options.secretKey,
				),
			};
		}
		const confirmed = ctx.hasUI
			? await ctx.ui.confirm(
					`Initialize ${modeLabel(options.mode)} Langfuse?`,
					options.mode === "local"
						? `Create a local-only Langfuse stack in ${options.dir}. Existing files will not be overwritten.`
						: `Write remote Langfuse connection settings in ${localConfigPath(options.dir)}. Existing files will not be overwritten.`,
				)
			: false;
		if (!confirmed) {
			ctx.ui.notify("Langfuse init cancelled", "info");
			return;
		}
	}

	if (options.mode === "local") {
		const binding = parseLocalHostBinding(options.host);
		if ("error" in binding) {
			ctx.ui.notify(`Langfuse init refused: ${binding.error}`, "error");
			return;
		}
		options = { ...options, host: binding.url };
	}

	if (await dirHasUserFiles(options.dir)) {
		ctx.ui.notify(
			`Langfuse init refused: ${options.dir} already contains files. Nothing was overwritten.`,
			"warning",
		);
		return;
	}

	// 0700 applies only to directories created here; existing dirs keep their mode
	await mkdir(options.dir, { recursive: true, mode: 0o700 });
	const keys =
		options.mode === "local"
			? {
					publicKey: `pk-lf-local-${token(18)}`,
					secretKey: `sk-lf-local-${token(32)}`,
				}
			: {
					publicKey: options.publicKey,
					secretKey: options.secretKey,
				};

	if (!keys.publicKey || !keys.secretKey) {
		ctx.ui.notify(
			"Remote Langfuse init requires --public-key and --secret-key, or LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY.",
			"error",
		);
		return;
	}

	if (options.mode === "local") {
		const binding = parseLocalHostBinding(options.host);
		if ("error" in binding) {
			ctx.ui.notify(`Langfuse init refused: ${binding.error}`, "error");
			return;
		}
		await safeWrite(
			join(options.dir, "docker-compose.yml"),
			dockerComposeFile(binding.webPort),
		);
		await safeWrite(join(options.dir, ".env"), envFile(options, keys));
	}
	await safeWrite(
		localConfigPath(options.dir),
		piLangfuseConfig(options, keys),
	);

	if (options.mode === "local" && !options.noStart) {
		ctx.ui.notify("Starting local Langfuse with Docker Compose...", "info");
		try {
			await execFileAsync("docker", ["compose", "up", "-d"], {
				cwd: options.dir,
			});
		} catch (error) {
			ctx.ui.notify(
				`Langfuse files created in ${options.dir}, but Docker Compose failed: ${String(error)}. Run \`docker compose up -d\` in ${options.dir} once Docker works.`,
				"error",
			);
			if (options.passwordGenerated) {
				ctx.ui.notify(
					`The generated login password was not displayed because the start failed. Recover it from ${join(options.dir, ".env")} (LANGFUSE_INIT_USER_PASSWORD); login email: ${options.email}.`,
					"warning",
				);
			}
			return;
		}
	}

	ctx.ui.notify(
		options.mode === "local"
			? `Local Langfuse initialized at ${options.host}. Login: ${options.email} / ${options.password}`
			: `Remote Langfuse configured at ${options.host}`,
		"info",
	);
	if (options.mode === "local" && options.passwordGenerated) {
		ctx.ui.notify(
			"The local login password was generated for this install and is shown only in this message. Store it now.",
			"warning",
		);
	}
	if (options.dir !== defaultLangfuseDir()) {
		ctx.ui.notify(
			`Init wrote files outside the default search path. Set PI_LANGFUSE_CONFIG=${localConfigPath(options.dir)} before starting pi so this configuration is loaded.`,
			"warning",
		);
	}
}
