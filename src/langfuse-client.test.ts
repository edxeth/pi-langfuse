import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
	flushClient,
	getLastRuntimeError,
	getRuntime,
	getRuntimeRegistrySizeForTest,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "./langfuse-client.js";

const mocks = vi.hoisted(() => {
	const records: Array<Record<string, unknown>> = [];
	let nextId = 0;
	let currentSpan: { id: string; traceId: string } | undefined;

	function observation(
		name: string,
		body: Record<string, unknown>,
		parent?: { id: string; traceId: string },
		traceId = parent?.traceId || `trace-${++nextId}`,
	) {
		const record: Record<string, unknown> = {
			kind: "observation",
			id: `${name}-${++nextId}`,
			name,
			traceId,
			parentObservationId: parent?.id,
			...body,
		};
		records.push(record);
		const raw = {
			id: String(record.id),
			traceId,
			otelSpan: { id: String(record.id), traceId },
			update: vi.fn((update: Record<string, unknown>) => {
				record.lastUpdate = update;
				record.updateCalls = [
					...((record.updateCalls as
						| Array<Record<string, unknown>>
						| undefined) ?? []),
					update,
				];
			}),
			end: vi.fn(() => {
				record.end = record.lastUpdate;
			}),
			setTraceIO: vi.fn(),
			setTraceAsPublic: vi.fn(() => {
				record.setTraceAsPublicCalls =
					Number(record.setTraceAsPublicCalls ?? 0) + 1;
			}),
			startObservation: vi.fn(
				(
					childName: string,
					childBody: Record<string, unknown>,
					_options?: Record<string, unknown>,
				) => observation(childName, childBody, raw, traceId),
			),
		};
		return raw;
	}

	const exportedSpans: Array<Array<Record<string, unknown>>> = [];
	let exportResult: { code: number; error?: Error } | "hang" = { code: 0 };
	const OTLPTraceExporter = vi.fn(() => ({
		export: vi.fn(
			(
				spans: Array<Record<string, unknown>>,
				callback: (result: { code: number; error?: Error }) => void,
			) => {
				// "hang" never calls back so the drain's outer timeout fires.
				if (exportResult === "hang") return;
				exportedSpans.push(spans);
				callback(exportResult);
			},
		),
	}));
	const observationsGetMany = vi.fn(
		async (): Promise<{
			data?: Array<{ id: string }>;
			meta?: { cursor?: string };
		}> => ({ data: [], meta: {} }),
	);
	const client = {
		api: { observations: { getMany: observationsGetMany } },
		score: {
			create: vi.fn(),
			flush: vi.fn(async () => undefined),
			shutdown: vi.fn(async () => undefined),
		},
		flush: vi.fn(async () => undefined),
		shutdown: vi.fn(async () => undefined),
	};
	const LangfuseClient = vi.fn(() => client);
	const LangfuseSpanProcessor = vi.fn(() => ({
		forceFlush: vi.fn(async () => undefined),
		shutdown: vi.fn(async () => undefined),
	}));
	const tracerProviders: Array<{
		forceFlush: ReturnType<typeof vi.fn>;
		shutdown: ReturnType<typeof vi.fn>;
	}> = [];
	const BasicTracerProvider = vi.fn(() => {
		const provider = {
			forceFlush: vi.fn(async () => undefined),
			shutdown: vi.fn(async () => undefined),
		};
		tracerProviders.push(provider);
		return provider;
	});
	const AsyncHooksContextManager = vi.fn(() => ({
		enable: vi.fn(function (this: unknown) {
			return this;
		}),
		disable: vi.fn(),
	}));
	const context = {
		active: vi.fn(() => (currentSpan ? { span: currentSpan } : {})),
		setGlobalContextManager: vi.fn(() => true),
		with: vi.fn(
			(next: { span?: { id: string; traceId: string } }, fn: () => unknown) => {
				const previous = currentSpan;
				currentSpan = next.span;
				const result = fn();
				if (result && typeof (result as Promise<unknown>).then === "function") {
					return (result as Promise<unknown>).finally(() => {
						currentSpan = previous;
					});
				}
				currentSpan = previous;
				return result;
			},
		),
	};
	const trace = {
		setSpan: vi.fn(
			(_current: unknown, span: { id: string; traceId: string }) => ({
				span,
			}),
		),
		deleteSpan: vi.fn((_current: { span?: unknown }) => ({ span: undefined })),
	};
	const tracing = {
		propagateAttributes: vi.fn(
			(_attributes: Record<string, unknown>, fn: () => unknown) => fn(),
		),
		startObservation: vi.fn(
			(
				name: string,
				body: Record<string, unknown>,
				_options?: Record<string, unknown>,
			) => observation(name, body, currentSpan),
		),
		setLangfuseTracerProvider: vi.fn(),
	};

	return {
		client,
		records,
		LangfuseClient,
		LangfuseSpanProcessor,
		BasicTracerProvider,
		AsyncHooksContextManager,
		OTLPTraceExporter,
		observationsGetMany,
		exportedSpans,
		setExportResult(result: { code: number; error?: Error } | "hang") {
			exportResult = result;
		},
		tracerProviders,
		context,
		trace,
		tracing,
	};
});

