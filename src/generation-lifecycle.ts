import type {
	BeforeProviderRequestEvent,
	ContextEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Config, canTrace } from "./config.js";
import type { getRuntime, LangfuseGeneration } from "./langfuse-client.js";
import {
	type GenerationState,
	getLifecycleFailure,
	type PiUsage,
	type PromptState,
	type TurnState,
} from "./lifecycle-types.js";
import type { redactionMetadata } from "./redaction.js";
import { isSensitiveKey } from "./redaction.js";
import type { SessionContextLike, SessionState } from "./session-state.js";
import type {
	costDetailsFromUsage,
	estimateJsonBytes,
	extractTextFromContent,
	safeJson,
	standardUsageFromUsage,
	summarizeMessages,
	summarizeProviderPayload,
	summarizeProviderRequestMessages,
	telemetryText,
	usageDetailsFromUsage,
	writeRawTrace,
} from "./telemetry-helpers.js";
import {
	captureProviderRequest,
	providerRequestIdentity,
	providerRequestProvenance,
	providerRequestTraceRecord,
	summarizeProviderRequestContents,
} from "./telemetry-helpers.js";

export interface GenerationLifecycleDependencies {
	getConfig: () => Config;
	getSessionState: (
		ctx: SessionContextLike | undefined,
	) => SessionState<PromptState> | undefined;
	canTrace: typeof canTrace;
	getRuntime: typeof getRuntime;
	telemetryText: typeof telemetryText;
	redactionMetadata: typeof redactionMetadata;
	extractTextFromContent: typeof extractTextFromContent;
	standardUsageFromUsage: typeof standardUsageFromUsage;
	usageDetailsFromUsage: typeof usageDetailsFromUsage;
	costDetailsFromUsage: typeof costDetailsFromUsage;
	summarizeMessages: typeof summarizeMessages;
	summarizeProviderPayload: typeof summarizeProviderPayload;
	summarizeProviderRequestMessages: typeof summarizeProviderRequestMessages;
	safeJson: typeof safeJson;
	estimateJsonBytes: typeof estimateJsonBytes;
	writeRawTrace: typeof writeRawTrace;
}

interface MessageStartEvent {
	message: unknown;
}

interface MessageUpdateEvent extends MessageStartEvent {
	assistantMessageEvent?: unknown;
}

interface MessageEndEvent extends MessageStartEvent {}

interface AfterProviderResponseEvent {
	status: number;
	headers: Record<string, string>;
}

