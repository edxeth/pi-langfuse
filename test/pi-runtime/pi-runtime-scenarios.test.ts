import type {
	ExtensionAPI,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeTimeoutsForTest } from "../../src/langfuse-client.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	captureSessionEvents,
	createRuntimeCase,
	type PiAiModule,
	type RuntimeCase,
	readRawTraceRecords,
	readSessionEntries,
} from "./isolated-pi.js";
import {
	type DecodedSpan,
	decodeOtlpPayload,
	latestSpanPerId,
	spansByName,
} from "./otlp.js";
import {
	type PiMessagesServer,
	startPiMessagesServer,
	textAnswerEvents,
	usageOf,
} from "./provider-server.js";

/**
 * Permanent offline regressions for the strongest real-Pi scenarios, promoted
 * from the integration validation round (baseline 20b7ac4).
 *
 * Every test drives a genuine Pi SDK session through the real pi-langfuse
 * extension with a deterministic local provider and a local Langfuse
 * recorder. They cover: provider retry settlement, unannounced deferred
 * runs, compaction usage accounting, once-only tool usage, capture-policy
 * opt-outs, and the unchanged outgoing provider payload. Transport-fault
 * recovery lives in recovery.test.ts; stored-backend checks belong to the
 * separate backend suite.
 *
 * Everything stays on 127.0.0.1 with synthetic credentials and temp
 * directories; no live providers, no persistent Langfuse, no user resources.
 */

const SECRET_KEY = "sk-local-runtime-test-secret";
const UNLIMITED_PAYLOAD = {
	"payload-max-string-chars": "unlimited",
	"payload-max-tool-chars": "unlimited",
	"payload-max-depth": "unlimited",
	"payload-max-array-items": "unlimited",
	"payload-max-object-keys": "unlimited",
	"payload-max-nodes": "unlimited",
} as const;

let activeCase: RuntimeCase | undefined;
let restoreTimeouts: (() => void) | undefined;
const activeProviderServers: PiMessagesServer[] = [];

afterEach(async () => {
	restoreTimeouts?.();
	restoreTimeouts = undefined;
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
	for (const server of activeProviderServers.splice(0)) {
		await server.close();
	}
});

/** Common fault-free runtime tuning: bounded shutdown and flush steps. */
function useBoundedTimeouts() {
	restoreTimeouts = setRuntimeTimeoutsForTest({ shutdownStepMs: 1_000 });
}

function decodedAcceptedSpans(
	recorder: RuntimeCase["recorder"],
): DecodedSpan[] {
	return recorder
		.acceptedPosts()
		.flatMap((record) => decodeOtlpPayload(record.body));
}

function traceMeta(span: DecodedSpan, key: string): unknown {
	return span.attrs[`langfuse.trace.metadata.${key}`];
}

function observationMeta(span: DecodedSpan, key: string): unknown {
	return span.attrs[`langfuse.observation.metadata.${key}`];
}

/**
 * Root-prompt metadata as the server sees it. Scalar values propagate to both
 * trace and observation attributes; object values (recoveredFailure) survive
 * only in the observation metadata block.
 */
function rootMeta(span: DecodedSpan, key: string): unknown {
	return traceMeta(span, key) ?? observationMeta(span, key);
}

function requireSpan(span: DecodedSpan | undefined, name: string): DecodedSpan {
	if (!span) throw new Error(`expected a ${name} span in the accepted export`);
	return span;
}

