import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCapturePrivacyScenarios } from "../test/pi-runtime/compatibility-capture-privacy-scenarios.js";
import type {
	CompatibilityScenarioContext,
	FakeRecord,
	FakeTelemetryState,
} from "../test/pi-runtime/compatibility-fixtures.js";
import { registerGenerationCorrelationScenarios } from "../test/pi-runtime/compatibility-generation-correlation-scenarios.js";
import { registerGenerationEdgeCaseScenarios } from "../test/pi-runtime/compatibility-generation-edge-case-scenarios.js";
import { registerRunFinalizationScenarios } from "../test/pi-runtime/compatibility-run-finalization-scenarios.js";
import { registerRunLifecycleScenarios } from "../test/pi-runtime/compatibility-run-lifecycle-scenarios.js";
import { registerSessionLifecycleScenarios } from "../test/pi-runtime/compatibility-session-lifecycle-scenarios.js";
import { registerSettingsCommandsScenarios } from "../test/pi-runtime/compatibility-settings-commands-scenarios.js";
import { registerToolLifecycleScenarios } from "../test/pi-runtime/compatibility-tool-lifecycle-scenarios.js";
import { registerTurnSpanCaptureScenarios } from "../test/pi-runtime/compatibility-turn-span-capture-scenarios.js";
import { registerUsageAccountingScenarios } from "../test/pi-runtime/compatibility-usage-accounting-scenarios.js";
import {
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "./langfuse-client.js";
import { drainRawTraceQueue } from "./raw-trace.js";

const telemetry = vi.hoisted(() => {
	const state: FakeTelemetryState = {
		traces: [],
		observations: [],
		scores: [],
		flushes: 0,
		shutdowns: 0,
		received: [],
	};
	let nextId = 0;
	let activeSpan: { id: string; traceId: string } | undefined;
	let processorOptions: Record<string, unknown> = {};

	function createRecord(
		kind: FakeRecord["kind"],
		body: Record<string, unknown> | undefined,
	): FakeRecord {
		return {
			kind,
			id: `${kind}-${++nextId}`,
			...(body ?? {}),
		};
	}

	function traceForId(traceId: string | undefined) {
		return state.traces.find((record) => record.id === traceId);
	}

	function createObservation(
		name: string,
		body: Record<string, unknown>,
		parent?: { id: string; traceId: string },
		trace?: FakeRecord,
	) {
		const owningTrace = trace ?? traceForId(parent?.traceId);
		if (!owningTrace) throw new Error("fake observation has no trace");
		const record = createRecord("observation", {
			...body,
			name,
			traceId: owningTrace.id,
			parentObservationId: parent?.id,
		});
		state.observations.push(record);
		// Index the span like a server that received the normal export.
		state.received.push({
			traceId: String(record.traceId),
			spanId: String(record.id),
		});
		if (!parent) {
			if (body.input !== undefined) owningTrace.input = body.input;
			if (body.output !== undefined) owningTrace.output = body.output;
		}
		const raw = {
			id: record.id,
			traceId: owningTrace.id,
			otelSpan: { id: record.id, traceId: owningTrace.id },
			update: vi.fn((update: Record<string, unknown>) => {
				const normalized: Record<string, unknown> = {
					...update,
					...(update.level === "ERROR" ? { isError: true } : {}),
					...(update.usageDetails ? { usage: update.usageDetails } : {}),
				};
				record.updateCalls = [
					...((record.updateCalls as
						| Array<Record<string, unknown>>
						| undefined) ?? []),
					normalized,
				];
				record.pendingEnd = normalized;
				if (
					!record.name?.toString().startsWith("tool:") ||
					(update.metadata &&
						(update.metadata as Record<string, unknown>).partial)
				) {
					record.lastUpdate = normalized;
				}
				if (!parent) {
					owningTrace.lastUpdate = {
						...((owningTrace.lastUpdate as
							| Record<string, unknown>
							| undefined) ?? {}),
						...normalized,
						metadata: {
							...((owningTrace.metadata as
								| Record<string, unknown>
								| undefined) ?? {}),
							...((normalized.metadata as
								| Record<string, unknown>
								| undefined) ?? {}),
						},
					};
					if (normalized.metadata) {
						owningTrace.metadata = {
							...((owningTrace.metadata as
								| Record<string, unknown>
								| undefined) ?? {}),
							...normalized.metadata,
						};
					}
				}
			}),
			end: vi.fn(() => {
				const pendingEnd =
					(record.pendingEnd as Record<string, unknown> | undefined) ??
					(record.lastUpdate as Record<string, unknown> | undefined) ??
					{};
				record.end = {
					...pendingEnd,
					...(record.name?.toString().startsWith("tool:") &&
					pendingEnd.isError === undefined
						? { isError: false }
						: {}),
				};
				record.endCalls = Number(record.endCalls ?? 0) + 1;
			}),
			setTraceIO: vi.fn((io: { input?: unknown; output?: unknown }) => {
				if (io.input !== undefined) owningTrace.input = io.input;
				if (io.output !== undefined) owningTrace.output = io.output;
			}),
			startObservation: vi.fn(
				(
					childName: string,
					childBody: Record<string, unknown>,
					_childOptions?: Record<string, unknown>,
				) => createObservation(childName, childBody, raw, owningTrace),
			),
		};
		return raw;
	}

	const client = {
		api: {
			scores: {
				create: vi.fn(async (body: Record<string, unknown>) => {
					state.scores.push(body);
					return { id: `score-${state.scores.length}` };
				}),
			},
		},
		score: {
			create: vi.fn((body: Record<string, unknown>) => {
				state.scores.push(body);
			}),
			flush: vi.fn(async () => undefined),
			shutdown: vi.fn(async () => {
				state.shutdowns += 1;
			}),
		},
		flush: vi.fn(async () => undefined),
		shutdown: vi.fn(async () => {
			state.shutdowns += 1;
		}),
	};
	const LangfuseClient = vi.fn(() => client);
	const LangfuseSpanProcessor = vi.fn((options: Record<string, unknown>) => {
		processorOptions = options;
		return {
			forceFlush: vi.fn(async () => {
				state.flushes += 1;
			}),
			shutdown: vi.fn(async () => undefined),
		};
	});
	const BasicTracerProvider = vi.fn(
		(options: { spanProcessors?: unknown[] }) => ({
			spanProcessors: options.spanProcessors,
			forceFlush: vi.fn(async () => {
				state.flushes += 1;
			}),
			shutdown: vi.fn(async () => undefined),
		}),
	);
	const AsyncHooksContextManager = vi.fn(() => ({
		enable: vi.fn(function (this: unknown) {
			return this;
		}),
		disable: vi.fn(),
	}));
	const context = {
		active: vi.fn(() => (activeSpan ? { span: activeSpan } : {})),
		setGlobalContextManager: vi.fn(() => true),
		with: vi.fn(
			(next: { span?: { id: string; traceId: string } }, fn: () => unknown) => {
				const previous = activeSpan;
				activeSpan = next.span;
				try {
					return fn();
				} finally {
					activeSpan = previous;
				}
			},
		),
	};
	const trace = {
		setSpan: vi.fn(
			(_current: unknown, span: { id: string; traceId: string }) => ({
				span,
			}),
		),
		// Mirrors @opentelemetry/api: prompt roots strip ambient parents.
		deleteSpan: vi.fn((_current: { span?: unknown }) => ({ span: undefined })),
	};
	const tracing = {
		propagateAttributes: vi.fn(
			(attributes: Record<string, unknown>, fn: () => unknown) => {
				const existingTrace = traceForId(activeSpan?.traceId);
				const owningTrace =
					existingTrace ??
					createRecord("trace", {
						name: attributes.traceName,
						sessionId: attributes.sessionId,
						userId: attributes.userId,
						tags: attributes.tags,
						release: attributes.release ?? processorOptions.release,
						version: attributes.version,
						environment: attributes.environment ?? processorOptions.environment,
						metadata: attributes.metadata,
					});
				if (!existingTrace) state.traces.push(owningTrace);
				return fn();
			},
		),
		startObservation: vi.fn(
			(
				name: string,
				body: Record<string, unknown>,
				_options?: Record<string, unknown>,
			) => {
				const owningTrace =
					traceForId(activeSpan?.traceId) ?? state.traces.at(-1);
				return createObservation(name, body, undefined, owningTrace);
			},
		),
		setLangfuseTracerProvider: vi.fn(),
	};

	return {
		client,
		state,
		LangfuseClient,
		LangfuseSpanProcessor,
		BasicTracerProvider,
		AsyncHooksContextManager,
		context,
		trace,
		tracing,
		reset() {
			state.traces.length = 0;
			state.observations.length = 0;
			state.scores.length = 0;
			state.received.length = 0;
			state.flushes = 0;
			state.shutdowns = 0;
			nextId = 0;
			activeSpan = undefined;
			processorOptions = {};
			LangfuseClient.mockClear();
			LangfuseSpanProcessor.mockClear();
			BasicTracerProvider.mockClear();
			AsyncHooksContextManager.mockClear();
			tracing.propagateAttributes.mockClear();
			tracing.startObservation.mockClear();
			tracing.setLangfuseTracerProvider.mockClear();
		},
	};
});

vi.mock("@langfuse/client", () => ({
	LangfuseClient: telemetry.LangfuseClient,
}));
vi.mock("@langfuse/otel", () => ({
	LangfuseSpanProcessor: telemetry.LangfuseSpanProcessor,
}));
vi.mock("@langfuse/tracing", () => telemetry.tracing);
vi.mock("@opentelemetry/api", () => ({
	context: telemetry.context,
	trace: telemetry.trace,
}));
vi.mock("@opentelemetry/context-async-hooks", () => ({
	AsyncHooksContextManager: telemetry.AsyncHooksContextManager,
}));
vi.mock("@opentelemetry/sdk-trace-base", () => ({
	BasicTracerProvider: telemetry.BasicTracerProvider,
}));

const createdRoots: string[] = [];

function tempRoot(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	createdRoots.push(root);
	return root;
}

// The fake telemetry stack never delivers anywhere real; shrinking the
// bounded shutdown and flush steps keeps multi-prompt scenarios well inside
// the vitest timeout without changing the production lifecycle. (The old
// visibility-poll windows are gone: the runtime no longer polls a read API.)
let restoreRuntimeTimeouts: (() => void) | undefined;

beforeEach(() => {
	drainRawTraceQueue();
	telemetry.reset();
	restoreRuntimeTimeouts = setRuntimeTimeoutsForTest({
		exportMs: 100,
	});
	delete process.env.LANGFUSE_PUBLIC_KEY;
	delete process.env.LANGFUSE_SECRET_KEY;
	delete process.env.LANGFUSE_BASE_URL;
	delete process.env.LANGFUSE_HOST;
	delete process.env.LANGFUSE_RELEASE;
	delete process.env.LANGFUSE_ENV;
	delete process.env.PI_LANGFUSE_REDACTION;
	delete process.env.PI_LANGFUSE_UNREDACTED;
	delete process.env.PI_LANGFUSE_RAW_TRACE;
	delete process.env.PI_LANGFUSE_RAW_TRACE_DIR;
	delete process.env.PI_LANGFUSE_SKIP_UNPERSISTED;
	delete process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_LANGFUSE_CONFIG;
});

afterEach(async () => {
	drainRawTraceQueue();
	await shutdownClient();
	restoreRuntimeTimeouts?.();
	restoreRuntimeTimeouts = undefined;
	for (const root of createdRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("executable compatibility contract", () => {
	const scenarioContext: CompatibilityScenarioContext = {
		telemetry,
		tempRoot,
	};
	registerSessionLifecycleScenarios(scenarioContext);

	registerSettingsCommandsScenarios(scenarioContext);

	registerGenerationCorrelationScenarios(scenarioContext);

	registerTurnSpanCaptureScenarios(scenarioContext);

	registerGenerationEdgeCaseScenarios(scenarioContext);

	registerToolLifecycleScenarios(scenarioContext);

	registerRunLifecycleScenarios(scenarioContext);

	registerUsageAccountingScenarios(scenarioContext);

	registerRunFinalizationScenarios(scenarioContext);

	registerCapturePrivacyScenarios(scenarioContext);

	it("keeps the compiled package entrypoint loadable", async () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
		) as { main?: string };
		expect(packageJson.main).toBe("dist/index.js");

		const fixtureRoot = tempRoot("pi-langfuse-entrypoint-");
		const fixtureDist = join(fixtureRoot, "dist");
		mkdirSync(fixtureDist, { recursive: true });
		writeFileSync(
			join(fixtureRoot, "package.json"),
			JSON.stringify({ type: "module" }),
		);
		symlinkSync(
			resolve("node_modules"),
			join(fixtureRoot, "node_modules"),
			"dir",
		);
		execFileSync(
			process.execPath,
			[
				resolve("node_modules/typescript/bin/tsc"),
				"--project",
				resolve("tsconfig.json"),
				"--outDir",
				fixtureDist,
			],
			{ cwd: process.cwd() },
		);

		const compiled = await import(
			pathToFileURL(join(fixtureDist, "index.js")).href
		);
		expect(compiled.default).toBeTypeOf("function");
	});
});
