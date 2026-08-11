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

	const traceGet = vi.fn(async () => ({ id: "visible-trace" }));
	const ingestionBatch = vi.fn(
		async (): Promise<{ successes: unknown[]; errors: unknown[] }> => ({
			successes: [],
			errors: [],
		}),
	);
	const client = {
		api: {
			trace: { get: traceGet },
			ingestion: { batch: ingestionBatch },
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
		traceGet,
		ingestionBatch,
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

	it("defers replacement until the active runtime releases its observations", async () => {
		const first = await getRuntime(config);
		const trace = first.trace({ name: "pi-agent" });
		const prompt = first.span({ name: "agent.prompt", traceId: trace.id });
		const deferred = await getRuntime({ ...config, host: "http://deferred" });
		expect(deferred).toBeDefined();
		expect(mocks.LangfuseClient).toHaveBeenCalledTimes(1);
		prompt.end({ output: "done" });
		await getRuntime({ ...config, host: "http://deferred" });
		expect(mocks.LangfuseClient).toHaveBeenCalledTimes(2);
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
				mocks.traceGet.mockReset().mockResolvedValue({ id: "visible-trace" });
				mocks.ingestionBatch
					.mockReset()
					.mockResolvedValue({ successes: [], errors: [] });
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

	it("falls back once with redacted trace and observation facts", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		try {
			const secret = "sk-lf-test-secret-1234567890";
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			mocks.ingestionBatch
				.mockReset()
				.mockResolvedValue({ successes: [], errors: [] });
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
			await shutdownClient();
			await shutdownClient();

			expect(mocks.ingestionBatch).toHaveBeenCalledTimes(1);
			const requestValue = (
				mocks.ingestionBatch.mock.calls as unknown as Array<[unknown]>
			)[0]?.[0];
			if (!requestValue) throw new Error("fallback request was not captured");
			const request = requestValue as {
				batch: Array<{
					type: string;
					timestamp: string;
					body: Record<string, unknown>;
				}>;
			};
			const traceEvent = request.batch.find(
				(event) => event.type === "trace-create",
			);
			const generationEvent = request.batch.find(
				(event) => event.type === "generation-create",
			);
			const toolEvent = request.batch.find(
				(event) => event.type === "span-create" && event.body.id === tool.id,
			);
			const turnEvent = request.batch.find(
				(event) => event.type === "span-create" && event.body.id === turn.id,
			);
			const promptEvent = request.batch.find(
				(event) => event.type === "span-create" && event.body.id === prompt.id,
			);
			if (
				!traceEvent ||
				!promptEvent ||
				!turnEvent ||
				!generationEvent ||
				!toolEvent
			) {
				throw new Error("fallback batch is missing a trace observation");
			}
			expect(traceEvent.body).toMatchObject({
				id: trace.id,
				name: "pi-agent",
				output: "final answer",
				sessionId: "fallback-session",
			});
			expect(String(traceEvent.body.input)).toContain("[REDACTED:");
			expect(promptEvent.body.traceId).toBe(trace.id);
			expect(promptEvent.body.parentObservationId).toBeUndefined();
			expect(turnEvent.body.parentObservationId).toBe(prompt.id);
			expect(generationEvent.body).toMatchObject({
				traceId: trace.id,
				parentObservationId: turn.id,
				model: "fallback-model",
				usageDetails: { input: 4, output: 6, total: 10 },
				costDetails: { total: 0.1 },
			});
			expect(toolEvent.body).toMatchObject({
				traceId: trace.id,
				parentObservationId: turn.id,
				level: "ERROR",
				statusMessage: "tool failed",
			});
			for (const event of request.batch) {
				expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				if (event.type !== "trace-create") {
					expect(event.body.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
					expect(event.body.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				}
			}
			expect(JSON.stringify(request)).not.toContain(secret);
		} finally {
			restoreTimeouts();
		}
	});

	it("chunks oversized fallback batches and retires drained traces", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		try {
			const payload = "x ".repeat(1_100_000);
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			mocks.ingestionBatch
				.mockReset()
				.mockResolvedValue({ successes: [], errors: [] });
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
			for (const id of ["c".repeat(32), "d".repeat(32)]) {
				const trace = lf.trace({ id, name: "pi-agent", input: payload });
				const prompt = lf.span({ name: "agent.prompt", traceId: trace.id });
				prompt.end({ output: "done" });
			}

			await flushClient();
			const calls = mocks.ingestionBatch.mock.calls as unknown as Array<
				[unknown]
			>;

			expect(calls.length).toBeGreaterThan(1);
			for (const [request] of calls) {
				expect(
					Buffer.byteLength(JSON.stringify(request), "utf8"),
				).toBeLessThanOrEqual(3_500_000);
			}
			await shutdownClient();
			expect(mocks.ingestionBatch).toHaveBeenCalledTimes(calls.length);
		} finally {
			restoreTimeouts();
		}
	});

	it("reports one diagnostic when multiple fallback batches time out", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const payload = "x ".repeat(1_100_000);
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			mocks.ingestionBatch
				.mockReset()
				.mockImplementation(() => new Promise<never>(() => {}));
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

			expect(mocks.ingestionBatch.mock.calls.length).toBeGreaterThan(1);
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
			mocks.ingestionBatch.mockResolvedValue({ successes: [], errors: [] });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("preserves bounded REST ingestion error details", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			mocks.ingestionBatch.mockReset().mockResolvedValue({
				successes: [],
				errors: [
					{
						id: "event-1",
						status: 400,
						message: "invalid observation",
					},
				],
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
			expect(String(fallbackWarning?.[0])).toContain("event-1");
			expect(String(fallbackWarning?.[0])).toContain("invalid observation");
			expect(getLastRuntimeError()?.message).toContain("invalid observation");
		} finally {
			mocks.ingestionBatch.mockResolvedValue({ successes: [], errors: [] });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("bounds multiline REST request failures to one warning line", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			mocks.ingestionBatch
				.mockReset()
				.mockRejectedValue(
					new Error(
						`HTTP 413\n{\n  "message": "payload too large"\n}\n${"body ".repeat(300)}`,
					),
				);
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
			mocks.ingestionBatch.mockResolvedValue({ successes: [], errors: [] });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("still reports one diagnostic when a batch rejects without an Error", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			mocks.ingestionBatch.mockReset().mockRejectedValue(undefined);
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
			mocks.ingestionBatch.mockResolvedValue({ successes: [], errors: [] });
			warn.mockRestore();
			restoreTimeouts();
		}
	});

	it("caps the joined reasons when every batch fails differently", async () => {
		const restoreTimeouts = setRuntimeTimeoutsForTest({
			shutdownStepMs: 20,
			traceVisibilityMs: 10,
			pollIntervalMs: 1,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const payload = "x ".repeat(1_000_000);
			mocks.traceGet.mockReset().mockRejectedValue(new Error("not visible"));
			let call = 0;
			mocks.ingestionBatch.mockReset().mockImplementation(async () => {
				call += 1;
				return {
					successes: [],
					errors: [
						{
							id: `event-${call}`,
							status: 400,
							message: `distinct failure ${call}`,
						},
					],
				};
			});
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

			expect(mocks.ingestionBatch.mock.calls.length).toBeGreaterThan(3);
			const fallbackWarnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("REST fallback ingestion"),
			);
			expect(fallbackWarnings).toHaveLength(1);
			const warningText = String(fallbackWarnings[0]?.[0]);
			expect(warningText).toContain("more)");
			expect(warningText).not.toContain("\n");
			expect(warningText.length).toBeLessThan(1_800);
		} finally {
			mocks.ingestionBatch.mockReset().mockResolvedValue({
				successes: [],
				errors: [],
			});
			warn.mockRestore();
			restoreTimeouts();
		}
	});
});
