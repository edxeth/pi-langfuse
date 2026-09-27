import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import registerExtension from "../../src/index.js";
import { shutdownClient } from "../../src/langfuse-client.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import { type LangfuseRecorder, startLangfuseRecorder } from "./recorder.js";

/**
 * Real-Pi runtime test harness.
 *
 * Every case runs a genuine Pi SDK `createAgentSession` with:
 * - a temporary HOME and agent dir, so no user skills, context files, prompt
 *   templates, themes, packages, credentials, or settings can be discovered;
 * - the real pi-langfuse extension registered through the same module graph
 *   the tests import, so production timeouts stay controllable and assertions
 *   can share client state with the extension;
 * - a deterministic provider: either a scripted `pi-messages` provider on a
 *   local recording server, or the pi-ai faux provider;
 * - a local Langfuse recorder standing in for the supported server surface.
 *
 * The inherited environment is pinned and scrubbed before the Pi SDK is
 * imported. Nothing here touches the network beyond 127.0.0.1.
 */

type ScenarioSession = {
	prompt(text: string): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): void;
	compact(instructions?: string): Promise<unknown>;
	subscribe(
		listener: (event: { type: string } & Record<string, unknown>) => void,
	): () => void;
};

type PiModule = {
	ModelRuntime: {
		create(options: {
			authPath: string;
			modelsPath: string | null;
			allowModelNetwork: boolean;
			refreshOnCreate: boolean;
		}): Promise<{
			registerNativeProvider(provider: { name: string }): void;
			getModel(providerId: string, modelId: string): unknown;
		}>;
	};
	DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		extensionFactories?: InlineExtension[];
		noExtensions?: boolean;
		noSkills?: boolean;
		noPromptTemplates?: boolean;
		noThemes?: boolean;
		noContextFiles?: boolean;
	}) => {
		reload(): Promise<void>;
		getExtensions(): {
			extensions: Array<{ path: string }>;
			errors: Array<{ path: string; error: string }>;
		};
		getSkills(): { skills: unknown[] };
		getPrompts(): { prompts: unknown[] };
		getThemes(): { themes: unknown[] };
		getAgentsFiles(): { agentsFiles: unknown[] };
	};
	SettingsManager: {
		inMemory(settings?: Record<string, unknown>): unknown;
	};
	SessionManager: {
		create(cwd: string, sessionDir?: string): unknown;
	};
	createAgentSession(options: Record<string, unknown>): Promise<{
		session: ScenarioSession;
	}>;
};

export type FauxProviderHandle = {
	provider: { name: string };
	getModel(): unknown;
	setResponses(responses: unknown[]): void;
	appendResponses(responses: unknown[]): void;
};

export type PiAiModule = {
	Type: {
		Object(shape: Record<string, unknown>): unknown;
		String(options?: unknown): unknown;
	};
	fauxProvider(options: {
		provider: string;
		api: string;
		models: Array<Record<string, unknown>>;
	}): FauxProviderHandle;
	fauxAssistantMessage(
		content: unknown,
		options?: {
			stopReason?: string;
			errorMessage?: string;
			timestamp?: number;
		},
	): Record<string, unknown>;
	fauxText(text: string): Record<string, unknown>;
	fauxToolCall(
		name: string,
		args: Record<string, unknown>,
		options?: { id?: string },
	): unknown;
};

export type RuntimeCaseOptions = {
	/** Unique case name, used for the temp directory prefix. */
	name: string;
	/** Deterministic provider kind. */
	provider: { kind: "pi-messages"; baseUrl: string } | { kind: "faux" };
	/** pi-langfuse extension settings, written to the case settings.json. */
	settings?: Record<string, unknown>;
	/** Extra process environment for the case (applied after the scrub). */
	env?: Record<string, string | undefined>;
	/** Inline extension factories in addition to the pi-langfuse extension. */
	extensionFactories?: InlineExtension[];
	/** Pi custom tools, built after the deterministic provider is loaded. */
	customToolsFactory?: (piAi: PiAiModule) => Array<Record<string, unknown>>;
	/** Pi settings merged into the in-memory SettingsManager. */
	piSettings?: Record<string, unknown>;
};