vi.mock("@langfuse/client", () => ({ LangfuseClient: mocks.LangfuseClient }));
vi.mock("@langfuse/otel", () => ({
	LangfuseSpanProcessor: mocks.LangfuseSpanProcessor,
}));
vi.mock("@langfuse/tracing", () => mocks.tracing);
vi.mock("@opentelemetry/api", () => ({
	context: mocks.context,
	trace: mocks.trace,
	SpanKind: { INTERNAL: 0 },
	SpanStatusCode: { UNSET: 0, ERROR: 2 },
	TraceFlags: { SAMPLED: 1, NONE: 0 },
}));
vi.mock("@opentelemetry/context-async-hooks", () => ({
	AsyncHooksContextManager: mocks.AsyncHooksContextManager,
}));
vi.mock("@opentelemetry/sdk-trace-base", () => ({
	BasicTracerProvider: mocks.BasicTracerProvider,
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: mocks.OTLPTraceExporter,
}));
vi.mock("@opentelemetry/core", () => ({
	ExportResultCode: { SUCCESS: 0, FAILED: 1 },
	timeInputToHrTime: (input: Date | number): [number, number] => {
		const date = input instanceof Date ? input : new Date(input);
		return [
			Math.floor(date.getTime() / 1000),
			(date.getTime() % 1000) * 1_000_000,
		];
	},
}));

