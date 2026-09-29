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

	const scoresCreate = vi.fn(
		async (
			_body: Record<string, unknown>,
			_options?: unknown,
		): Promise<{ id: string }> => ({ id: "created-score" }),
	);
	const client = {
		api: {
			scores: { create: scoresCreate },
		},
		score: {
			create: vi.fn(),
			flush: vi.fn(async () => undefined),
			shutdown: vi.fn(async () => undefined),
		},
		flush: vi.fn(async () => undefined),
		shutdown: vi.fn(async () => undefined),
	};
	const LangfuseClient = vi.fn(() => client);
	const LangfuseSpanProcessor = vi.fn((_params?: Record<string, unknown>) => ({
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
		scoresCreate,
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
}));
vi.mock("@opentelemetry/context-async-hooks", () => ({
	AsyncHooksContextManager: mocks.AsyncHooksContextManager,
}));
vi.mock("@opentelemetry/sdk-trace-base", () => ({
	BasicTracerProvider: mocks.BasicTracerProvider,
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
		mocks.tracerProviders.length = 0;
	});

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
		const first = await getRuntime(config);
		const trace = first.trace({ name: "pi-agent" });
		const prompt = first.span({ name: "agent.prompt", traceId: trace.id });
		await expect(
			getRuntime({ ...config, host: "http://deferred" }),
		).rejects.toThrow(/different configuration/);
		expect(mocks.LangfuseClient).toHaveBeenCalledTimes(1);
		expect(getLastRuntimeError()?.message).toContain("different configuration");
		// The conflicting request must not send telemetry through the old
		// runtime: only the active prompt's own records exist.
		expect(mocks.records).toHaveLength(1);

		prompt.end({ output: "done" });
		await getRuntime({ ...config, host: "http://deferred" });
		expect(mocks.LangfuseClient).toHaveBeenCalledTimes(2);
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

	it("sends scores through the supported scores endpoint with environment", async () => {
		const lf = await getRuntime({ ...config, environment: "staging" });
		lf.score({ name: "tool_success_rate", value: 1, traceId: "trace-1" });
		expect(mocks.scoresCreate).toHaveBeenCalledTimes(1);
		expect(mocks.scoresCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				environment: "staging",
				name: "tool_success_rate",
				value: 1,
				traceId: "trace-1",
			}),
			expect.objectContaining({ maxRetries: 0 }),
		);

		const unset = await getRuntime(config);
		unset.score({ name: "tool_success_rate", value: 1, traceId: "trace-2" });
		const lastScore = (mocks.scoresCreate.mock.calls.at(-1)?.[0] ??
			{}) as Record<string, unknown>;
		expect(lastScore.environment).toBeUndefined();

		// The SDK's LANGFUSE_TRACING_ENVIRONMENT fallback must survive the
		// direct endpoint switch, with configuration winning when both exist.
		const previousEnv = process.env.LANGFUSE_TRACING_ENVIRONMENT;
		process.env.LANGFUSE_TRACING_ENVIRONMENT = "env-var-env";
		try {
			const envOnly = await getRuntime(config);
			envOnly.score({ name: "s", value: 1, traceId: "trace-4" });
			const envOnlyScore = (mocks.scoresCreate.mock.calls.at(-1)?.[0] ??
				{}) as Record<string, unknown>;
			expect(envOnlyScore.environment).toBe("env-var-env");

			const both = await getRuntime({
				...config,
				environment: "config-env",
			});
			both.score({ name: "s", value: 1, traceId: "trace-5" });
			const bothScore = (mocks.scoresCreate.mock.calls.at(-1)?.[0] ??
				{}) as Record<string, unknown>;
			expect(bothScore.environment).toBe("config-env");
		} finally {
			if (previousEnv === undefined) {
				delete process.env.LANGFUSE_TRACING_ENVIRONMENT;
			} else {
				process.env.LANGFUSE_TRACING_ENVIRONMENT = previousEnv;
			}
		}

		// Delivery failures are explicit diagnostics, never silent drops, and
		// never raw console output.
		mocks.scoresCreate.mockRejectedValueOnce(
			Object.assign(new Error("HTTP 401 denied"), { statusCode: 401 }),
		);
		lf.score({ name: "failing_score", value: 0, traceId: "trace-3" });
		await flushClient();
		expect(getLastRuntimeError()?.message).toContain("401");
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
		// The published flag must reach the normal OTel path and must never
		// attempt to reverse a publication.
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
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 20 });
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
		const restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 20 });
		try {
			for (const dependency of [
				"otel flush",
				"score flush",
				"client shutdown",
				"tracer shutdown",
			]) {
				mocks.client.shutdown.mockReset().mockResolvedValue(undefined);
				mocks.scoresCreate.mockReset().mockResolvedValue({ id: "score" });
				const lf = await getRuntime(config);
				const trace = lf.trace({ name: "pi-agent" });
				const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
				prompt.end({ output: "done" });
				if (dependency === "score flush") {
					// Hang the delivery before issuing so the in-flight promise is
					// genuinely pending when the bounded step awaits it.
					mocks.scoresCreate.mockImplementation(
						() => new Promise<never>(() => {}),
					);
					lf.score({ name: "hanging_score", value: 1, traceId: trace.id });
				}
				const provider =
					mocks.tracerProviders[mocks.tracerProviders.length - 1];
				if (!provider) throw new Error("tracer provider was not created");
				if (dependency === "otel flush") {
					provider.forceFlush.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				} else if (dependency === "client shutdown") {
					mocks.client.shutdown.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				} else if (dependency === "tracer shutdown") {
					provider.shutdown.mockImplementation(
						() => new Promise<never>(() => {}),
					);
				}
				const startedAt = Date.now();
				await shutdownClient();
				expect(Date.now() - startedAt).toBeLessThan(180);
				expect(mocks.client.shutdown).toHaveBeenCalledTimes(1);
				expect(provider.forceFlush).toHaveBeenCalledTimes(1);
				expect(provider.shutdown).toHaveBeenCalledTimes(1);
			}
		} finally {
			restoreTimeouts();
		}
	});
});