export type DiscoverySummary = {
	skills: number;
	prompts: number;
	themes: number;
	agentsFiles: number;
	extensions: number;
	extensionErrors: number;
};

export type RuntimeCase = {
	caseDir: string;
	rawTraceDir: string;
	sessionDir: string;
	recorder: LangfuseRecorder;
	session: ScenarioSession;
	piAi: PiAiModule;
	faux: FauxProviderHandle | undefined;
	discovery: DiscoverySummary;
	/** Restore the environment, close servers, and remove all case files. */
	teardown(): Promise<void>;
};

const SENSITIVE_ENV_PREFIXES = ["LANGFUSE_", "PI_LANGFUSE_"];
const SENSITIVE_ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_PACKAGE_DIR",
	"PI_LANGFUSE_CONFIG",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GOOGLE_API_KEY",
	"XAI_API_KEY",
];

/**
 * Snapshot the process environment, remove every variable that could point Pi
 * or the extension at user resources or live providers, and pin the
 * isolation-critical ones. Run BEFORE any Pi SDK import.
 */
function isolateEnvironment(env: Record<string, string | undefined>) {
	const saved = { ...process.env };
	for (const key of Object.keys(process.env)) {
		if (SENSITIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			delete process.env[key];
		}
	}
	for (const key of SENSITIVE_ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const key of Object.keys(process.env)) {
			if (!(key in saved)) delete process.env[key];
		}
		for (const [key, value] of Object.entries(saved)) {
			process.env[key] = value;
		}
	};
}

function baseCaseEnv(agentDir: string, home: string): Record<string, string> {
	return {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_LANGFUSE_AUTOSTART: "0",
		PI_LANGFUSE_SKIP_UNPERSISTED: "0",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
}

let piModulePromise: Promise<PiModule> | undefined;
let piAiModulePromise: Promise<PiAiModule> | undefined;

/**
 * Import the installed Pi SDK only after the environment has been scrubbed.
 * Private on purpose: test files must never import Pi before
 * `createRuntimeCase` has isolated the environment; they use
 * `runtimeCase.piAi` instead. Modules are cached; every read Pi makes of the
 * agent dir or home happens at call time, so later cases stay isolated.
 */
async function loadPiSdk(): Promise<{ pi: PiModule; piAi: PiAiModule }> {
	piModulePromise ??= import(
		"@earendil-works/pi-coding-agent"
	) as Promise<PiModule>;
	const pi = await piModulePromise;
	piAiModulePromise ??= importPiAi();
	const piAi = await piAiModulePromise;
	return { pi, piAi };
}

async function importPiAi(): Promise<PiAiModule> {
	// @earendil-works/pi-ai is a dependency of the installed Pi SDK, not of
	// this package, so it lives either hoisted or nested under the SDK's own
	// node_modules depending on install shape. Resolve it from the repo's
	// dependency tree and import the JS entry directly.
	// SAFETY: interop boundary; pi-ai ships no type declarations to import.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const candidates = [
		join(
			repoRoot,
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"index.js",
		),
		join(
			repoRoot,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"index.js",
		),
	];
	const entry = candidates.find((candidate) => existsSync(candidate));
	if (!entry) {
		throw new Error(
			`@earendil-works/pi-ai not found in the repo dependency tree: ${candidates.join(", ")}`,
		);
	}
	return import(pathToFileURL(entry).href) as Promise<PiAiModule>;
}

