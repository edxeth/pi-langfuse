import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
	getRuntime,
	getRuntimeRegistrySizeForTest,
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

	const client = {
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
	const BasicTracerProvider = vi.fn(() => ({
		forceFlush: vi.fn(async () => undefined),
		shutdown: vi.fn(async () => undefined),
	}));
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
		vi.clearAllMocks();
		mocks.records.length = 0;
		await shutdownClient();
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
			expect(output).toContain('data: d:{"credits_used":0.0046');
		}
		expect(serialized).toContain("data\\\\: 0:");
		expect(serialized).toContain("data: d:");
		expect(serialized).toContain("credits_used");
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
});