const config: Config = {
	enabled: true,
	publicKey: "pk-lf-test",
	secretKey: "sk-lf-test-secret-1234567890",
	host: "http://localhost:3100",
	userId: "tester",
	defaultTags: [],
	release: "",
	environment: "",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: true,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: [],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

describe("langfuse v5 runtime facade", () => {
	afterEach(async () => {
		await shutdownClient();
		vi.clearAllMocks();
		mocks.records.length = 0;
		mocks.exportedSpans.length = 0;
		mocks.setExportResult({ code: 0 });
		mocks.tracerProviders.length = 0;
	});

	type ExportedSpan = {
		name: string;
		spanContext(): { traceId: string; spanId: string };
		parentSpanContext?: { spanId: string };
		attributes: Record<string, unknown>;
	};

	const allExportedSpans = () =>
		mocks.exportedSpans.flat() as unknown as ExportedSpan[];

	const exportedSpan = (name: string, id: string) => {
		const span = allExportedSpans().find(
			(candidate) =>
				candidate.name === name && candidate.spanContext().spanId === id,
		);
		if (!span) throw new Error(`exported span ${name}/${id} was not found`);
		return span;
	};

	it("sanitizes trace, span, generation, and update/end payloads before OTel calls", async () => {
		const lf = await getRuntime(config);
		const trace = lf.trace({
			name: "pi-agent",
			input: "secret sk-lf-test-secret-1234567890",
		});
		trace.update({
			output: "LANGFUSE_SECRET_KEY=sk-lf-test-secret-1234567890",
		});
		const span = lf.span({
			name: "tool:bash",
			traceId: trace.id,
			input: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		});
		span.end({ output: "Bearer abcdefghijklmnopqrstuvwxyz123456" });
		const generation = lf.generation({
			name: "llm-response",
			traceId: trace.id,
			input: [{ role: "user", content: "sk-lf-test-secret-1234567890" }],
		});
		generation.end({ output: "hf_abcdefghijklmnopqrstuvwxyz" });
		const mediaOutput = [
			'data: 0:"Hello! How can I help you today?"',
			'data: d:{"credits_used":0.0046,"tokens":{"input":60,"output":8,"total":68}}',
		].join("\n");
		const mediaSpan = lf.span({ name: "tool:media", traceId: trace.id });
		mediaSpan.end({ output: mediaOutput });
		const mediaGeneration = lf.generation({
			name: "llm-media",
			traceId: trace.id,
		});
		mediaGeneration.end({ output: mediaOutput });
		const actualMedia = lf.span({
			name: "tool:actual-media",
			traceId: trace.id,
		});
		actualMedia.end({ output: "data:image/png;base64,AAAA" });
		const embeddedMedia = lf.span({
			name: "tool:embedded-media",
			traceId: trace.id,
		});
		embeddedMedia.end({
			output: "before data:image/png;base64,AAAA after",
		});
		const repeatedPrefixes = lf.span({
			name: "tool:repeated-prefixes",
			traceId: trace.id,
		});
		repeatedPrefixes.end({ output: "data: first, then data: second" });

		const serialized = JSON.stringify(mocks.records);
		expect(serialized).not.toContain("sk-lf-test-secret-1234567890");
		expect(serialized).not.toContain(
			"ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		);
		expect(serialized).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz123456");
		expect(serialized).not.toContain("hf_abcdefghijklmnopqrstuvwxyz");
		for (const record of mocks.records.filter(
			(item) => item.name === "tool:media" || item.name === "llm-media",
		)) {
			const output = String(
				(record.end as Record<string, unknown> | undefined)?.output,
			);
			if (!output || output === "undefined") continue;
			expect(output).not.toMatch(/^data:/);
			expect(output).toContain('data\\: 0:"Hello! How can I help you today?"');
			expect(output).toContain('data\\: d:{"credits_used":0.0046');
		}
		expect(serialized).toContain("data\\\\: 0:");
		expect(serialized).toContain("data\\\\: d:");
		expect(serialized).toContain("credits_used");
		const actualMediaRecord = mocks.records.find(
			(item) => item.name === "tool:actual-media",
		);
		expect(
			(actualMediaRecord?.end as Record<string, unknown> | undefined)?.output,
		).toBe("data:image/png;base64,AAAA");
		const embeddedMediaRecord = mocks.records.find(
			(item) => item.name === "tool:embedded-media",
		);
		expect(
			(embeddedMediaRecord?.end as Record<string, unknown> | undefined)?.output,
		).toBe("before data:image/png;base64,AAAA after");
		const repeatedPrefixesRecord = mocks.records.find(
			(item) => item.name === "tool:repeated-prefixes",
		);
		expect(
			(repeatedPrefixesRecord?.end as Record<string, unknown> | undefined)
				?.output,
		).toBe("data\\: first, then data\\: second");
		expect(serialized).toContain("[REDACTED:langfuse-secret-key:");
		expect(serialized).toContain("[REDACTED:github-token:");
		expect(serialized).toContain("[REDACTED:bearer-token:");
		expect(serialized).toContain("[REDACTED:huggingface-token:");
	});

	it("retains trace metadata across sequential updates", async () => {
		const lf = await getRuntime(config);
		const trace = lf.trace({
			name: "pi-agent",
			metadata: { initial: "kept" },
		});
		trace.update({ metadata: { later: "kept" } });
		lf.span({ name: "agent.prompt", traceId: trace.id });

		const root = mocks.records.find((record) => record.name === "agent.prompt");
		expect(root?.lastUpdate).toMatchObject({
			metadata: { initial: "kept", later: "kept" },
		});
	});

	it("serializes concurrent runtime replacement", async () => {
		await getRuntime(config);
		const [first, second] = await Promise.all([
			getRuntime({ ...config, host: "http://runtime-one" }),
			getRuntime({ ...config, host: "http://runtime-two" }),
		]);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(mocks.LangfuseClient).toHaveBeenCalledTimes(3);
	});

	it("rejects a conflicting configuration while the active runtime holds observations", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const first = await getRuntime(config);
			const trace = first.trace({ name: "pi-agent" });
			const prompt = first.span({ name: "agent.prompt", traceId: trace.id });
			await expect(
				getRuntime({ ...config, host: "http://deferred" }),
			).rejects.toThrow(/different configuration/);
			expect(mocks.LangfuseClient).toHaveBeenCalledTimes(1);
			expect(getLastRuntimeError()?.message).toContain(
				"different configuration",
			);
			// The conflicting request must not send telemetry through the old
			// runtime: only the active prompt's own records exist.
			expect(mocks.records).toHaveLength(1);

			prompt.end({ output: "done" });
			await getRuntime({ ...config, host: "http://deferred" });
			expect(mocks.LangfuseClient).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("reuses the active runtime when the requested configuration is unchanged", async () => {
		await getRuntime(config);
		await getRuntime(config);
		expect(mocks.LangfuseClient).toHaveBeenCalledTimes(1);
	});

	it("releases ended observations from the shared runtime registry", async () => {
		const lf = await getRuntime(config);
		for (let index = 0; index < 20; index += 1) {
			const trace = lf.trace({ name: "pi-agent" });
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: `answer-${index}` });
		}
		expect(getRuntimeRegistrySizeForTest()).toEqual({
			traces: 0,
			observations: 0,
		});
	});

	it("starts each prompt root independently of any active external span", async () => {
		const external = { id: "external-span", traceId: "c".repeat(32) };
		await mocks.context.with({ span: external }, async () => {
			const lf = await getRuntime(config);
			const trace = lf.trace({ id: "a".repeat(32), name: "pi-agent" });
			expect(trace.id).not.toBe(external.traceId);
		});
		expect(mocks.trace.deleteSpan).toHaveBeenCalled();
		const root = mocks.records.find((record) => record.name === "agent.prompt");
		if (!root) throw new Error("prompt root was not created");
		expect(root.parentObservationId).toBeUndefined();
		expect(root.traceId).not.toBe(external.traceId);
	});

	it("sends the configured environment with scores", async () => {
		const lf = await getRuntime({ ...config, environment: "staging" });
		lf.score({ name: "tool_success_rate", value: 1, traceId: "trace-1" });
		expect(mocks.client.score.create).toHaveBeenCalledTimes(1);
		expect(mocks.client.score.create).toHaveBeenCalledWith(
			expect.objectContaining({ environment: "staging" }),
		);

		const unset = await getRuntime(config);
		unset.score({ name: "tool_success_rate", value: 1, traceId: "trace-2" });
		const lastScore = (
			mocks.client.score.create.mock.calls.at(-1)?.[0] ?? {}
		) as Record<string, unknown>;
		expect(lastScore.environment).toBeUndefined();
	});

	it("applies the public flag on the OTel path without ever unpublishing", async () => {
		const lf = await getRuntime(config);
		const publicTrace = lf.trace({ name: "pi-agent", public: true });
		const privateTrace = lf.trace({ name: "pi-agent" });
		const laterPublic = lf.trace({ name: "pi-agent" });
		laterPublic.update({ public: true });
		const forcedPrivate = lf.trace({ name: "pi-agent", public: true });
		forcedPrivate.update({ public: false });

		const publicCalls = (traceId: string) => {
			const root = mocks.records.find((record) => record.traceId === traceId);
			if (!root) throw new Error("trace root was not created");
			return Number(root.setTraceAsPublicCalls ?? 0);
		};
		// The published flag must reach the normal OTel path, not only the
		// fallback, and must never attempt to reverse a publication.
		expect(publicCalls(publicTrace.id)).toBe(1);
		expect(publicCalls(privateTrace.id)).toBe(0);
		expect(publicCalls(laterPublic.id)).toBe(1);
		expect(publicCalls(forcedPrivate.id)).toBe(1);
	});

	it("keeps an asynchronous observation context across awaited work", async () => {
		const lf = await getRuntime(config);
		const trace = lf.trace({ name: "pi-agent" });
		const span = lf.span({ name: "agent.prompt", traceId: trace.id });
		const observedTraceId = await lf.withContext(span, async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			return mocks.context.active().span?.traceId;
		});
		expect(observedTraceId).toBe(trace.id);
		expect(mocks.context.with).toHaveBeenCalled();
	});

	it("bounds prompt flush without shutting down the shared runtime", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		let provider: (typeof mocks.tracerProviders)[number] | undefined;
		try {
			await getRuntime(config);
			provider = mocks.tracerProviders[mocks.tracerProviders.length - 1];
			if (!provider) throw new Error("tracer provider was not created");
			provider.forceFlush.mockImplementation(
				() => new Promise<never>(() => {}),
			);
			const startedAt = Date.now();
			await flushClient();
			expect(Date.now() - startedAt).toBeLessThan(80);
			expect(mocks.client.shutdown).not.toHaveBeenCalled();
			expect(provider.shutdown).not.toHaveBeenCalled();
		} finally {
			provider?.forceFlush.mockResolvedValue(undefined);
			restoreTimeouts();
		}
	});

	it("bounds every shutdown dependency independently", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		try {
			for (const dependency of [
				"otel flush",
				"score flush",
				"client shutdown",
				"tracer shutdown",
			]) {
				mocks.client.flush.mockReset().mockResolvedValue(undefined);
				mocks.client.shutdown.mockReset().mockResolvedValue(undefined);
				mocks.observationsGetMany
					.mockReset()
					.mockResolvedValue({ data: [], meta: {} });
				const lf = await getRuntime(config);
				const trace = lf.trace({ name: "pi-agent" });
				const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
				prompt.end({ output: "done" });
				const provider =
					mocks.tracerProviders[mocks.tracerProviders.length - 1];
				if (!provider) throw new Error("tracer provider was not created");
				if (dependency === "otel flush") {
					provider.forceFlush.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				} else if (dependency === "score flush") {
					mocks.client.flush.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				} else if (dependency === "client shutdown") {
					mocks.client.shutdown.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				} else {
					provider.shutdown.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				}
				const startedAt = Date.now();
				await shutdownClient();
				expect(Date.now() - startedAt).toBeLessThan(180);
				expect(mocks.client.flush).toHaveBeenCalledTimes(1);
				expect(mocks.client.shutdown).toHaveBeenCalledTimes(1);
				expect(provider.forceFlush).toHaveBeenCalledTimes(1);
				expect(provider.shutdown).toHaveBeenCalledTimes(1);
			}
		} finally {
			restoreTimeouts();
		}
	});

	it("replays an unconfirmed trace once with redacted trace and observation facts", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const secret = "sk-lf-test-secret-1234567890";
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			const lf = await getRuntime(config);
			const trace = lf.trace({
				id: "a".repeat(32),
				name: "pi-agent",
				input: `prompt ${secret}`,
				sessionId: "fallback-session",
				metadata: { source: "test" },
			});
			trace.setTraceIO?.({
				input: `prompt ${secret}`,
				output: "final answer",
			});
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			const turn = lf.span({
				name: "agent.turn",
				traceId: trace.id,
				parentObservationId: prompt.id,
			});
			const generation = lf.generation({
				name: "llm-response",
				traceId: trace.id,
				parentObservationId: turn.id,
				model: "fallback-model",
			});
			const tool = lf.span({
				name: "tool:bash",
				traceId: trace.id,
				parentObservationId: turn.id,
				input: `command ${secret}`,
			});
			generation.end({
				output: "generated answer",
				usageDetails: { input: 4, output: 6, total: 10 },
				costDetails: { total: 0.1 },
			});
			tool.end({
				output: `tool output ${secret}`,
				isError: true,
				statusMessage: "tool failed",
			});
			turn.end({ output: "final answer" });
			prompt.end({ output: "final answer" });

			await flushClient();
			expect(mocks.client.shutdown).not.toHaveBeenCalled();

			const spans = allExportedSpans();
			expect(spans.map((span) => span.name)).toEqual([
				"agent.prompt",
				"agent.turn",
				"llm-response",
				"tool:bash",
			]);
			for (const span of spans) {
				expect(span.spanContext().traceId).toBe(trace.id);
			}
			const root = exportedSpan("agent.prompt", prompt.id);
			expect(root.parentSpanContext).toBeUndefined();
			expect(root.attributes["langfuse.trace.name"]).toBe("pi-agent");
			expect(root.attributes["session.id"]).toBe("fallback-session");
			expect(String(root.attributes["langfuse.trace.input"])).toContain(
				"[REDACTED:",
			);
			expect(root.attributes["langfuse.trace.output"]).toBe("final answer");
			expect(
				exportedSpan("agent.turn", turn.id).parentSpanContext?.spanId,
			).toBe(prompt.id);
			const generationSpan = exportedSpan("llm-response", generation.id);
			expect(generationSpan.parentSpanContext?.spanId).toBe(turn.id);
			expect(generationSpan.attributes["langfuse.observation.model.name"]).toBe(
				"fallback-model",
			);
			expect(
				JSON.parse(
					String(generationSpan.attributes["langfuse.observation.usage_details"]),
				),
			).toEqual({ input: 4, output: 6, total: 10 });
			expect(
				JSON.parse(
					String(generationSpan.attributes["langfuse.observation.cost_details"]),
				),
			).toEqual({ total: 0.1 });
			const toolSpan = exportedSpan("tool:bash", tool.id);
			expect(toolSpan.parentSpanContext?.spanId).toBe(turn.id);
			expect(toolSpan.attributes["langfuse.observation.level"]).toBe("ERROR");
			expect(toolSpan.attributes["langfuse.observation.status_message"]).toBe(
				"tool failed",
			);
			expect(JSON.stringify(spans)).not.toContain(secret);
		} finally {
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("chunks oversized replay spans across bounded export calls", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		try {
			const payload = "x ".repeat(800_000);
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			const fallbackConfig = {
				...config,
				payloadMaxStringChars: Infinity,
				payloadMaxToolChars: Infinity,
				payloadMaxDepth: Infinity,
				payloadMaxArrayItems: Infinity,
				payloadMaxObjectKeys: Infinity,
				payloadMaxNodes: Infinity,
			};
			const lf = await getRuntime(fallbackConfig);
			for (const id of ["c".repeat(32), "d".repeat(32), "e".repeat(32)]) {
				const trace = lf.trace({ id, name: "pi-agent", input: payload });
				const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
				prompt.end({ output: "done" });
			}

			await flushClient();
			const calls = mocks.exportedSpans;

			expect(calls.length).toBeGreaterThan(1);
			for (const spans of calls) {
				expect(
					Buffer.byteLength(JSON.stringify(spans), "utf8"),
				).toBeLessThanOrEqual(3_500_000);
			}
			await shutdownClient();
			const callsAfterShutdown = mocks.exportedSpans.length;
			expect(callsAfterShutdown).toBe(calls.length);
		} finally {
			restoreTimeouts();
		}
	});

	it("recovers a visible trace whose recorded observations are incomplete", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			const lf = await getRuntime(config);
			const trace = lf.trace({ id: "a".repeat(32), name: "pi-agent" });
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			const turn = lf.span({
				name: "agent.turn",
				traceId: trace.id,
				parentObservationId: prompt.id,
			});
			turn.end({ output: "turn done" });
			prompt.end({ output: "done" });

			// The server knows only the root observation; the child span was
			// lost by a failed export batch. Partial visibility must not skip
			// the fallback replay for the missing observation.
			mocks.observationsGetMany.mockResolvedValue({
				data: [{ id: prompt.id }],
				meta: {},
			});

			await flushClient();

			const replayed = allExportedSpans().find(
				(span) => span.name === "agent.turn",
			);
			if (!replayed) throw new Error("missing observation was not replayed");
			expect(replayed.spanContext().spanId).toBe(turn.id);
			const fallbackWarning = warn.mock.calls.find(([message]) =>
				String(message).includes("REST fallback"),
			);
			expect(fallbackWarning).toBeUndefined();
		} finally {
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("retains failed replay traces and retries with stable span identities", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			mocks.setExportResult({
				code: 1,
				error: new Error("HTTP 503 unavailable"),
			});
			const lf = await getRuntime(config);
			const trace = lf.trace({
				id: "a".repeat(32),
				name: "pi-agent",
				input: "retry prompt",
			});
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "done" });

			await flushClient();
			expect(mocks.exportedSpans.length).toBe(1);

			mocks.setExportResult({ code: 0 });
			await flushClient();
			expect(mocks.exportedSpans.length).toBe(2);

			const identity = (round: number) =>
				(mocks.exportedSpans[round] as unknown as ExportedSpan[])
					.map((span) => `${span.spanContext().traceId}:${span.spanContext().spanId}`)
					.sort();
			// The retry must reuse the original trace and span ids so the
			// server can deduplicate an ambiguous first delivery.
			expect(identity(1)).toEqual(identity(0));
			expect(
				JSON.stringify(mocks.exportedSpans[1]),
			).toContain("retry prompt");

			const sendsAfterRecovery = mocks.OTLPTraceExporter.mock.calls.length;
			await flushClient();
			expect(mocks.OTLPTraceExporter.mock.calls.length).toBe(sendsAfterRecovery);
		} finally {
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("discards replay traces with an explicit diagnostic once the retry budget is spent", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			mocks.setExportResult({
				code: 1,
				error: new Error("HTTP 503 unavailable"),
			});
			const lf = await getRuntime(config);
			const trace = lf.trace({
				id: "b".repeat(32),
				name: "pi-agent",
				input: "budget prompt",
			});
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "done" });

			await flushClient();
			await flushClient();
			await flushClient();
			const sendsAfterBudget = mocks.OTLPTraceExporter.mock.calls.length;
			expect(sendsAfterBudget).toBe(3);
			const discardWarning = warn.mock.calls.find(([message]) =>
				String(message).includes("discarded"),
			);
			expect(discardWarning).toBeDefined();
			expect(String(discardWarning?.[0])).toContain(trace.id);
			expect(String(discardWarning?.[0])).toContain("3 failed");

			await flushClient();
			expect(mocks.OTLPTraceExporter.mock.calls.length).toBe(sendsAfterBudget);
		} finally {
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("drops single replay spans that exceed the ingestion byte limit", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			const fallbackConfig = {
				...config,
				payloadMaxStringChars: Infinity,
				payloadMaxToolChars: Infinity,
				payloadMaxDepth: Infinity,
				payloadMaxArrayItems: Infinity,
				payloadMaxObjectKeys: Infinity,
				payloadMaxNodes: Infinity,
			};
			const lf = await getRuntime(fallbackConfig);
			const oversizedTrace = lf.trace({
				id: "9".repeat(32),
				name: "pi-agent",
				// "x " pairs survive redaction (plain text, not base64-shaped).
				input: "x ".repeat(1_800_000),
			});
			const oversizedPrompt = lf.span({
				name: "agent.prompt",
				traceId: oversizedTrace.id,
			});
			oversizedPrompt.end({ output: "done" });
			const healthyTrace = lf.trace({
				id: "8".repeat(32),
				name: "pi-agent",
				input: "healthy prompt",
			});
			const healthyPrompt = lf.span({
				name: "agent.prompt",
				traceId: healthyTrace.id,
			});
			healthyPrompt.end({ output: "healthy answer" });

			await flushClient();

			expect(mocks.exportedSpans.length).toBeGreaterThan(0);
			const sent = JSON.stringify(mocks.exportedSpans);
			expect(sent).not.toContain("x".repeat(1_000));
			expect(sent).toContain("healthy prompt");
			expect(sent).toContain("healthy answer");
			expect(getLastRuntimeError()?.message).toContain("oversized");
			const fallbackWarning = warn.mock.calls.find(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(String(fallbackWarning?.[0])).toContain("oversized");
		} finally {
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("reports one diagnostic when multiple replay chunks time out", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const payload = "x ".repeat(800_000);
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			mocks.setExportResult("hang");
			const fallbackConfig = {
				...config,
				payloadMaxStringChars: Infinity,
				payloadMaxToolChars: Infinity,
				payloadMaxDepth: Infinity,
				payloadMaxArrayItems: Infinity,
				payloadMaxObjectKeys: Infinity,
				payloadMaxNodes: Infinity,
			};
			const lf = await getRuntime(fallbackConfig);
			for (const id of ["e".repeat(32), "f".repeat(32)]) {
				const trace = lf.trace({ id, name: "pi-agent", input: payload });
				const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
				prompt.end({ output: "done" });
			}

			await flushClient();

			expect(mocks.exportedSpans.length).toBe(0);
			const fallbackWarnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(fallbackWarnings).toHaveLength(1);
			expect(fallbackWarnings[0]).toHaveLength(1);
			expect(String(fallbackWarnings[0]?.[0])).not.toContain("\n");
			expect(getLastRuntimeError()?.message).toContain(
				"REST fallback ingestion",
			);
		} finally {
			mocks.setExportResult({ code: 0 });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("preserves bounded replay failure details", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			mocks.setExportResult({
				code: 1,
				error: new Error(
					'HTTP 400 {"message": "invalid observation", "id": "event-1"}',
				),
			});
			const lf = await getRuntime(config);
			const trace = lf.trace({ name: "pi-agent", input: "prompt" });
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "done" });

			await flushClient();

			const fallbackWarning = warn.mock.calls.find(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(fallbackWarning).toHaveLength(1);
			expect(String(fallbackWarning?.[0])).toContain("invalid observation");
			expect(getLastRuntimeError()?.message).toContain("invalid observation");
		} finally {
			mocks.setExportResult({ code: 0 });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("bounds multiline replay failures to one warning line", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			mocks.setExportResult({
				code: 1,
				error: new Error(
					`HTTP 413\n{\n  "message": "payload too large"\n}\n${"body ".repeat(300)}`,
				),
			});
			const lf = await getRuntime(config);
			const trace = lf.trace({ name: "pi-agent", input: "prompt" });
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "done" });

			await flushClient();

			const fallbackWarning = warn.mock.calls.find(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(fallbackWarning).toHaveLength(1);
			const warningText = String(fallbackWarning?.[0]);
			expect(warningText).toContain("HTTP 413");
			expect(warningText).not.toContain("\n");
			expect(warningText.length).toBeLessThan(700);
		} finally {
			mocks.setExportResult({ code: 0 });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("still reports one diagnostic when a replay rejects without an Error", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			mocks.setExportResult({ code: 1 });
			const lf = await getRuntime(config);
			const trace = lf.trace({ name: "pi-agent", input: "prompt" });
			const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
			prompt.end({ output: "done" });

			await flushClient();

			const fallbackWarning = warn.mock.calls.find(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(fallbackWarning).toHaveLength(1);
			expect(String(fallbackWarning?.[0])).not.toContain("\n");
			expect(getLastRuntimeError()?.message).toContain(
				"REST fallback ingestion",
			);
		} finally {
			mocks.setExportResult({ code: 0 });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("caps the joined reasons when every replay chunk fails differently", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const payload = "x ".repeat(800_000);
			mocks.observationsGetMany
				.mockReset()
				.mockResolvedValue({ data: [], meta: {} });
			let call = 0;
			const OTLPTraceExporter = mocks.OTLPTraceExporter as unknown as {
				mockImplementation: (impl: () => unknown) => void;
			};
			OTLPTraceExporter.mockImplementation(() => ({
				export: vi.fn(
					(
						_spans: Array<Record<string, unknown>>,
						callback: (result: { code: number; error?: Error }) => void,
					) => {
						call += 1;
						callback({
							code: 1,
							error: new Error(`distinct failure ${call}`),
						});
					},
				),
			}));
			const fallbackConfig = {
				...config,
				payloadMaxStringChars: Infinity,
				payloadMaxToolChars: Infinity,
				payloadMaxDepth: Infinity,
				payloadMaxArrayItems: Infinity,
				payloadMaxObjectKeys: Infinity,
				payloadMaxNodes: Infinity,
			};
			const lf = await getRuntime(fallbackConfig);
			for (const id of ["1", "2", "3", "4"].map((n) => n.repeat(32))) {
				const trace = lf.trace({ id, name: "pi-agent", input: payload });
				const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
				prompt.end({ output: "done" });
			}

			await flushClient();

			const fallbackWarnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(fallbackWarnings).toHaveLength(1);
			const warningText = String(fallbackWarnings[0]?.[0]);
			expect(warningText).toContain("more)");
			expect(warningText).not.toContain("\n");
			expect(warningText.length).toBeLessThan(1_800);
		} finally {
			warn.mockRestore();
			restoreTimeouts();
		}
	});
});
