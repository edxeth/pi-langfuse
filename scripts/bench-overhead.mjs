#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
/**
 * Measures the CPU, wall time, synchronous file calls, and HTTP traffic that
 * the extension adds to a synthetic Pi event stream. It drives the registered
 * handlers directly, through Pi's own TypeScript loader (jiti), against a
 * loopback fake Langfuse server.
 *
 *   node scripts/bench-overhead.mjs [--repo <checkout>] [--scenario streaming|burst|long-session]
 *                                   [--config user|defaults|none] [--out <file.json>]
 *
 * Isolation is enforced, not assumed: HOME, the Pi agent directory, and the
 * config file point into a fresh temp directory, and guards refuse, and list
 * in "guardBlocks", every fetch outside the fake server, every child process
 * other than git started without a shell, and every synchronous write by path
 * (mkdir, open for writing, append, write, rename at either end, rm, unlink)
 * outside the temp directory, jiti's cache, and the --out file. The measured
 * handlers write only through these calls and the descriptors they open. The
 * guards catch accidental escapes by the code under test; they are not a
 * sandbox for hostile code. test/bench-overhead.test.ts pins them.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1];
}
const repo = resolve(option("--repo", process.cwd()));
const scenario = option("--scenario", "streaming");
const configName = option("--config", "user");
const out = option("--out", undefined);
if (!["streaming", "burst", "long-session"].includes(scenario)) {
	throw new Error(`unknown --scenario ${scenario}`);
}
if (!["user", "defaults", "none"].includes(configName)) {
	throw new Error(`unknown --config ${configName}`);
}

// ---- isolated environment and fake Langfuse --------------------------------
const home = mkdtempSync(join(tmpdir(), "pi-langfuse-bench-"));
const agentDir = join(home, "agent");
const rawDir = join(home, "raw");
const configPath = join(home, "pi-langfuse.json");
const sessionFile = join(home, "sessions", "--bench--", "session.jsonl");
for (const dir of [agentDir, rawDir, join(home, "sessions", "--bench--")]) {
	mkdirSync(dir, { recursive: true });
}
const http = {};
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = Buffer.concat(chunks);
	const url = request.url ?? "";
	const endpoint = url.includes("/otel/v1/traces")
		? "otlp"
		: url.includes("/scores")
			? "scores"
			: "other";
	http[endpoint] ??= { requests: 0, bytes: 0, spans: 0 };
	const record = http[endpoint];
	record.requests += 1;
	record.bytes += body.length;
	if (endpoint === "otlp") {
		for (const resource of JSON.parse(body.toString()).resourceSpans ?? []) {
			for (const scope of resource.scopeSpans ?? []) {
				record.spans += (scope.spans ?? []).length;
			}
		}
	}
	response.writeHead(200, { "content-type": "application/json" });
	response.end(endpoint === "scores" ? '{"id":"bench"}' : "{}");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const host = `http://127.0.0.1:${server.address().port}`;
const keys = {
	publicKey: "pk-bench-synthetic",
	secretKey: "sk-bench-synthetic",
};
writeFileSync(
	configPath,
	JSON.stringify(
		configName === "user"
			? {
					enabled: true,
					...keys,
					host,
					defaultTags: "bench,local",
					environment: "local",
					rawTraceEnabled: true,
					rawTraceDir: rawDir,
					localAutostart: false,
					traceInputMaxChars: 20000,
					traceOutputMaxChars: 20000,
					toolArgsMaxChars: 10000,
					toolOutputMaxChars: 20000,
				}
			: { enabled: true, ...keys, host },
	),
);
for (const key of Object.keys(process.env)) {
	if (
		/^(LANGFUSE_|PI_LANGFUSE_|OTEL_EXPORTER_OTLP_|PI_CODING_AGENT_)/.test(key)
	) {
		delete process.env[key];
	}
}
Object.assign(process.env, {
	HOME: home,
	USERPROFILE: home,
	PI_CODING_AGENT_DIR: agentDir,
	PI_LANGFUSE_CONFIG: configPath,
	PI_LANGFUSE_RAW_TRACE_DIR: rawDir,
	PI_LANGFUSE_AUTOSTART: "0",
});
if (process.env.HOME === userInfo().homedir) {
	throw new Error("bench: HOME is not isolated");
}

const guardBlocks = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = String(input?.url ?? input);
	if (url.startsWith(`${host}/`)) return realFetch(input, init);
	guardBlocks.push(`fetch ${url}`);
	return Promise.reject(new Error(`bench: blocked fetch to ${url}`));
};
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
// exec and execSync always run a shell, which can start anything.
const shellCalls = ["exec", "execSync"];
for (const name of [
	"spawn",
	"spawnSync",
	"execFile",
	"execFileSync",
	...shellCalls,
]) {
	const original = childProcess[name];
	childProcess[name] = function guardedChildProcess(command, ...rest) {
		const options = rest.find(
			(arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg),
		);
		if (
			!shellCalls.includes(name) &&
			!options?.shell &&
			/(^|\/)git$/.test(String(command))
		)
			return original.call(this, command, ...rest);
		guardBlocks.push(`${name} ${command}`);
		throw new Error(`bench: blocked child process ${command}`);
	};
}
const fs = require("node:fs");
// The temp home, jiti's cache, and the requested result file only.
const writeRoots = [
	home,
	join(tmpdir(), "jiti"),
	...(out ? [resolve(out)] : []),
];
const writable = (path) => {
	// A descriptor comes from an open that these guards already checked.
	if (typeof path === "number") return true;
	const target = resolve(
		path instanceof URL ? fileURLToPath(path) : String(path),
	);
	return writeRoots.some(
		(root) => target === root || target.startsWith(`${root}/`),
	);
};
const syncCalls = {};
let activeEvent = "setup";
for (const name of [
	"existsSync",
	"readFileSync",
	"statSync",
	"lstatSync",
	"mkdirSync",
	"openSync",
	"fstatSync",
	"fchmodSync",
	"appendFileSync",
	"writeFileSync",
	"writeSync",
	"closeSync",
	"renameSync",
	"rmSync",
	"unlinkSync",
]) {
	const original = fs[name];
	if (typeof original !== "function") continue;
	const writes = [
		"mkdirSync",
		"appendFileSync",
		"writeFileSync",
		"renameSync",
		"rmSync",
		"unlinkSync",
	].includes(name);
	fs[name] = function countedSyncCall(path, ...rest) {
		const opensForWrite =
			name === "openSync" &&
			(typeof rest[0] === "number"
				? (rest[0] &
						(fs.constants.O_WRONLY |
							fs.constants.O_RDWR |
							fs.constants.O_CREAT |
							fs.constants.O_APPEND)) !==
					0
				: /[wa+]/.test(String(rest[0] ?? "")));
		const targets = name === "renameSync" ? [path, rest[0]] : [path];
		if ((writes || opensForWrite) && !targets.every(writable)) {
			const described = targets.map(String).join(" -> ");
			guardBlocks.push(`${name} ${described}`);
			throw new Error(`bench: blocked ${name} ${described}`);
		}
		syncCalls[activeEvent] ??= {};
		const counts = syncCalls[activeEvent];
		counts[name] = (counts[name] ?? 0) + 1;
		return original.call(this, path, ...rest);
	};
}
syncBuiltinESMExports();

// ---- load the extension the way Pi does ------------------------------------
// Pi's own loader, resolved from the locked Pi (an ESM-only package).
const piRequire = createRequire(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const handlers = new Map();
const pi = {
	on: (name, handler) => handlers.set(name, handler),
	events: {
		on() {},
		emit(name, probe) {
			if (name === "extension:settings:get") probe.values = {};
		},
	},
	registerCommand() {},
	registerFlag() {},
	model: { id: "bench-model", provider: "bench-provider" },
};
if (configName !== "none") {
	const { resolveConfig } = await jiti.import(join(repo, "src/config.ts"));
	const resolved = resolveConfig({});
	if (resolved.host !== host || resolved.localAutostart) {
		throw new Error(
			"bench: the resolved config does not point at the fake server",
		);
	}
	const register = (await jiti.import(join(repo, "src/index.ts"))).default;
	await register(pi);
}

// ---- workload ---------------------------------------------------------------
const ctx = {
	hasUI: false,
	model: pi.model,
	cwd: repo,
	sessionManager: { getSessionFile: () => sessionFile },
};
const cpuByEvent = {};
async function emit(type, event = {}) {
	const before = process.cpuUsage();
	activeEvent = type;
	try {
		await handlers.get(type)?.(event, ctx);
	} finally {
		activeEvent = "between";
		const used = process.cpuUsage(before);
		cpuByEvent[type] ??= [];
		cpuByEvent[type].push(used.user + used.system);
	}
}
const toolResult = [{ type: "text", text: "y".repeat(20_000) }];
async function prompt(index, turns, deltas, toolsPerTurn, burst) {
	await emit("before_agent_start", {
		prompt: "synthetic benchmark prompt",
		systemPrompt: "synthetic system",
		systemPromptOptions: { cwd: repo },
	});
	await emit("agent_start");
	for (let turn = 0; turn < turns; turn += 1) {
		await emit("turn_start", { turnIndex: turn });
		await emit("context", {
			messages: [{ role: "user", content: "synthetic benchmark prompt" }],
		});
		const message = {
			role: "assistant",
			content: [],
			model: "bench-model",
			usage: {
				input: 50,
				output: 20,
				totalTokens: 70,
				cost: { input: 0.001, output: 0.002, total: 0.003 },
			},
			stopReason: "toolUse",
		};
		await emit("message_start", { message });
		for (let delta = 0; delta < deltas; delta += 1) {
			await emit("message_update", {
				message,
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});
		}
		await emit("message_end", { message });
		const tools = Array.from({ length: toolsPerTurn }, (_, i) => ({
			toolCallId: `tool-${index}-${turn}-${i}`,
			toolName: i === 0 ? "bash" : "read",
			args: { command: "echo synthetic" },
		}));
		const run = async (tool, progress) => {
			await emit("tool_call", { ...tool, input: tool.args });
			await emit("tool_execution_start", tool);
			for (let update = 1; update <= progress; update += 1) {
				const text = "x".repeat(Math.floor((50_000 * update) / progress));
				await emit("tool_execution_update", {
					...tool,
					partialResult: { content: [{ type: "text", text }] },
				});
			}
			await emit("tool_result", {
				...tool,
				input: tool.args,
				content: toolResult,
				isError: false,
			});
			await emit("tool_execution_end", {
				...tool,
				result: { content: toolResult },
				isError: false,
			});
		};
		if (burst) await Promise.all(tools.map((tool) => run(tool, 0)));
		else
			for (const [i, tool] of tools.entries())
				await run(tool, scenario === "streaming" && i === 0 ? 30 : 0);
		await emit("turn_end", { turnIndex: turn, message, toolResults: [] });
	}
	await emit("agent_end", {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		],
	});
	await emit("agent_settled");
}

const startedAt = process.hrtime.bigint();
const cpuBefore = process.cpuUsage();
await emit("session_start", { reason: "startup" });
if (scenario === "streaming") await prompt(0, 10, 2_000, 3, false);
if (scenario === "burst") await prompt(0, 1, 0, 16, true);
if (scenario === "long-session")
	for (let p = 0; p < 20; p += 1) await prompt(p, 5, 0, 1, false);
await emit("session_shutdown");
const cpu = process.cpuUsage(cpuBefore);
const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = {
	repo,
	scenario,
	config: configName,
	node: process.version,
	cpuMs: Math.round((cpu.user + cpu.system) / 1000),
	wallMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
	// The driver awaits handlers back to back, so it never yields to timers;
	// per-event CPU is the comparable number, not event-loop delay.
	medianCpuUsPerEvent: Object.fromEntries(
		Object.entries(cpuByEvent).map(([type, values]) => [type, median(values)]),
	),
	syncCallsPerEventType: syncCalls,
	http,
	guardBlocks,
};
await new Promise((done) => server.close(done));
rmSync(home, { recursive: true, force: true });
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (guardBlocks.length > 0) process.exitCode = 1;