export async function createRuntimeCase(
	options: RuntimeCaseOptions,
): Promise<RuntimeCase> {
	const caseDir = mkdtempSync(join(tmpdir(), `pi-runtime-${options.name}-`));
	const agentDir = join(caseDir, "agent");
	// The workspace sits below an owned ancestor directory so the harness can
	// plant discovery bait where Pi's ancestor walks (context files, .agents
	// skills) would find it if discovery were not disabled.
	const projectDir = join(caseDir, "project");
	const workDir = join(projectDir, "team", "workspace");
	const home = join(caseDir, "home");
	const sessionDir = join(caseDir, "sessions");
	const rawTraceDir = join(caseDir, "raw-traces");
	for (const dir of [agentDir, workDir, home, sessionDir, rawTraceDir]) {
		mkdirSync(dir, { recursive: true });
	}

	// Discovery bait, planted only in directories this case owns: an ancestor
	// context file on the workspace's walk chain and skills in every user- and
	// agent-scope skills directory the loader reads. If resource discovery were
	// not disabled, these would enter provider inputs; the per-case discovery
	// assertion below proves they never do.
	mkdirSync(join(projectDir, ".agents", "skills", "poison-skill"), {
		recursive: true,
	});
	writeFileSync(
		join(projectDir, ".agents", "skills", "poison-skill", "SKILL.md"),
		"---\nname: poison-skill\ndescription: isolated-runtime discovery bait\n---\nPOISON-SKILL-MARKER\n",
	);
	mkdirSync(join(home, ".agents", "skills", "poison-skill"), {
		recursive: true,
	});
	writeFileSync(
		join(home, ".agents", "skills", "poison-skill", "SKILL.md"),
		"---\nname: poison-skill\ndescription: isolated-runtime discovery bait\n---\nPOISON-SKILL-MARKER\n",
	);
	mkdirSync(join(agentDir, "skills", "poison-skill"), { recursive: true });
	writeFileSync(
		join(agentDir, "skills", "poison-skill", "SKILL.md"),
		"---\nname: poison-skill\ndescription: isolated-runtime discovery bait\n---\nPOISON-SKILL-MARKER\n",
	);
	writeFileSync(
		join(projectDir, "AGENTS.md"),
		"# POISON-CONTEXT-MARKER\nBait instructions that must never reach a provider.\n",
	);

	const recorder = await startLangfuseRecorder(options.name);
	const restoreEnvironment = isolateEnvironment({
		...baseCaseEnv(agentDir, home),
		...(options.env ?? {}),
	});

	const provider = options.provider;
	const providerBaseUrl =
		provider.kind === "pi-messages" ? provider.baseUrl : null;
	const providerModelsPath = providerBaseUrl
		? join(agentDir, "models.json")
		: null;
	if (providerModelsPath) {
		writeFileSync(
			providerModelsPath,
			`${JSON.stringify(
				{
					providers: {
						"probe-gw": {
							baseUrl: providerBaseUrl,
							api: "pi-messages",
							apiKey: "probe-key-not-a-secret",
							models: [
								{
									id: "probe-model",
									name: "Probe Model",
									reasoning: false,
									input: ["text"],
									cost: {
										input: 0.1,
										output: 0.2,
										cacheRead: 0,
										cacheWrite: 0,
									},
									contextWindow: 128000,
									maxTokens: 8192,
								},
							],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
	}

	writeFileSync(join(agentDir, "auth.json"), "{}\n");
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				"extensions:settings": {
					"pi-langfuse": {
						enabled: true,
						"public-key": "pk-local-runtime-test",
						"secret-key": "sk-local-runtime-test-secret",
						"base-url": recorder.url,
						"user-id": "runtime-test-user",
						release: "runtime-test-release",
						environment: "runtime-test-env",
						"raw-trace-enabled": true,
						"raw-trace-dir": rawTraceDir,
						...options.settings,
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	try {
		const { pi, piAi } = await loadPiSdk();

		const modelRuntime = await pi.ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: providerModelsPath,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});

		let faux: FauxProviderHandle | undefined;
		const model =
			provider.kind === "pi-messages"
				? modelRuntime.getModel("probe-gw", "probe-model")
				: (() => {
						const handle = piAi.fauxProvider({
							provider: "faux-local",
							api: "faux-api",
							models: [
								{
									id: "faux-model",
									name: "Faux Model",
									reasoning: false,
									input: ["text"],
									cost: {
										input: 0.1,
										output: 0.2,
										cacheRead: 0,
										cacheWrite: 0,
									},
									contextWindow: 128000,
									maxTokens: 8192,
								},
							],
						});
						modelRuntime.registerNativeProvider(handle.provider);
						faux = handle;
						return handle.getModel();
					})();
		if (!model) {
			throw new Error("deterministic provider model was not resolvable");
		}

		const resourceLoader = new pi.DefaultResourceLoader({
			cwd: workDir,
			agentDir,
			extensionFactories: [
				registerExtension as unknown as InlineExtension,
				...(options.extensionFactories ?? []),
			],
			// No user, project, ancestor, or package resource may reach the
			// session; only inline factories load (the loader appends them even
			// with noExtensions). Package discovery has no flag; it is bounded
			// by the empty temporary agent dir and asserted via the results.
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		// Every discovery category must be empty BEFORE the session or the
		// provider is used, in every case. A failure here aborts the case; the
		// catch below still restores the environment and closes the recorder.
		const discovery: DiscoverySummary = {
			skills: resourceLoader.getSkills().skills.length,
			prompts: resourceLoader.getPrompts().prompts.length,
			themes: resourceLoader.getThemes().themes.length,
			agentsFiles: resourceLoader.getAgentsFiles().agentsFiles.length,
			extensions: resourceLoader.getExtensions().extensions.length,
			extensionErrors: resourceLoader.getExtensions().errors.length,
		};
		const expectedExtensions = 1 + (options.extensionFactories?.length ?? 0);
		if (
			discovery.skills !== 0 ||
			discovery.prompts !== 0 ||
			discovery.themes !== 0 ||
			discovery.agentsFiles !== 0 ||
			discovery.extensionErrors > 0 ||
			discovery.extensions !== expectedExtensions
		) {
			throw new Error(
				`isolated case discovery is not clean: ${JSON.stringify({
					...discovery,
					errors: resourceLoader.getExtensions().errors,
					agentsFiles: resourceLoader.getAgentsFiles().agentsFiles,
				})}`,
			);
		}

		const settingsManager = pi.SettingsManager.inMemory({
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 5,
				maxAgentDelayMs: 60,
			},
			...(options.piSettings ?? {}),
		});

		const { session } = await pi.createAgentSession({
			cwd: workDir,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager: pi.SessionManager.create(workDir, sessionDir),
			settingsManager,
			customTools: options.customToolsFactory?.(piAi),
		});

		return {
			caseDir,
			rawTraceDir,
			sessionDir,
			recorder,
			session,
			piAi,
			faux,
			discovery,
			async teardown() {
				try {
					drainRawTraceQueue();
					await shutdownClient();
				} finally {
					restoreEnvironment();
					await recorder.close();
					rmSync(caseDir, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		restoreEnvironment();
		await recorder.close();
		rmSync(caseDir, { recursive: true, force: true });
		throw error;
	}
}

export type SessionEvent = { type: string } & Record<string, unknown>;

export function captureSessionEvents(session: ScenarioSession): SessionEvent[] {
	const events: SessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});
	return events;
}

/** Read every raw-trace JSONL record written for the case. */
export function readRawTraceRecords(
	rawTraceDir: string,
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	if (!existsSync(rawTraceDir)) return out;
	for (const entry of readdirSync(rawTraceDir)) {
		const entryPath = join(rawTraceDir, entry);
		if (!statSync(entryPath).isDirectory()) continue;
		for (const file of readdirSync(entryPath)) {
			const text = readFileSync(join(entryPath, file), "utf8").trim();
			if (!text) continue;
			for (const line of text.split("\n")) {
				out.push(JSON.parse(line) as Record<string, unknown>);
			}
		}
	}
	return out;
}

/** Read persisted session JSONL entries (compaction records live here). */
export function readSessionEntries(
	sessionDir: string,
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const file of readdirSync(sessionDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const text = readFileSync(join(sessionDir, file), "utf8").trim();
		if (!text) continue;
		for (const line of text.split("\n")) {
			out.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return out;
}

export type { LangfuseRecorder };