/** Poll a condition with a deadline so async deferred work stays bounded. */
async function waitForCondition(
	what: string,
	condition: () => boolean,
	deadlineMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("pi runtime scenarios (real Pi SDK sessions)", () => {
	it("discovers no global resources in the isolated runtime", async () => {
		useBoundedTimeouts();
		const runtimeCase = await createRuntimeCase({
			name: "discovery-isolation",
			provider: { kind: "faux" },
		});
		activeCase = runtimeCase;
		expect(runtimeCase.discovery).toEqual({
			skills: 0,
			prompts: 0,
			themes: 0,
			agentsFiles: 0,
			extensions: 1,
			extensionErrors: 0,
		});
		expect(runtimeCase.faux).toBeDefined();
	});

	it("settles a provider retry on one trace, counts tool usage once, and leaves the provider payload untouched", async () => {
		useBoundedTimeouts();
		const userPrompt = "PR-RETRY user prompt";
		const assistText = "calling the probe tool";
		const finalText = "PR-RETRY final answer after recovery";
		const argToken = "PR-ARGS-CANARY-token";
		const toolOut = "PR-TOOLOUT-CANARY result";
		const modelUsage = usageOf(42, 7, 0);
		const toolUsage = usageOf(600, 60, 0.66);

		const provider = await startPiMessagesServer((call) => {
			if (call === 1) return { status: 503 };
			if (call === 2) {
				return {
					events: [
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_end", contentIndex: 0, content: assistText },
						{
							type: "toolcall_start",
							contentIndex: 1,
							id: "call-pr-1",
							toolName: "probe_echo",
						},
						{
							type: "toolcall_delta",
							contentIndex: 1,
							delta: `{"q":"${argToken.slice(0, 8)}"`,
						},
						{
							type: "toolcall_delta",
							contentIndex: 1,
							delta: `${argToken.slice(8)}"}`,
						},
						{
							type: "toolcall_end",
							contentIndex: 1,
							toolCall: {
								type: "toolCall",
								id: "call-pr-1",
								name: "probe_echo",
								arguments: { q: argToken },
							},
						},
						{ type: "done", reason: "toolCall", usage: modelUsage },
					],
				};
			}
			return { events: textAnswerEvents(finalText, modelUsage) };
		});
		activeProviderServers.push(provider);

		const runtimeCase = await createRuntimeCase({
			name: "retry-settlement",
			provider: { kind: "pi-messages", baseUrl: provider.url },
			settings: {
				"capture-policy": "conversations",
				...UNLIMITED_PAYLOAD,
			},
			env: {
				PI_LANGFUSE_RAW_PROVIDER_REQUEST: "full",
				PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD: "1",
			},
			customToolsFactory: (piAi: PiAiModule) => [
				{
					name: "probe_echo",
					label: "Probe Echo",
					description: "Returns fixed synthetic text and reports usage.",
					parameters: piAi.Type.Object({ q: piAi.Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: toolOut }],
						details: { name: "probe_echo" },
						usage: toolUsage,
					}),
				},
			],
		});
		activeCase = runtimeCase;

		const events = captureSessionEvents(runtimeCase.session);
		await runtimeCase.session.prompt(userPrompt);
		await runtimeCase.session.waitForIdle();
		runtimeCase.session.dispose();
		drainRawTraceQueue();

		// --- wire: the retry really happened and bodies stayed pristine ---
		expect(provider.requests).toHaveLength(3);
		const wireBodies = provider.requests.map((request) =>
			JSON.stringify(request.body),
		);
		for (const body of wireBodies) {
			expect(body).toContain(userPrompt);
			expect(body).not.toContain("[REDACTED:");
		}
		expect(wireBodies[2]).toContain(argToken);
		expect(wireBodies[2]).toContain(toolOut);

		// --- settlement contract on the public event stream ---
		const settled = events.filter((event) => event.type === "agent_settled");
		const agentEnds = events.filter((event) => event.type === "agent_end");
		expect(settled).toHaveLength(1);
		const settledIndex = events.findIndex(
			(event) => event.type === "agent_settled",
		);
		const lastEndIndex = events
			.map((event) => event.type)
			.lastIndexOf("agent_end");
		expect(settledIndex).toBeGreaterThan(lastEndIndex);
		expect(
			events.some(
				(event) => event.type === "message_end" && event.stopReason === "error",
			) || agentEnds.some((event) => event.willRetry === true),
		).toBe(true);

		// --- shaped telemetry: single trace, recovery recorded, usage once ---
		const spans = latestSpanPerId(decodedAcceptedSpans(runtimeCase.recorder));
		const byName = spansByName(spans);
		const traceIds = new Set(spans.map((span) => span.traceId));
		expect(traceIds.size).toBe(1);
		const root = requireSpan(byName["agent.prompt"]?.[0], "agent.prompt");
		expect(String(rootMeta(root, "recoveredFailure"))).toContain("503");
		expect(Number(traceMeta(root, "recoveredFailureCount"))).toBe(1);
		expect(traceMeta(root, "promptSource")).toBeUndefined();
		expect(Number(traceMeta(root, "indirectTokensIn"))).toBe(600);
		expect(Number(traceMeta(root, "indirectTokensOut"))).toBe(60);
		expect(
			Math.abs(Number(traceMeta(root, "indirectCost")) - 0.66),
		).toBeLessThan(1e-9);
		expect(Number(traceMeta(root, "tokensIn"))).toBe(84);
		expect(Number(traceMeta(root, "tokensOut"))).toBe(14);

		const toolSpans = byName["tool:probe_echo"] ?? [];
		expect(toolSpans).toHaveLength(1);
		expect(
			toolSpans[0]?.attrs["langfuse.observation.usage_details"],
		).toBeDefined();
		const turnIndexes = (byName["agent.turn"] ?? [])
			.map((turn) => Number(observationMeta(turn, "turnIndex")))
			.sort((left, right) => left - right);
		expect(turnIndexes).toEqual([0, 0, 1]);

		// --- raw provider_request records: provenance + policy ---
		const raw = readRawTraceRecords(runtimeCase.rawTraceDir);
		const providerRequests = raw.filter(
			(record) => record.type === "provider_request",
		);
		expect(providerRequests).toHaveLength(3);
		for (const record of providerRequests) {
			expect(record.captureMode).toBe("full");
			expect(record.requestSource).toBe("payload.context");
		}
		const third = JSON.stringify(providerRequests[2]);
		expect(third).toContain("call-pr-1");
		expect(third).toContain("probe_echo");
		expect(third).not.toContain(argToken);
		expect(third).not.toContain(toolOut);
		expect(third).toContain(userPrompt);
		for (const record of providerRequests) {
			const summary = String(record.payloadSummary);
			expect(summary).not.toContain(argToken);
			expect(summary).not.toContain(toolOut);
		}

		// --- generations: failed attempt honest, success carries usage ---
		const generations = byName["llm-response"] ?? [];
		expect(generations).toHaveLength(3);
		const turns = byName["agent.turn"] ?? [];
		for (const generation of generations) {
			expect(observationMeta(generation, "requestSource")).toBe(
				"payload.context",
			);
			expect(
				turns.some((turn) => turn.spanId === generation.parentSpanId),
			).toBe(true);
		}
		expect(generations[0]?.attrs["langfuse.observation.level"]).toBe("ERROR");
		expect(
			generations[0]?.attrs["langfuse.observation.usage_details"],
		).toBeUndefined();
		const finalInput = JSON.stringify(
			generations[2]?.attrs["langfuse.observation.input"],
		);
		expect(finalInput).toContain(assistText);
		expect(finalInput).not.toContain(toolOut);
		expect(finalInput).toContain("toolResult");
		for (const input of generations.map((generation) =>
			JSON.stringify(generation.attrs["langfuse.observation.input"]),
		)) {
			expect(input).not.toContain(argToken);
		}
		for (const generation of generations.slice(1)) {
			expect(
				JSON.stringify(generation.attrs["langfuse.observation.usage_details"]),
			).toContain("42");
		}

		// --- credentials never leave the process boundaries ---
		expect(JSON.stringify(runtimeCase.recorder.records)).not.toContain(
			SECRET_KEY,
		);
	});

	it("tracks an unannounced deferred run as its own provenance-marked trace without fabricated input", async () => {
		useBoundedTimeouts();
		const firstPrompt = "PR-DEFERRED first user prompt";
		const deferredText = "PR-DEFERRED canary message";
		const firstAnswer = "PR-DEFERRED first answer";
		const deferredAnswer = "PR-DEFERRED deferred answer";
		const modelUsage = usageOf(42, 7, 0);

		const provider = await startPiMessagesServer((call) => ({
			events: textAnswerEvents(
				call === 1 ? firstAnswer : deferredAnswer,
				modelUsage,
			),
		}));
		activeProviderServers.push(provider);

		const deferredSender: InlineExtension = (pi: ExtensionAPI) => {
			let fired = false;
			pi.on("agent_settled", () => {
				if (fired) return;
				fired = true;
				pi.sendMessage(
					{
						customType: "probe",
						content: [{ type: "text", text: deferredText }],
						display: true,
						details: {},
					},
					{ triggerTurn: true },
				);
			});
		};

		const runtimeCase = await createRuntimeCase({
			name: "unannounced-deferred",
			provider: { kind: "pi-messages", baseUrl: provider.url },
			extensionFactories: [deferredSender],
			settings: {
				"capture-policy": "conversations",
				...UNLIMITED_PAYLOAD,
			},
			env: {
				PI_LANGFUSE_RAW_PROVIDER_REQUEST: "full",
				PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD: "1",
			},
		});
		activeCase = runtimeCase;

		const events = captureSessionEvents(runtimeCase.session);
		await runtimeCase.session.prompt(firstPrompt);
		await waitForCondition(
			"the deferred run to reach the provider",
			() => provider.requests.length >= 2,
		);
		await runtimeCase.session.waitForIdle();
		runtimeCase.session.dispose();
		drainRawTraceQueue();

		// --- wire: the deferred run reached the provider, unmutated ---
		expect(provider.requests).toHaveLength(2);
		const secondBody = JSON.stringify(provider.requests[1]?.body);
		expect(secondBody).toContain(deferredText);
		for (const request of provider.requests) {
			expect(JSON.stringify(request.body)).not.toContain("[REDACTED:");
		}

		// --- traces: two, partitioned, provenance marked ---
		const spans = latestSpanPerId(decodedAcceptedSpans(runtimeCase.recorder));
		const byName = spansByName(spans);
		const roots = byName["agent.prompt"] ?? [];
		expect(roots).toHaveLength(2);
		expect(new Set(roots.map((root) => root.traceId)).size).toBe(2);
		const deferred =
			roots.find((root) => traceMeta(root, "promptSource") !== undefined) ??
			roots[0];
		const normal = roots.find((root) => root !== deferred) ?? roots[1];
		expect(
			traceMeta(requireSpan(deferred, "deferred root"), "promptSource"),
		).toBe("unannounced-agent-run");
		expect(
			traceMeta(requireSpan(normal, "normal root"), "promptSource"),
		).toBeUndefined();
		expect(deferred?.attrs["langfuse.observation.input"]).toBeUndefined();
		expect(deferred?.attrs["langfuse.trace.input"]).toBeUndefined();
		expect(
			JSON.stringify(normal?.attrs["langfuse.observation.input"]),
		).toContain(firstPrompt);

		// --- one settle per run; turns never cross traces ---
		expect(
			events.filter((event) => event.type === "agent_settled"),
		).toHaveLength(2);
		const turnsByTrace = new Map<string, DecodedSpan[]>();
		for (const turn of byName["agent.turn"] ?? []) {
			const list = turnsByTrace.get(turn.traceId) ?? [];
			list.push(turn);
			turnsByTrace.set(turn.traceId, list);
		}
		expect([...turnsByTrace.keys()].sort()).toEqual(
			[deferred?.traceId, normal?.traceId].sort(),
		);
		for (const turnList of turnsByTrace.values()) {
			expect(turnList).toHaveLength(1);
		}

		// --- deferred generation input derives from the observed request ---
		const generations = byName["llm-response"] ?? [];
		expect(generations).toHaveLength(2);
		const deferredGeneration =
			generations.find((generation) =>
				JSON.stringify(
					generation.attrs["langfuse.observation.output"],
				)?.includes(deferredAnswer),
			) ?? generations[1];
		expect(
			observationMeta(
				requireSpan(deferredGeneration, "deferred generation"),
				"requestSource",
			),
		).toBe("payload.context");
		expect(
			turnsByTrace
				.get(deferred?.traceId ?? "")
				?.some((turn) => turn.spanId === deferredGeneration?.parentSpanId),
		).toBe(true);
		expect(
			JSON.stringify(deferredGeneration?.attrs["langfuse.observation.input"]),
		).toContain(deferredText);
		expect(
			JSON.stringify(deferredGeneration?.attrs["langfuse.observation.input"]),
		).not.toContain("[REDACTED:");

		// --- raw provider_request records stay truthful on both runs ---
		const raw = readRawTraceRecords(runtimeCase.rawTraceDir);
		const providerRequests = raw.filter(
			(record) => record.type === "provider_request",
		);
		expect(providerRequests).toHaveLength(2);
		for (const record of providerRequests) {
			expect(record.captureMode).toBe("full");
			expect(record.requestSource).toBe("payload.context");
		}
		expect(JSON.stringify(providerRequests[0])).toContain(firstPrompt);
		expect(JSON.stringify(providerRequests[1])).toContain(deferredText);

		expect(JSON.stringify(runtimeCase.recorder.records)).not.toContain(
			SECRET_KEY,
		);
	});

	it("credits compaction usage exactly once and records no phantom wire records for unrecognized payloads", async () => {
		useBoundedTimeouts();
		const pad = "context padding for compaction. ".repeat(400);

		const runtimeCase = await createRuntimeCase({
			name: "compaction-once",
			provider: { kind: "faux" },
			piSettings: { compaction: { enabled: true, keepRecentTokens: 200 } },
			env: {
				PI_LANGFUSE_RAW_PROVIDER_REQUEST: "full",
				PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD: "1",
			},
		});
		activeCase = runtimeCase;
		const piAi = runtimeCase.piAi;
		const faux = runtimeCase.faux;
		if (!faux) throw new Error("faux provider was not registered");

		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxText("prompt one done")]),
			piAi.fauxAssistantMessage([piAi.fauxText("prompt two done")]),
			piAi.fauxAssistantMessage([piAi.fauxText("idle compaction summary")]),
			piAi.fauxAssistantMessage([piAi.fauxText("prompt three done")]),
		]);

		await runtimeCase.session.prompt("prompt one");
		await runtimeCase.session.waitForIdle();
		await runtimeCase.session.prompt(`prompt two padded: ${pad}`);
		await runtimeCase.session.waitForIdle();
		await runtimeCase.session.compact("manual idle compaction");
		await runtimeCase.session.waitForIdle();
		await runtimeCase.session.prompt(`prompt three padded: ${pad}`);
		await runtimeCase.session.waitForIdle();

		// Overflow-recovery compaction happens inside the next prompt. Refresh
		// the scripted overflow timestamp so it postdates the idle compaction;
		// the split-turn recovery consumes TWO summarizer responses.
		faux.setResponses([
			{
				...piAi.fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: "maximum context length is 128000 tokens",
				}),
				timestamp: Date.now(),
			},
			piAi.fauxAssistantMessage([piAi.fauxText("recovery compaction summary")]),
			piAi.fauxAssistantMessage([
				piAi.fauxText("recovery turn prefix summary"),
			]),
			piAi.fauxAssistantMessage([piAi.fauxText("recovered after compaction")]),
		]);
		await runtimeCase.session.prompt(`prompt four padded: ${pad}`);
		await runtimeCase.session.waitForIdle();
		runtimeCase.session.dispose();
		drainRawTraceQueue();

		const spans = latestSpanPerId(decodedAcceptedSpans(runtimeCase.recorder));
		const byName = spansByName(spans);
		const roots = byName["agent.prompt"] ?? [];
		expect(roots).toHaveLength(4);

		const rootByOutput = (text: string) =>
			roots.find((root) => root.attrs["langfuse.observation.output"] === text);
		const rootFour = requireSpan(
			rootByOutput("recovered after compaction"),
			"prompt four trace",
		);
		const rootThree = requireSpan(
			rootByOutput("prompt three done"),
			"prompt three trace",
		);
		expect(Number(traceMeta(rootFour, "compactCount"))).toBe(2);
		expect(Number(traceMeta(rootThree, "compactCount"))).toBe(1);

		// Persisted compaction entries are the durable facts usage is derived from.
		const entries = readSessionEntries(runtimeCase.sessionDir);
		const compactionEntries = entries.filter(
			(entry) => entry.type === "compaction",
		);
		const usedCompactions = compactionEntries.filter(
			(entry) =>
				typeof (entry as { usage?: { input?: number } }).usage?.input ===
					"number" &&
				Number((entry as { usage: { input: number } }).usage.input) > 0,
		);
		expect(usedCompactions).toHaveLength(2);
		const idleUsage = (usedCompactions[0] as { usage: { input: number } })
			.usage;
		const overflowUsage = (usedCompactions[1] as { usage: { input: number } })
			.usage;

		const indirectIn = Number(traceMeta(rootFour, "indirectTokensIn"));
		expect(indirectIn).toBe(overflowUsage.input);
		expect(indirectIn).not.toBe(idleUsage.input + overflowUsage.input);
		for (const root of roots.slice(0, 3)) {
			expect(Number(traceMeta(root, "indirectTokensIn"))).toBe(0);
		}

		const fourTurns = (byName["agent.turn"] ?? []).filter(
			(turn) => turn.traceId === rootFour.traceId,
		);
		const fourTurnIndexes = fourTurns
			.map((turn) => Number(observationMeta(turn, "turnIndex")))
			.sort((left, right) => left - right);
		expect(fourTurnIndexes).toEqual([0, 0]);
		expect(new Set(fourTurns.map((turn) => turn.traceId)).size).toBe(1);
		expect(String(traceMeta(rootFour, "completed"))).toBe("true");
		expect(traceMeta(rootFour, "failed")).toBeUndefined();
		expect(String(rootMeta(rootFour, "recoveredFailure"))).toContain(
			"context length",
		);

		const raw = readRawTraceRecords(runtimeCase.rawTraceDir);
		expect(
			raw.filter((record) => record.type === "session_compact"),
		).toHaveLength(2);
		// Faux payloads are unrecognized by design: no phantom wire records.
		expect(
			raw.filter((record) => record.type === "provider_request"),
		).toHaveLength(0);
		const generations = byName["llm-response"] ?? [];
		expect(generations.length).toBeGreaterThan(0);
		for (const generation of generations) {
			expect(observationMeta(generation, "requestSource")).toBe("context");
		}

		expect(JSON.stringify(runtimeCase.recorder.records)).not.toContain(
			SECRET_KEY,
		);
	});

	it("keeps tool content out of telemetry under capture opt-outs while the wire stays complete", async () => {
		useBoundedTimeouts();
		const userPrompt = "PR-OPTOUT user prompt";
		const answerText = "PR-OPTOUT answer";
		const argToken = "PR-SECRET-ARG-token";
		const toolOut = "PR-SECRET-OUT result";

		const provider = await startPiMessagesServer((call) => {
			if (call === 1) {
				return {
					events: [
						{
							type: "toolcall_start",
							contentIndex: 0,
							id: "call-pr-opt-1",
							toolName: "probe_echo",
						},
						{
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: {
								type: "toolCall",
								id: "call-pr-opt-1",
								name: "probe_echo",
								arguments: { q: argToken },
							},
						},
						{ type: "done", reason: "toolCall", usage: usageOf(5, 2, 0) },
					],
				};
			}
			return { events: textAnswerEvents(answerText, usageOf(11, 5, 0)) };
		});
		activeProviderServers.push(provider);

		const runtimeCase = await createRuntimeCase({
			name: "capture-optout",
			provider: { kind: "pi-messages", baseUrl: provider.url },
			settings: {
				"capture-policy": "conversations",
				...UNLIMITED_PAYLOAD,
			},
			// PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD stays unset: capture off.
			env: { PI_LANGFUSE_RAW_PROVIDER_REQUEST: "full" },
			customToolsFactory: (piAi: PiAiModule) => [
				{
					name: "probe_echo",
					label: "Probe Echo",
					description: "Returns fixed synthetic text.",
					parameters: piAi.Type.Object({ q: piAi.Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: toolOut }],
						details: { name: "probe_echo" },
					}),
				},
			],
		});
		activeCase = runtimeCase;

		await runtimeCase.session.prompt(userPrompt);
		await runtimeCase.session.waitForIdle();
		runtimeCase.session.dispose();
		drainRawTraceQueue();

		// The wire keeps everything: arguments and the tool result text are
		// untouched across both provider calls (the continuation carries the
		// assistant toolCall arguments plus the tool result).
		expect(provider.requests).toHaveLength(2);
		const wireBodies = provider.requests.map((request) =>
			JSON.stringify(request.body),
		);
		const joinedWire = wireBodies.join("\n");
		expect(joinedWire).toContain(argToken);
		expect(joinedWire).toContain(toolOut);
		expect(joinedWire).not.toContain("[REDACTED:");

		// The provider-request raw records exist (full mode) but the payload
		// capture opt-out keeps their content and summary out.
		const raw = readRawTraceRecords(runtimeCase.rawTraceDir);
		const providerRequests = raw.filter(
			(record) => record.type === "provider_request",
		);
		expect(providerRequests).toHaveLength(2);
		for (const record of providerRequests) {
			expect(record.payloadCaptured).toBe(false);
			expect(record.payloadSummary).toBeUndefined();
		}

		// Telemetry drops tool input/output under the conversations policy while
		// prompt and assistant output stay captured.
		const rawText = JSON.stringify(raw);
		expect(rawText).not.toContain(argToken);
		expect(rawText).not.toContain(toolOut);
		expect(rawText).toContain(userPrompt);
		expect(rawText).toContain(answerText);

		const spans = latestSpanPerId(decodedAcceptedSpans(runtimeCase.recorder));
		const byName = spansByName(spans);
		const toolSpans = byName["tool:probe_echo"] ?? [];
		expect(toolSpans).toHaveLength(1);
		const sinkText = JSON.stringify(runtimeCase.recorder.records);
		expect(sinkText).not.toContain(argToken);
		expect(sinkText).not.toContain(toolOut);
		const root = requireSpan(byName["agent.prompt"]?.[0], "agent.prompt");
		expect(JSON.stringify(root.attrs["langfuse.observation.input"])).toContain(
			userPrompt,
		);
		expect(String(root.attrs["langfuse.observation.output"])).toContain(
			answerText,
		);
		const generations = byName["llm-response"] ?? [];
		expect(generations).toHaveLength(2);
		// Generation input still derives from the observed request even with the
		// payload capture flag off: the flag gates stored payload snapshots, not
		// request provenance.
		for (const generation of generations) {
			expect(observationMeta(generation, "requestSource")).toBe(
				"payload.context",
			);
		}

		expect(sinkText).not.toContain(SECRET_KEY);
	});
});