export interface GenerationLifecycleHandlers {
	context: (event: ContextEvent, ctx: ExtensionContext) => Promise<void>;
	beforeProviderRequest: (
		event: BeforeProviderRequestEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	afterProviderResponse: (
		event: AfterProviderResponseEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	messageStart: (
		event: MessageStartEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	messageUpdate: (
		event: MessageUpdateEvent,
		ctx: ExtensionContext,
	) => Promise<void>;
	messageEnd: (event: MessageEndEvent, ctx: ExtensionContext) => Promise<void>;
	abandonTurn: (turn: TurnState) => Promise<void>;
}

type EventRecord = Record<string, unknown>;

function asRecord(value: unknown): EventRecord | undefined {
	return value && typeof value === "object"
		? (value as EventRecord)
		: undefined;
}

function eventRecord(event: unknown): EventRecord {
	return asRecord(event) ?? {};
}

function getNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getExplicitRequestKey(event: EventRecord): string | undefined {
	for (const key of ["requestKey", "requestId", "providerRequestId"]) {
		const value = getNonEmptyString(event[key]);
		if (value) return value;
	}
	return undefined;
}

function getTurnIndex(event: EventRecord): number | undefined {
	const message = asRecord(event.message);
	for (const source of [event, message]) {
		const value = source?.turnIndex;
		if (typeof value === "number" && Number.isInteger(value)) return value;
	}
	return undefined;
}

function getRequestModel(payload: unknown): string | undefined {
	const data = asRecord(payload);
	return getNonEmptyString(data?.model);
}

const MODEL_PARAMETER_KEYS = [
	"temperature",
	"top_p",
	"topP",
	"max_tokens",
	"maxTokens",
	"max_output_tokens",
	"maxOutputTokens",
	"max_completion_tokens",
	"presence_penalty",
	"frequency_penalty",
	"reasoning_effort",
] as const;

function extractModelParameters(payload: unknown) {
	const data = asRecord(payload);
	if (!data) return undefined;
	const parameters = pickModelParameters(data);
	// Responses-style payloads nest the effort under `reasoning`; report it
	// under the flat name chat-style payloads already use.
	const effort = parameters.reasoning_effort ?? reasoningEffortParameter(data);
	if (effort !== undefined) parameters.reasoning_effort = effort;
	return Object.keys(parameters).length > 0 ? parameters : undefined;
}

/** Collect the flat scalar model parameters present in the payload. */
function pickModelParameters(data: EventRecord) {
	const parameters: Record<string, string | number> = {};
	for (const key of MODEL_PARAMETER_KEYS) {
		const value = data[key];
		if (typeof value === "string" || typeof value === "number") {
			parameters[key] = value;
		}
	}
	return parameters;
}

/** Responses-style reasoning effort nested under `reasoning`. */
function reasoningEffortParameter(data: EventRecord) {
	const effort = asRecord(data.reasoning)?.effort;
	return typeof effort === "string" || typeof effort === "number"
		? effort
		: undefined;
}

const SAFE_PROVIDER_RESPONSE_HEADERS = new Set([
	"content-type",
	"content-length",
	"date",
	"retry-after",
	"server",
	"x-request-id",
	"request-id",
	"openai-processing-ms",
	"anthropic-ratelimit-requests-remaining",
	"anthropic-ratelimit-tokens-remaining",
]);

const SAFE_PROVIDER_METADATA_KEYS = new Set([
	"finishReason",
	"stopReason",
	"requestId",
	"responseId",
	"model",
	"provider",
]);

function safeProviderResponseHeaders(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const headers: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase();
		if (!SAFE_PROVIDER_RESPONSE_HEADERS.has(normalizedKey)) continue;
		if (typeof rawValue !== "string" && typeof rawValue !== "number") continue;
		const text = String(rawValue);
		if (text.length <= 200) headers[normalizedKey] = text;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function safeProviderMetadata(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const metadata: Record<string, string | number> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		if (!SAFE_PROVIDER_METADATA_KEYS.has(key) || isSensitiveKey(key)) continue;
		if (typeof rawValue !== "string" && typeof rawValue !== "number") continue;
		if (typeof rawValue === "string" && rawValue.length > 500) continue;
		metadata[key] = rawValue;
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function getLatestTurn(prompt: PromptState): TurnState | undefined {
	return Array.from(prompt.activeTurns.values()).at(-1);
}

function findTurnByRequestKey(
	prompt: PromptState,
	requestKey: string,
): TurnState | undefined {
	for (const turn of Array.from(prompt.activeTurns.values()).reverse()) {
		if (turn.generations.has(requestKey)) return turn;
	}
	return undefined;
}

function getTurn(
	prompt: PromptState,
	event: EventRecord,
): TurnState | undefined {
	const requestKey = getExplicitRequestKey(event);
	if (requestKey) {
		const turn = findTurnByRequestKey(prompt, requestKey);
		if (turn) return turn;
	}

	const turnIndex = getTurnIndex(event);
	if (turnIndex !== undefined) return prompt.activeTurns.get(turnIndex);
	return getLatestTurn(prompt);
}

function findLatestGeneration(
	turn: TurnState,
	predicate: (state: GenerationState) => boolean,
): GenerationState | undefined {
	for (let index = turn.generationOrder.length - 1; index >= 0; index -= 1) {
		const requestKey = turn.generationOrder[index];
		const state = requestKey ? turn.generations.get(requestKey) : undefined;
		if (state && predicate(state)) return state;
	}
	return undefined;
}

function createGenerationState(
	turn: TurnState,
	requestKey: string,
	requestModel?: string,
	requestFingerprint?: string,
): GenerationState {
	const state: GenerationState = {
		requestKey,
		startedAt: Date.now(),
		ended: false,
		streamingText: "",
		streamingThinking: "",
		metadata: { requestKey },
		requestModel,
		requestFingerprint,
	};
	turn.generations.set(requestKey, state);
	turn.generationOrder.push(requestKey);
	return state;
}

interface GenerationLookupOptions {
	create: boolean;
	newRequest: boolean;
	requestFingerprint?: string;
}

function nextGeneratedRequestKey(turn: TurnState) {
	const requestKey = `turn:${turn.index}:request:${turn.nextGenerationIndex}`;
	turn.nextGenerationIndex += 1;
	return requestKey;
}

/** Events carrying an explicit request key pin their generation by that key. */
function generationForExplicitRequestKey(
	turn: TurnState,
	requestKey: string,
	options: GenerationLookupOptions,
) {
	const existing = turn.generations.get(requestKey);
	if (existing || !options.create) return existing;
	return createGenerationState(turn, requestKey);
}

/** A new provider request reuses a retry with identical contents, else opens one. */
function generationForNewRequest(
	turn: TurnState,
	options: GenerationLookupOptions,
) {
	const latest = findLatestGeneration(turn, (state) => !state.ended);
	if (
		latest &&
		options.requestFingerprint &&
		latest.requestFingerprint === options.requestFingerprint
	)
		return latest;
	if (!options.create) return undefined;
	return createGenerationState(
		turn,
		nextGeneratedRequestKey(turn),
		undefined,
		options.requestFingerprint,
	);
}

/**
 * Message events belong to the newest request still in flight. When a
 * retry with different contents supersedes an earlier request, the older
 * generation stays open until turn cleanup abandons it.
 */
function generationForMessageEvent(
	turn: TurnState,
	options: GenerationLookupOptions,
) {
	const active = findLatestGeneration(
		turn,
		(state) => !state.ended && !state.finishPromise,
	);
	if (active) return active;
	const completed = findLatestGeneration(turn, (state) => state.ended);
	if (completed) return completed;
	if (!options.create) return undefined;
	return createGenerationState(turn, nextGeneratedRequestKey(turn));
}

function getOrCreateGenerationState(
	turn: TurnState,
	event: EventRecord,
	options: GenerationLookupOptions,
): GenerationState | undefined {
	const explicitRequestKey = getExplicitRequestKey(event);
	if (explicitRequestKey) {
		return generationForExplicitRequestKey(turn, explicitRequestKey, options);
	}
	if (options.newRequest) return generationForNewRequest(turn, options);
	return generationForMessageEvent(turn, options);
}

function providerResponseMetadata(
	event: EventRecord,
	previous: Record<string, unknown>,
) {
	const status = event.status ?? event.statusCode ?? event.httpStatus;
	const metadata: Record<string, unknown> = { ...previous };
	if (typeof status === "number") {
		metadata.providerResponseStatus = status;
		const previousStatuses = Array.isArray(previous.providerResponseStatuses)
			? previous.providerResponseStatuses.filter(
					(value): value is number => typeof value === "number",
				)
			: [];
		metadata.providerResponseStatuses = [...previousStatuses, status];
		if (status >= 400) metadata.providerResponseError = true;
	}
	const headers = safeProviderResponseHeaders(
		event.headers ?? event.responseHeaders,
	);
	if (headers) metadata.providerResponseHeaders = headers;
	const providerMetadata = safeProviderMetadata(
		event.providerMetadata ?? event.responseMetadata ?? event.metadata,
	);
	if (providerMetadata) metadata.providerResponseMetadata = providerMetadata;
	const requestId = getNonEmptyString(
		event.requestId ?? event.providerRequestId,
	);
	if (requestId) metadata.providerRequestId = requestId;
	if (event.error || event.isError) metadata.providerResponseError = true;
	return metadata;
}

export function createGenerationLifecycleHandlers(
	deps: GenerationLifecycleDependencies,
): GenerationLifecycleHandlers {
	const getSessionPrompt = (ctx: ExtensionContext, event: unknown) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt || prompt.finalizing) return undefined;
		const turn = getTurn(prompt, eventRecord(event));
		if (!turn) return undefined;
		return { state, prompt, turn };
	};

	const ensureGeneration = async (
		state: SessionState<PromptState>,
		prompt: PromptState,
		turn: TurnState,
		generationState: GenerationState,
		config: Config,
	) => {
		if (
			generationState.generation ||
			generationState.ended ||
			prompt.finalizing
		)
			return;
		if (!generationState.startPromise) {
			generationState.startPromise = (async () => {
				try {
					const lf = await deps.getRuntime(config);
					if (
						state.promptState !== prompt ||
						prompt.activeTurns.get(turn.index) !== turn ||
						generationState.ended
					)
						return;

					const model =
						generationState.requestModel || state.model || undefined;
					generationState.generation = lf.generation({
						name: "llm-response",
						traceId: prompt.trace?.id || "",
						parentObservationId: turn.span?.id || prompt.promptSpan?.id,
						input:
							generationState.inputSnapshot ??
							deps.telemetryText(
								config,
								prompt.userPrompt,
								config.traceInputMaxChars,
							),
						model,
						modelParameters: generationState.modelParameters,
						metadata: {
							...generationState.metadata,
							redaction: deps.redactionMetadata(config),
							turnIndex: turn.index,
							model: state.model,
							provider: state.provider,
						},
					});
				} catch (error) {
					console.warn("📊 Langfuse: Failed to start generation", error);
				}
			})();
		}
		await generationState.startPromise;
	};

	const snapshotInput = (prompt: PromptState, config: Config) =>
		prompt.lastMessages ??
		deps.telemetryText(config, prompt.userPrompt, config.traceInputMaxChars);

	const updateGeneration = (
		generationState: GenerationState,
		body: Parameters<NonNullable<LangfuseGeneration["update"]>>[0],
	) => {
		generationState.generation?.update?.(body);
	};

	const finishGeneration = (
		state: SessionState<PromptState>,
		prompt: PromptState,
		turn: TurnState,
		generationState: GenerationState,
		config: Config,
		body: Parameters<LangfuseGeneration["end"]>[0],
		usage?: PiUsage,
	) => {
		if (generationState.finishPromise) return generationState.finishPromise;
		if (generationState.ended) return Promise.resolve();
		generationState.finishPromise = (async () => {
			await ensureGeneration(state, prompt, turn, generationState, config);
			if (generationState.ended || !generationState.generation) return;

			generationState.ended = true;
			try {
				generationState.generation.end(body);
				if (
					usage &&
					state.promptState === prompt &&
					prompt.trace?.id &&
					generationState.generation
				) {
					const lf = await deps.getRuntime(config);
					const scoreTarget = {
						traceId: prompt.trace.id,
						observationId: generationState.generation.id,
					};
					if (usage.input) {
						lf.score({
							name: "input_tokens",
							value: usage.input,
							...scoreTarget,
						});
					}
					if (usage.output) {
						lf.score({
							name: "output_tokens",
							value: usage.output,
							...scoreTarget,
						});
					}
					if (typeof usage.cost?.total === "number") {
						lf.score({
							name: "total_cost",
							value: usage.cost.total,
							...scoreTarget,
						});
					}
				}
			} catch (error) {
				console.warn("📊 Langfuse: Failed to end generation", error);
			}
		})();
		return generationState.finishPromise;
	};

	const context = async (event: ContextEvent, ctx: ExtensionContext) => {
		const state = deps.getSessionState(ctx);
		const prompt = state?.promptState;
		if (!state || !prompt || prompt.finalizing) return;
		const config = deps.getConfig();
		const messages = event.messages as Array<{
			role: string;
			content: unknown;
		}>;
		prompt.lastContextMessages = messages;
		if (!deps.canTrace(config)) return;
		prompt.lastMessages = deps.summarizeMessages(
			config,
			event.messages as Array<{ role?: string; content?: unknown }>,
		);
	};

	/** Book one provider request on the turn span for rate/cost diagnostics. */
	const recordTurnRequest = (
		config: Config,
		turn: TurnState,
		model: string,
		payloadSummaryText: string,
	) => {
		if (!turn.requests) turn.requests = [];
		turn.requests.push({
			timestamp: new Date().toISOString(),
			payloadSize: payloadSummaryText.length,
			model,
		});
		turn.span?.update?.({
			metadata: {
				requests: turn.requests,
				providerPayload: config.captureProviderPayload
					? payloadSummaryText
					: undefined,
			},
		});
	};

	/** Correlate (or create) the generation for this provider request. */
	const trackGenerationRequest = (
		prompt: PromptState,
		turn: TurnState,
		record: EventRecord,
		event: BeforeProviderRequestEvent,
		config: Config,
		reqModel: string | undefined,
	) => {
		if (!deps.canTrace(config) || !prompt.trace) return;
		// Identity covers the complete payload; the truncated display
		// summary cannot distinguish requests that collide after windowing,
		// redaction, or parameter omission.
		const generationState = getOrCreateGenerationState(turn, record, {
			create: true,
			newRequest: true,
			requestFingerprint: providerRequestIdentity(event.payload),
		});
		if (generationState) {
			generationState.inputSnapshot = snapshotInput(prompt, config);
			generationState.requestModel = reqModel;
			generationState.modelParameters = extractModelParameters(event.payload);
		}
	};

	const beforeProviderRequest = async (
		event: BeforeProviderRequestEvent,
		ctx: ExtensionContext,
	) => {
		const resolved = getSessionPrompt(ctx, event);
		if (!resolved) return;
		const { state, prompt } = resolved;
		const config = deps.getConfig();
		const record = eventRecord(event);
		const turn = getTurn(prompt, record);
		if (!turn) return;

		try {
			const payloadSummaryText = deps.safeJson(
				config,
				deps.summarizeProviderPayload(config, event.payload, state.model),
				config.providerPayloadMaxChars,
			);
			const payload = asRecord(event.payload);
			const reqModel = getRequestModel(event.payload) || state.model;
			const capture = captureProviderRequest(payload);
			const { fallbackMessages, requestSource } = providerRequestProvenance(
				capture,
				prompt.lastContextMessages,
			);
			const summarySystemInstruction = () =>
				capture.systemInstruction !== undefined
					? deps.telemetryText(
							config,
							capture.systemInstruction,
							config.traceInputMaxChars,
						)
					: undefined;
			const summarizeRequestContents = () =>
				summarizeProviderRequestContents(
					config,
					capture.contents,
					summarySystemInstruction(),
				) ?? deps.summarizeProviderRequestMessages(config, fallbackMessages);
			const writeProviderRequestTrace = () => {
				if (config.rawTraceProviderRequestMode === "off") return undefined;
				// When the payload carries no recognizable request contents, the
				// prompt context is recorded as a diagnostic summary only: provenance
				// is marked and no wire metrics are claimed for contents that were
				// never observed in a payload.
				return providerRequestTraceRecord({
					captureMode:
						config.rawTraceProviderRequestMode === "full" ? "full" : "summary",
					turnIndex: turn.index,
					model: reqModel,
					requestSource,
					capture,
					systemInstruction:
						config.rawTraceProviderRequestMode === "full"
							? capture.systemInstruction
							: summarySystemInstruction(),
					payloadCaptured: config.captureProviderPayload,
					payloadSummary: config.captureProviderPayload
						? payloadSummaryText
						: undefined,
					messagesSummary: summarizeRequestContents(),
				});
			};
			const providerRequestTrace = writeProviderRequestTrace();
			if (providerRequestTrace) {
				deps.writeRawTrace(config, state, providerRequestTrace);
			}

			recordTurnRequest(config, turn, reqModel, payloadSummaryText);
			trackGenerationRequest(prompt, turn, record, event, config, reqModel);
		} catch {
			// Provider payload shaping is diagnostic-only and must not interrupt the request.
		}
	};

	const afterProviderResponse = async (
		event: AfterProviderResponseEvent,
		ctx: ExtensionContext,
	) => {
		const resolved = getSessionPrompt(ctx, event);
		if (!resolved) return;
		const { state, prompt, turn } = resolved;
		const config = deps.getConfig();
		if (!deps.canTrace(config) || !prompt.trace) return;
		const record = eventRecord(event);
		const generationState = getOrCreateGenerationState(turn, record, {
			create: true,
			newRequest: false,
		});
		if (
			!generationState ||
			generationState.ended ||
			generationState.finishPromise
		)
			return;
		generationState.inputSnapshot ??= snapshotInput(prompt, config);
		generationState.metadata = providerResponseMetadata(
			record,
			generationState.metadata,
		);
		await ensureGeneration(state, prompt, turn, generationState, config);
		if (!generationState.generation) return;
		updateGeneration(generationState, { metadata: generationState.metadata });
	};

	const messageStart = async (
		event: MessageStartEvent,
		ctx: ExtensionContext,
	) => {
		const message = asRecord(event.message);
		if (message?.role !== "assistant") return;
		const resolved = getSessionPrompt(ctx, event);
		if (!resolved) return;
		const { state, prompt, turn } = resolved;
		const config = deps.getConfig();
		if (!deps.canTrace(config) || !prompt.trace) return;
		const generationState = getOrCreateGenerationState(
			turn,
			eventRecord(event),
			{
				create: true,
				newRequest: false,
			},
		);
		if (
			!generationState ||
			generationState.ended ||
			generationState.finishPromise ||
			generationState.messageStarted
		)
			return;
		generationState.inputSnapshot ??= snapshotInput(prompt, config);
		generationState.messageStarted = true;
		generationState.streamingText = "";
		generationState.streamingThinking = "";
		await ensureGeneration(state, prompt, turn, generationState, config);
	};

	const messageUpdate = async (
		event: MessageUpdateEvent,
		ctx: ExtensionContext,
	) => {
		const message = asRecord(event.message);
		if (message?.role !== "assistant") return;
		const resolved = getSessionPrompt(ctx, event);
		if (!resolved) return;
		const { state, prompt, turn } = resolved;
		const config = deps.getConfig();
		if (!deps.canTrace(config) || !prompt.trace) return;
		const generationState = getOrCreateGenerationState(
			turn,
			eventRecord(event),
			{
				create: true,
				newRequest: false,
			},
		);
		if (
			!generationState ||
			generationState.ended ||
			generationState.finishPromise
		)
			return;
		generationState.inputSnapshot ??= snapshotInput(prompt, config);
		const assistantEvent = asRecord(event.assistantMessageEvent);
		if (!assistantEvent) return;
		if (assistantEvent.type === "text_delta") {
			generationState.streamingText += String(assistantEvent.delta ?? "");
		} else if (assistantEvent.type === "thinking_delta") {
			generationState.streamingThinking += String(assistantEvent.delta ?? "");
		}
		const firstToken =
			assistantEvent.type === "text_delta" ||
			assistantEvent.type === "thinking_delta";
		const completionStartTime =
			firstToken && !generationState.ttftRecorded ? new Date() : undefined;
		if (completionStartTime) {
			generationState.ttftRecorded = true;
			generationState.metadata.timeToFirstTokenMs = Math.max(
				0,
				completionStartTime.getTime() - generationState.startedAt,
			);
		}

		await ensureGeneration(state, prompt, turn, generationState, config);
		if (completionStartTime && generationState.generation) {
			updateGeneration(generationState, {
				completionStartTime,
				metadata: {
					timeToFirstTokenMs: generationState.metadata.timeToFirstTokenMs,
				},
			});
		}
		if (config.captureMessageUpdates && generationState.generation) {
			updateGeneration(generationState, {
				output: deps.telemetryText(
					config,
					generationState.streamingThinking + generationState.streamingText,
					config.traceOutputMaxChars,
				),
				metadata: {
					hasThinking: !!generationState.streamingThinking,
					partial: true,
				},
			});
		}

		if (assistantEvent.type === "error") {
			await finishGeneration(state, prompt, turn, generationState, config, {
				isError: true,
				statusMessage: String(
					assistantEvent.reason ?? "provider response failed",
				),
				metadata: {
					...generationState.metadata,
					providerError: true,
				},
			});
		}
	};

	const messageEnd = async (event: MessageEndEvent, ctx: ExtensionContext) => {
		const message = asRecord(event.message);
		if (message?.role !== "assistant") return;
		const resolved = getSessionPrompt(ctx, event);
		if (!resolved) return;
		const { state, prompt, turn } = resolved;
		if (turn.messageEnded) return;
		turn.messageEnded = true;
		const failure = getLifecycleFailure(message);
		if (failure) {
			turn.failure = failure;
			prompt.failure ??= failure;
		}
		const config = deps.getConfig();
		const content = message.content as
			| Array<{ type: string; text?: string }>
			| undefined;
		const outputText = deps.extractTextFromContent(content).trim();
		const generationState =
			deps.canTrace(config) && prompt.trace
				? getOrCreateGenerationState(turn, eventRecord(event), {
						create: true,
						newRequest: false,
					})
				: undefined;
		if (generationState) {
			generationState.inputSnapshot ??= snapshotInput(prompt, config);
		}
		const finalOutput =
			outputText ||
			(generationState?.streamingThinking || "") +
				(generationState?.streamingText || "");
		const usage = message.usage as PiUsage | undefined;
		const standardUsage = deps.standardUsageFromUsage(usage);
		const usageDetails = deps.usageDetailsFromUsage(usage);
		const costDetails = deps.costDetailsFromUsage(usage);

		prompt.lastAssistantText = deps.telemetryText(
			config,
			finalOutput,
			config.traceOutputMaxChars,
		);
		prompt.lastUsage = usage;
		deps.writeRawTrace(config, state, {
			type: "assistant_output",
			turnIndex: turn.index,
			text: finalOutput,
			thinking: generationState?.streamingThinking || undefined,
			usage,
			messageModel: getNonEmptyString(message.model),
		});

		if (usage) {
			prompt.tokensIn +=
				(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			prompt.tokensOut += usage.output ?? 0;
			prompt.cacheRead += usage.cacheRead ?? 0;
			prompt.cacheWrite += usage.cacheWrite ?? 0;
		}

		if (!generationState) return;
		await finishGeneration(
			state,
			prompt,
			turn,
			generationState,
			config,
			{
				output:
					deps.telemetryText(config, finalOutput, config.traceOutputMaxChars) ||
					undefined,
				usage: standardUsage,
				usageDetails,
				costDetails,
				modelParameters:
					extractModelParameters(eventRecord(event)) ||
					generationState.modelParameters,
				model:
					getNonEmptyString(message.model) ||
					state.model ||
					generationState.requestModel ||
					undefined,
				metadata: {
					...generationState.metadata,
					model: getNonEmptyString(message.model) || state.model,
					provider: state.provider,
					turnIndex: turn.index,
					thinking: generationState.streamingThinking || undefined,
					stopReason: failure?.stopReason,
					errorMessage: failure?.errorMessage,
				},
				isError: Boolean(failure) || message.isError === true,
				statusMessage:
					failure?.errorMessage ||
					(failure?.stopReason === "error" || message.isError === true
						? typeof generationState.metadata.providerResponseStatus ===
							"number"
							? `provider response failed (${generationState.metadata.providerResponseStatus})`
							: "provider response failed"
						: failure?.stopReason === "aborted"
							? "provider response aborted"
							: undefined),
			},
			usage,
		);
	};

	const abandonTurn = async (turn: TurnState) => {
		for (const requestKey of turn.generationOrder) {
			const generationState = turn.generations.get(requestKey);
			if (!generationState || generationState.ended) continue;
			if (generationState.finishPromise) {
				await generationState.finishPromise;
				continue;
			}
			generationState.finishPromise = (async () => {
				generationState.ended = true;
				if (generationState.startPromise) {
					await generationState.startPromise;
				}
				if (!generationState.generation) return;
				try {
					generationState.generation.end({
						isError: true,
						statusMessage: "generation abandoned during prompt finalization",
						metadata: {
							...generationState.metadata,
							abandoned: true,
							turnIndex: turn.index,
							durationMs: Date.now() - generationState.startedAt,
						},
					});
				} catch (error) {
					console.warn("📊 Langfuse: Failed to abandon generation", error);
				}
			})();
			await generationState.finishPromise;
		}
	};

	return {
		context,
		beforeProviderRequest,
		afterProviderResponse,
		messageStart,
		messageUpdate,
		messageEnd,
		abandonTurn,
	};
}
