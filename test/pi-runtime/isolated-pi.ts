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
import { afterEach } from "vitest";
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
 *
 * A case is owned by a lease taken before the first `await`. Vitest does not
 * cancel a timed-out test, so an abandoned `createRuntimeCase` can resume
 * after the test failed; the lease lets teardown discard it (see
 * `RuntimeCaseLease`). An `afterEach` hook registered here closes any case
 * the test never assigned to its own teardown variable.
 */

type ScenarioSession = {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
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
	/**
	 * Bound on how long closing the case waits for in-flight startup or Pi
	 * work to stop (default 5 s).
	 */
	closeTimeoutMs?: number;
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
	/**
	 * Stop Pi work, restore the environment, close servers, and remove all
	 * case files. Idempotent. After it runs the case refuses further session
	 * calls, so a test body that outlived a timeout cannot prompt it.
	 */
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

/** Default bound on how long a caller waits for a case to finish closing. */
const CASE_CLOSE_TIMEOUT_MS = 5_000;

const openLeases = new Set<RuntimeCaseLease>();

/**
 * Cleanup failures that surfaced after the caller of `close()` had already
 * given up on its bound. The next `closeOpenRuntimeCases` or
 * `createRuntimeCase` reports them, so a late failure is never lost.
 */
const abandonedCleanupFailures: unknown[] = [];

/**
 * Ownership of one runtime case, taken before the first `await`.
 *
 * Vitest does not cancel a timed-out test's promise: `createRuntimeCase` keeps
 * running after the test failed and its hooks ran, and so does any session
 * call the test started. The lease is how teardown reaches that work.
 *
 * - `close()` marks the lease closed at once. A startup checks the mark after
 *   every `await`, disposes what it created, and rejects instead of returning
 *   a case nobody owns. The guarded session refuses new calls.
 * - Every promise a guarded session call returns is tracked from invocation to
 *   settlement. The SDK's `abort()` resolves once the SDK is idle, which is
 *   earlier than a prompt held in `before_agent_start` (the SDK does not count
 *   it as running yet) and than a tool that ignores abort, so abort alone does
 *   not stop owned work. Cleanup waits for every tracked call.
 * - The lease owns the process environment and the case directory. They are
 *   released only after the work has settled, never because a caller's bound
 *   expired. A bounded `close()` that times out is a caller failure; cleanup
 *   keeps running in the background, the lease stays open, and no new case can
 *   start until it finishes.
 */
class RuntimeCaseLease {
	closing = false;
	private starting = true;
	private disposal: Promise<void> | undefined;
	private closure: Promise<void> | undefined;
	private readonly startupSettled: Promise<void>;
	private settleStartup: () => void = () => {};
	private restoreEnvironment: () => void = () => {};
	private readonly inFlight = new Set<Promise<void>>();
	private abortFailure: { error: unknown } | undefined;
	private waitingCallers = 0;
	caseDir: string | undefined;
	recorder: LangfuseRecorder | undefined;
	session: ScenarioSession | undefined;
	private sessionDisposed = false;

	constructor(
		readonly name: string,
		private readonly closeTimeoutMs: number,
	) {
		this.startupSettled = new Promise<void>((resolve) => {
			this.settleStartup = resolve;
		});
	}

	useEnvironment(restore: () => void) {
		this.restoreEnvironment = restore;
	}

	/** Throws when the owner closed the case while startup was awaiting. */
	assertOpen(step: string) {
		if (this.closing) {
			throw new Error(
				`runtime case ${this.name} was closed before startup finished (after ${step}); the abandoned startup was discarded`,
			);
		}
	}

	/** Startup finished and handed the case to its test. */
	markReady() {
		this.assertOpen("session creation");
		this.starting = false;
		this.settleStartup();
	}

	/** Startup ended with an error, after the lease disposed its resources. */
	markFailed() {
		this.starting = false;
		this.settleStartup();
	}

	/** Follow `work` until it settles, whether it resolves or rejects. */
	private track(work: PromiseLike<unknown>) {
		const settled: Promise<void> = Promise.resolve(work)
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => this.inFlight.delete(settled));
		this.inFlight.add(settled);
	}

	/** Wrap the session so a closed case refuses calls and open calls are tracked. */
	guardSession(session: ScenarioSession): ScenarioSession {
		this.session = session;
		return new Proxy(session, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (property === "dispose") {
						this.sessionDisposed = true;
					} else if (this.closing && property !== "abort") {
						throw new Error(
							`runtime case ${this.name} is closed; session.${String(property)}() was refused`,
						);
					}
					const result = value.apply(target, args);
					if (isThenable(result)) this.track(result);
					return result;
				};
			},
		});
	}

	/**
	 * Close the case within the caller's bound. A bound that expires rejects
	 * the caller only: the cleanup keeps running and keeps owning the case.
	 * Calling `close()` again joins the same cleanup.
	 */
	async close() {
		this.closing = true;
		this.closure ??= this.closeToCompletion();
		this.waitingCallers += 1;
		try {
			await withTimeout(
				this.closure,
				this.closeTimeoutMs,
				`runtime case ${this.name} did not finish closing within ${this.closeTimeoutMs} ms (startup or Pi work is still running); the case keeps its environment and directory, and no new case can start, until that work settles`,
			);
		} finally {
			this.waitingCallers -= 1;
		}
	}

	private async closeToCompletion() {
		try {
			// An in-flight startup disposes itself at its next check.
			if (this.starting) await this.startupSettled;
			await this.dispose();
		} catch (error) {
			// With no caller waiting, nobody else would see this failure.
			if (this.waitingCallers === 0) abandonedCleanupFailures.push(error);
			throw error;
		}
	}

	/** Stop the session, wait for its work to settle, then release. Idempotent. */
	dispose(): Promise<void> {
		this.closing = true;
		this.disposal ??= this.disposeOnce();
		return this.disposal;
	}

	private async disposeOnce() {
		const failures: unknown[] = [];
		const attempt = async (step: () => unknown) => {
			try {
				await step();
			} catch (error) {
				failures.push(error);
			}
		};

		await attempt(() => this.stopSession());
		// No bound here: releasing the environment while a call is still running
		// would hand it to the next case. Callers bound their own wait.
		await this.settleTrackedWork();
		if (this.abortFailure) failures.push(this.abortFailure.error);
		await attempt(async () => {
			drainRawTraceQueue();
			await shutdownClient();
		});
		// Nothing owned is running now, so the environment can be restored.
		await attempt(() => this.restoreEnvironment());
		try {
			await attempt(() => this.recorder?.close());
		} finally {
			try {
				if (this.caseDir)
					rmSync(this.caseDir, { recursive: true, force: true });
			} catch (error) {
				failures.push(error);
			}
			openLeases.delete(this);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				`runtime case ${this.name} cleanup failed`,
			);
		}
	}

	/** Abort and dispose the SDK session; they do not join its pending work. */
	private stopSession() {
		const session = this.session;
		if (!session) return;
		if (!this.sessionDisposed) {
			this.sessionDisposed = true;
			// Abort first: it settles the run the SDK knows about. Its failure
			// is reported after the join, once the session has gone quiet.
			const aborting = session.abort();
			aborting.catch((error: unknown) => {
				this.abortFailure = { error };
			});
			// Abort waits for SDK idleness, so it too can outlive the bound.
			this.track(aborting);
		}
		session.dispose();
	}

	private async settleTrackedWork() {
		while (this.inFlight.size > 0) {
			await Promise.all([...this.inFlight]);
		}
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Close every case that is still open. Registered as an `afterEach` hook below
 * so a case is released even when its test timed out before `activeCase` was
 * assigned and the test's own teardown had nothing to call.
 */
export async function closeOpenRuntimeCases() {
	const results = await Promise.allSettled(
		[...openLeases].map((lease) => lease.close()),
	);
	const failures = [
		...results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		),
		...abandonedCleanupFailures.splice(0),
	];
	if (failures.length > 0) {
		throw new AggregateError(failures, "runtime case cleanup failed");
	}
}

