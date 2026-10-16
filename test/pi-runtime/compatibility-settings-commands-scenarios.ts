import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import registerExtension from "../../src/index.js";
import {
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
	latestRecord,
	registeredSettings,
	type TestPi,
} from "./compatibility-fixtures.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function commandHandler(pi: TestPi, name: string): CommandHandler {
	const call = pi.registerCommand.mock.calls.find((item) => item[0] === name);
	if (!call) throw new Error(`command not registered: ${name}`);
	return (call[1] as { handler: CommandHandler }).handler;
}

/** Registers the settings-source precedence, registered command, and connectivity command scenarios. */
export function registerSettingsCommandsScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	it("captures configuration source precedence through the registered settings bridge", async () => {
		const cases: Array<{
			name: string;
			settings: Record<string, unknown>;
			fileHost?: string;
			envHost?: string;
			expectedHost: string;
		}> = [
			{
				name: "settings override file and environment",
				settings: { enabled: false, "base-url": "http://settings-host" },
				fileHost: "http://file-host",
				envHost: "http://env-host",
				expectedHost: "http://settings-host",
			},
			{
				name: "file overrides environment",
				settings: { enabled: false },
				fileHost: "http://file-host",
				envHost: "http://env-host",
				expectedHost: "http://file-host",
			},
			{
				name: "environment overrides defaults",
				settings: { enabled: false },
				envHost: "http://env-host",
				expectedHost: "http://env-host",
			},
			{
				name: "defaults fill missing sources",
				settings: { enabled: false },
				expectedHost: "https://cloud.langfuse.com",
			},
		];

		for (const testCase of cases) {
			const root = tempRoot(
				`pi-langfuse-config-${testCase.name.replaceAll(" ", "-")}-`,
			);
			process.env.PI_CODING_AGENT_DIR = root;
			delete process.env.LANGFUSE_HOST;
			if (testCase.envHost) process.env.LANGFUSE_HOST = testCase.envHost;
			if (testCase.fileHost) {
				mkdirSync(join(root, "langfuse"), { recursive: true });
				writeFileSync(
					join(root, "langfuse", "pi-langfuse.json"),
					JSON.stringify({ host: testCase.fileHost }),
				);
			}

			const pi = createTestPi(testCase.settings);
			await registerExtension(pi as unknown as ExtensionAPI);
			expect(registeredSettings(pi).nodes["base-url"]?.default).toBe(
				testCase.expectedHost,
			);
		}
	});

	it("runs the registered commands without changing their public behavior", async () => {
		const root = tempRoot("pi-langfuse-command-compat-");
		process.env.PI_CODING_AGENT_DIR = root;
		const notifications: Array<{ message: string; type?: string }> = [];
		const pi = createTestPi();
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await registerExtension(pi as unknown as ExtensionAPI);
			expect(pi.registerCommand.mock.calls.map((item) => item[0])).toEqual([
				"langfuse-init",
				"langfuse:export",
				"langfuse:toggle",
				"langfuse-status",
				"langfuse-test",
				"langfuse-score",
				"langfuse-privacy",
			]);

			const toggleContext = {
				ui: {
					notify: (message: string, type?: string) =>
						notifications.push({ message, type }),
				},
			};
			await commandHandler(pi, "langfuse:toggle")("off", toggleContext);
			const storedSettings = JSON.parse(
				readFileSync(join(root, "settings.json"), "utf-8"),
			) as {
				"extensions:settings": { "pi-langfuse": { enabled: boolean } };
			};
			expect(storedSettings["extensions:settings"]["pi-langfuse"].enabled).toBe(
				false,
			);
			expect(notifications.at(-1)?.message).toContain("tracing disabled");

			const initDir = join(root, "initialized");
			await commandHandler(pi, "langfuse-init")(
				`--yes --no-start --dir ${initDir}`,
				{
					hasUI: false,
					ui: {
						notify: (message: string, type?: string) =>
							notifications.push({ message, type }),
					},
				},
			);
			expect(
				readFileSync(join(initDir, "docker-compose.yml"), "utf-8"),
			).toContain("docker.io/langfuse/langfuse:3");
			expect(
				readFileSync(join(initDir, "docker-compose.yml"), "utf-8"),
			).toContain("docker.io/langfuse/langfuse-worker:3");
			expect(
				readFileSync(join(initDir, "pi-langfuse.json"), "utf-8"),
			).toContain('"localAutostart": true');
			expect(
				notifications.some((item) => item.message.includes("initialized")),
			).toBe(true);

			const sessionsDir = join(root, "sessions");
			const exportDir = join(root, "export");
			mkdirSync(join(sessionsDir, "--project--"), { recursive: true });
			writeFileSync(
				join(sessionsDir, "--project--", "session.jsonl"),
				'{"type":"message","content":"sk-lf-export-secret-1234567890"}\n',
			);
			await commandHandler(pi, "langfuse:export")(
				`--sessions-only --sessions-dir ${sessionsDir} --out ${exportDir} --no-trufflehog`,
				{
					ui: {
						notify: (message: string, type?: string) =>
							notifications.push({ message, type }),
					},
				},
			);
			const exported = readFileSync(
				join(exportDir, "sessions", "--project--", "session.jsonl"),
				"utf-8",
			);
			expect(exported).not.toContain("sk-lf-export-secret-1234567890");
			expect(exported).toContain("[REDACTED:");
			expect(
				notifications.some((item) => item.message.includes("Redacted export:")),
			).toBe(true);
		} finally {
			consoleLog.mockRestore();
		}

		await eventHandler(pi, "session_shutdown")();
	});

	it("provides safe status, isolated connectivity tests, and persistent privacy presets", async () => {
		const root = tempRoot("pi-langfuse-operator-command-");
		process.env.PI_CODING_AGENT_DIR = root;
		const notifications: Array<{ message: string; type?: string }> = [];
		const requests: Array<{
			method: string | undefined;
			url: string | undefined;
			authorization: string | undefined;
		}> = [];
		const requestBodies: string[] = [];
		let apiStatus = 200;
		const server = createServer((request, response) => {
			requests.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
			});
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requestBodies.push(Buffer.concat(chunks).toString("utf8"));
				response.writeHead(apiStatus, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [] }));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("operator command test server did not bind");
		}
		const host = `http://127.0.0.1:${address.port}`;
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({
				"extensions:settings": {
					"pi-langfuse": {
						enabled: true,
						"public-key": "public-key-for-test",
						"secret-key": "secret-key-for-test",
						"base-url": host,
						"capture-policy": "full-debug",
					},
				},
			}),
		);
		const bridgeSettings = {
			enabled: true,
			"public-key": "public-key-for-test",
			"secret-key": "secret-key-for-test",
			"base-url": host,
			"capture-policy": "full-debug" as const,
		};
		const pi = createTestPi(bridgeSettings);
		await registerExtension(pi as unknown as ExtensionAPI);
		const commandContext = {
			ui: {
				notify: (message: string, type?: string) =>
					notifications.push({ message, type }),
			},
			sessionManager: {
				getSessionFile: () => join(root, "session.jsonl"),
			},
			isIdle: () => false,
		};
		try {
			await commandHandler(pi, "langfuse-privacy")("", commandContext);
			expect(notifications.at(-1)?.message).toContain(
				"Capture policy: full-debug",
			);

			await commandHandler(pi, "langfuse-privacy")(
				"metadata-only",
				commandContext,
			);
			expect(
				JSON.parse(readFileSync(join(root, "settings.json"), "utf-8"))[
					"extensions:settings"
				]["pi-langfuse"]["capture-policy"],
			).toBe("metadata-only");
			expect(bridgeSettings["capture-policy"]).toBe("full-debug");
			expect(notifications.at(-1)?.message).toContain(
				"Capture policy set to metadata-only",
			);

			const sessionContext = {
				model: { id: "operator-model", provider: "operator-provider" },
				sessionManager: {
					getSessionFile: () => join(root, "session.jsonl"),
				},
				ui: { setStatus: vi.fn() },
			};
			await eventHandler(pi, "session_start")({}, sessionContext);
			await eventHandler(pi, "before_agent_start")(
				{
					prompt: "active operator prompt",
					systemPrompt: "operator system",
					systemPromptOptions: { cwd: root },
				},
				sessionContext,
			);
			const activeTrace = latestRecord(telemetry.state.traces, "pi-agent");
			const activePrompt = telemetry.state.observations.find(
				(record) =>
					record.traceId === activeTrace.id && record.name === "agent.prompt",
			);
			expect(activePrompt).toBeDefined();

			await commandHandler(pi, "langfuse-status")("", commandContext);
			const status = notifications.at(-1)?.message ?? "";
			expect(status).toContain("config source: settings panel");
			expect(status).toContain(`host: ${host}`);
			expect(status).toContain("public key: publ…test");
			expect(status).not.toContain("secret-key-for-test");
			expect(status).toContain("capture policy: metadata-only");
			expect(status).toContain("active run: yes");
			expect(status).toContain(
				`config path: ${join(root, "langfuse", "pi-langfuse.json")}`,
			);
			expect(status).toContain("runtime mode: v5-otel");
			expect(status).toContain("last runtime error: none");

			await commandHandler(pi, "langfuse-test")("", commandContext);
			expect(notifications.at(-1)).toEqual(
				expect.objectContaining({
					message: expect.stringContaining("Connectivity test passed"),
					type: "info",
				}),
			);
			expect(requests).toEqual([
				{
					method: "GET",
					url: "/api/public/projects?limit=1",
					authorization: `Basic ${Buffer.from("public-key-for-test:secret-key-for-test").toString("base64")}`,
				},
				{
					method: "POST",
					url: "/api/public/otel/v1/traces",
					authorization: `Basic ${Buffer.from("public-key-for-test:secret-key-for-test").toString("base64")}`,
				},
			]);
			const probePayload = JSON.parse(requestBodies[1] ?? "{}") as {
				resourceSpans?: Array<{
					scopeSpans?: Array<{
						spans?: Array<{
							name?: string;
							attributes?: Array<{
								key?: string;
								value?: { stringValue?: string };
							}>;
						}>;
					}>;
				}>;
			};
			const probeSpans =
				probePayload.resourceSpans?.flatMap(
					(resource) =>
						resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [],
				) ?? [];
			const probeSpan = probeSpans.at(-1);
			if (!probeSpan) throw new Error("probe span was not received");
			expect(probeSpan.name).toBe("pi-langfuse-test");
			const probeAttribute = (key: string) =>
				probeSpan.attributes?.find((attribute) => attribute.key === key)?.value
					?.stringValue;
			expect(probeAttribute("langfuse.trace.name")).toBe("pi-langfuse-test");
			expect(probeAttribute("langfuse.trace.metadata.command")).toBe(
				"langfuse-test",
			);
			expect(probeAttribute("langfuse.trace.metadata.isolated")).toBe("true");
			expect(requestBodies[1]).not.toContain("secret-key-for-test");
			expect(telemetry.state.flushes).toBe(0);
			expect(activePrompt?.endCalls).toBeUndefined();

			apiStatus = 401;
			await commandHandler(pi, "langfuse-test")("", commandContext);
			expect(notifications.at(-1)).toEqual(
				expect.objectContaining({
					message: expect.stringContaining("HTTP 401"),
					type: "error",
				}),
			);
			await commandHandler(pi, "langfuse-status")("", commandContext);
			expect(notifications.at(-1)?.message).toContain(
				"last runtime error: authenticated API returned HTTP 401",
			);
			expect(activePrompt?.endCalls).toBeUndefined();
			expect(requests).toHaveLength(3);
		} finally {
			await eventHandler(pi, "session_shutdown")({}, commandContext);
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("rejects the connectivity command when credentials are missing", async () => {
		const root = tempRoot("pi-langfuse-operator-missing-keys-");
		process.env.PI_CODING_AGENT_DIR = root;
		const notifications: Array<{ message: string; type?: string }> = [];
		const pi = createTestPi({ enabled: true });
		await registerExtension(pi as unknown as ExtensionAPI);
		await commandHandler(pi, "langfuse-test")("", {
			ui: {
				notify: (message: string, type?: string) =>
					notifications.push({ message, type }),
			},
			sessionManager: { getSessionFile: () => join(root, "session.jsonl") },
			isIdle: () => true,
		});
		expect(notifications.at(-1)).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("configure public and secret keys"),
				type: "error",
			}),
		);
	});

	it("bounds a stalled authenticated connectivity check", async () => {
		const root = tempRoot("pi-langfuse-operator-timeout-");
		process.env.PI_CODING_AGENT_DIR = root;
		const notifications: Array<{ message: string; type?: string }> = [];
		const server = createServer(() => {
			// Leave the response open so the command must enforce its own timeout.
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("operator timeout test server did not bind");
		}
		const host = `http://127.0.0.1:${address.port}`;
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({
				"extensions:settings": {
					"pi-langfuse": {
						enabled: true,
						"public-key": "public-key-for-timeout",
						"secret-key": "secret-key-for-timeout",
						"base-url": host,
					},
				},
			}),
		);
		const pi = createTestPi();
		await registerExtension(pi as unknown as ExtensionAPI);
		try {
			const startedAt = Date.now();
			await commandHandler(pi, "langfuse-test")("", {
				ui: {
					notify: (message: string, type?: string) =>
						notifications.push({ message, type }),
				},
				sessionManager: {
					getSessionFile: () => join(root, "session.jsonl"),
				},
				isIdle: () => true,
			});
			expect(Date.now() - startedAt).toBeLessThan(4_000);
			expect(notifications.at(-1)).toEqual(
				expect.objectContaining({
					message: expect.stringContaining("timed out"),
					type: "error",
				}),
			);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("adds no flush of its own when a configuration refresh finalizes an open prompt", async () => {
		const root = tempRoot("pi-langfuse-refresh-flush-");
		process.env.PI_CODING_AGENT_DIR = root;
		const pi = createTestPi({
			enabled: true,
			"public-key": "refresh-public",
			"secret-key": "refresh-secret",
			"base-url": "http://refresh-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);
		const context = {
			model: { id: "refresh-model", provider: "refresh-provider" },
			sessionManager: {
				getSessionFile: () => join(root, "refresh-session.jsonl"),
			},
			ui: { notify: vi.fn() },
			isIdle: () => false,
		};
		await eventHandler(pi, "session_start")({ reason: "startup" }, context);
		const promptEvent = (prompt: string) => ({
			prompt,
			systemPrompt: "system",
			systemPromptOptions: { cwd: root },
		});
		// The first prompt creates the runtime; settling it leaves nothing open.
		await eventHandler(pi, "before_agent_start")(
			promptEvent("first prompt"),
			context,
		);
		await eventHandler(pi, "agent_end")({ messages: [] }, context);
		await eventHandler(pi, "agent_settled")({}, context);
		// A refresh with nothing open sets the number of flushes a refresh needs.
		telemetry.state.flushes = 0;
		await commandHandler(pi, "langfuse:toggle")("on", context);
		const refreshFlushes = telemetry.state.flushes;
		await eventHandler(pi, "before_agent_start")(
			promptEvent("second prompt"),
			context,
		);
		const prompt = telemetry.state.observations
			.filter((record) => record.name === "agent.prompt")
			.at(-1);
		telemetry.state.flushes = 0;

		await commandHandler(pi, "langfuse:toggle")("on", context);

		expect(prompt?.end).toMatchObject({
			metadata: { abandonmentReason: "config refresh" },
		});
		expect(refreshFlushes).toBeGreaterThan(0);
		expect(telemetry.state.flushes).toBe(refreshFlushes);
		await eventHandler(pi, "session_shutdown")({}, context);
	});
}