afterEach(closeOpenRuntimeCases);

export async function createRuntimeCase(
	options: RuntimeCaseOptions,
): Promise<RuntimeCase> {
	const open = openLeases.values().next().value;
	if (open) {
		throw new Error(
			`createRuntimeCase(${options.name}): runtime case ${open.name} is still open; tear it down before starting another`,
		);
	}
	if (abandonedCleanupFailures.length > 0) {
		throw new AggregateError(
			abandonedCleanupFailures.splice(0),
			`createRuntimeCase(${options.name}): an earlier runtime case failed to clean up after its caller stopped waiting`,
		);
	}
	// Everything up to the first `await` runs synchronously, so the lease and
	// its environment are in place before any teardown can observe the case.
	const lease = new RuntimeCaseLease(
		options.name,
		options.closeTimeoutMs ?? CASE_CLOSE_TIMEOUT_MS,
	);
	openLeases.add(lease);
	try {
		const runtimeCase = await startRuntimeCase(options, lease);
		lease.markReady();
		return runtimeCase;
	} catch (error) {
		try {
			await lease.dispose();
		} catch (disposeError) {
			throw new AggregateError(
				[error, disposeError],
				`runtime case ${options.name} failed to start and its cleanup also failed`,
			);
		} finally {
			lease.markFailed();
		}
		throw error;
	}
}

async function startRuntimeCase(
	options: RuntimeCaseOptions,
	lease: RuntimeCaseLease,
): Promise<RuntimeCase> {
	const caseDir = mkdtempSync(join(tmpdir(), `pi-runtime-${options.name}-`));
	lease.caseDir = caseDir;
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
	lease.useEnvironment(
		isolateEnvironment({
			...baseCaseEnv(agentDir, home),
			...(options.env ?? {}),
		}),
	);

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
	lease.recorder = recorder;
	lease.assertOpen("recorder start");

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

	const { pi, piAi } = await loadPiSdk();
	lease.assertOpen("Pi SDK import");

	const modelRuntime = await pi.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: providerModelsPath,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	lease.assertOpen("model runtime creation");

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
	lease.assertOpen("resource loading");

	// Every discovery category must be empty BEFORE the session or the
	// provider is used, in every case. A failure here aborts the case; the
	// caller still disposes the lease, restoring the environment and closing
	// the recorder.
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
	// Register the session with the lease before checking it, so a case closed
	// during session creation still aborts and disposes this session.
	const guardedSession = lease.guardSession(session);
	lease.assertOpen("session creation");

	return {
		caseDir,
		rawTraceDir,
		sessionDir,
		recorder,
		session: guardedSession,
		piAi,
		faux,
		discovery,
		teardown: () => lease.close(),
	};
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
