import { createHash } from "node:crypto";
import { basename } from "node:path";
import { isCaptureEnabled } from "./capture-policy.js";
import type { Config } from "./config.js";
import type { PiUsage, PromptState } from "./lifecycle-types.js";
import { appendRawTrace } from "./raw-trace.js";
import { redactionMetadata, redactString } from "./redaction.js";
import type { SessionState } from "./session-state.js";

export function truncate(text: string, max = 1200) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function telemetryText(config: Config, text: string, max: number) {
	const scanLimit = Math.max(max * 2, max + 500);
	const bounded =
		text.length > scanLimit
			? `${text.slice(0, scanLimit)}…[truncated ${text.length - scanLimit} chars]`
			: text;
	return truncate(redactString(config, bounded), max);
}

export function safeJson(config: Config, value: unknown, max = 1200) {
	try {
		return telemetryText(config, JSON.stringify(value, null, 2), max);
	} catch {
		return "[unserializable]";
	}
}

export function summarizeToolArgs(
	config: Config,
	toolName: string,
	args: unknown,
) {
	if (!args || typeof args !== "object")
		return safeJson(config, args, config.toolArgsMaxChars);
	const data = args as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return telemetryText(
				config,
				String(data.command ?? ""),
				config.toolArgsMaxChars,
			);
		case "read":
			return telemetryText(
				config,
				`${String(data.path ?? "")}#${String(data.offset ?? 1)}:${String(data.limit ?? "")}`,
				config.toolArgsMaxChars,
			);
		case "write":
		case "edit":
			return telemetryText(
				config,
				String(data.path ?? ""),
				config.toolArgsMaxChars,
			);
		case "web_search":
			return telemetryText(
				config,
				String(
					data.query ??
						(Array.isArray(data.queries) ? data.queries.join(" | ") : ""),
				),
				config.toolArgsMaxChars,
			);
		default:
			return safeJson(config, args, config.toolArgsMaxChars);
	}
}

export function extractTextFromContent(
	content: Array<{ type: string; text?: string }> | undefined,
) {
	if (!content?.length) return "";
	// Parts come from untrusted payloads: nullish entries must be skipped like
	// any other unexpanded part, not crash the summarizer.
	return content
		.filter((item) => item?.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
}

export function summarizeMessageContent(config: Config, content: unknown) {
	if (typeof content === "string") {
		return telemetryText(config, content, config.traceInputMaxChars);
	}
	if (Array.isArray(content)) {
		const text = extractTextFromContent(
			content.slice(0, 20) as Array<{ type: string; text?: string }>,
		);
		if (text) return telemetryText(config, text, config.traceInputMaxChars);
		return `[${content.length} content item(s)]`;
	}
	if (content && typeof content === "object") {
		const maybeContent = (content as { content?: unknown }).content;
		if (Array.isArray(maybeContent))
			return summarizeMessageContent(config, maybeContent);
		return "[object content]";
	}
	return content == null ? "" : String(content);
}

/** Marker for message content the capture policy excludes from summaries. */
const OMITTED_TOOL_OUTPUT = "[tool output omitted]";

/** Message roles whose plain content is tool output, not conversation text. */
const TOOL_OUTPUT_ROLES = new Set(["tool", "tool_result", "toolResult"]);

/**
 * Summarize one message's content under the capture policy for its role.
 * Summaries are flattened strings: once serialized into payload summaries the
 * internal roles are lost, so excluded tool output must be replaced here,
 * before flattening, or a tool-output opt-out could never hold.
 */
function summarizeMessageForRole(
	config: Config,
	role: string | undefined,
	content: unknown,
) {
	if (
		role !== undefined &&
		TOOL_OUTPUT_ROLES.has(role) &&
		!isCaptureEnabled(config, "toolOutput")
	) {
		return OMITTED_TOOL_OUTPUT;
	}
	return summarizeMessageContent(config, content);
}

export function summarizeMessages(
	config: Config,
	messages: Array<{ role?: string; content?: unknown }>,
) {
	const limit = 40;
	const selected = messages.slice(-limit).map((message) => ({
		role: message.role || "unknown",
		content: summarizeMessageForRole(config, message.role, message.content),
	}));
	if (messages.length > limit) {
		selected.unshift({
			role: "system",
			content: `[truncated ${messages.length - limit} earlier message(s)]`,
		});
	}
	return selected;
}

export function summarizeProviderPayload(
	config: Config,
	payload: unknown,
	fallbackModel: string,
) {
	if (!payload || typeof payload !== "object") return { type: typeof payload };
	const data = payload as Record<string, unknown>;
	const contents = providerRequestContents(data);
	return {
		model: typeof data.model === "string" ? data.model : fallbackModel,
		// Only input-shaped payloads carry a source marker; Chat Completions
		// summaries keep the legacy shape (no source key) unchanged.
		source: contents && contents.field !== "messages" ? "input" : undefined,
		messageCount: requestItemCount(contents),
		messages: summarizeProviderRequestForDisplay(config, contents),
		keys: Object.keys(data).slice(0, 50),
	};
}

/** Wire item count of recognized contents: items length, one for text. */
function requestItemCount(contents: ProviderRequestContents | undefined) {
	if (!contents) return undefined;
	return "items" in contents ? contents.items.length : 1;
}

/** Bounded display summary of recognized request contents. */
function summarizeProviderRequestForDisplay(
	config: Config,
	contents: ProviderRequestContents | undefined,
) {
	if (!contents) return undefined;
	if (contents.field === "messages") {
		return summarizeMessages(
			config,
			contents.items as Array<{ role?: string; content?: unknown }>,
		);
	}
	return summarizeProviderRequestInput(
		config,
		contents.field === "input-items" ? contents.items : contents.text,
	);
}

/**
 * Complete in-memory request identity over the full unredacted payload.
 *
 * Distinct requests produce distinct identities even when their bounded
 * display summaries collide (windowed items, omitted tool arguments, or
 * parameter values). The value exists only for same-turn retry coalescing:
 * it is compared in memory and must never be written to any sink. Unserializable
 * payloads (cycles, BigInt) return undefined, which disables coalescing for
 * that request rather than mis-merging it.
 */
export function providerRequestIdentity(payload: unknown): string | undefined {
	try {
		return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Recognizable request contents inside a provider payload. Responses-style
 * payloads carry `input` (an item array or a plain string) where Chat
 * Completions payloads carry `messages`.
 */
export type ProviderRequestContents =
	| { field: "messages"; items: unknown[] }
	| { field: "input-items"; items: unknown[] }
	| { field: "input-text"; text: string };

/** Provenance of the contents recorded on a provider_request trace. */
export type ProviderRequestSource =
	| "payload.messages"
	| "payload.input"
	| "context";

export interface CapturedProviderRequest {
	/** Recognized contents, or undefined when the payload carried none. */
	contents: ProviderRequestContents | undefined;
	/** The captured contents themselves (item array or plain string). */
	captured: unknown;
	/** Wire item count derived only from captured contents, never context. */
	messageCount: number | undefined;
	/** Wire byte estimate derived only from captured contents, never context. */
	estimatedBytes: number | undefined;
}

/**
 * Capture the request contents of a provider payload plus the wire metrics
 * derived from them. Unrecognized payloads capture nothing: metrics stay
 * undefined so a record can never claim wire contents it never observed.
 */
export function captureProviderRequest(
	payload: Record<string, unknown> | undefined,
): CapturedProviderRequest {
	const contents = providerRequestContents(payload);
	const captured = contents
		? "items" in contents
			? contents.items
			: contents.text
		: undefined;
	return {
		contents,
		captured,
		messageCount: Array.isArray(captured)
			? captured.length
			: captured !== undefined
				? 1
				: undefined,
		estimatedBytes: estimateJsonBytes(captured),
	};
}

/**
 * Where the recorded request contents came from: the captured payload field,
 * the prompt context as a diagnostic fallback, or nothing at all.
 */
export function providerRequestProvenance(
	capture: CapturedProviderRequest,
	lastContextMessages: unknown,
): {
	fallbackMessages: unknown;
	requestSource: ProviderRequestSource | undefined;
} {
	const fallbackMessages = capture.contents ? undefined : lastContextMessages;
	return {
		fallbackMessages,
		requestSource: capture.contents
			? capture.contents.field === "messages"
				? "payload.messages"
				: "payload.input"
			: fallbackMessages
				? ("context" as const)
				: undefined,
	};
}

export interface ProviderRequestTraceInput {
	/** Whether to embed captured contents ("full") or the display summary. */
	captureMode: "full" | "summary";
	/** Index of the turn that issued the request. */
	turnIndex: number;
	/** Model requested by the payload, or the session fallback model. */
	model: string | undefined;
	/** Provenance label for the recorded contents. */
	requestSource: ProviderRequestSource | undefined;
	/** Captured payload contents and their wire metrics. */
	capture: CapturedProviderRequest;
	/** Whether the configured capture policy stores full payloads. */
	payloadCaptured: boolean;
	/** Bounded serialized payload summary, when payload capture is enabled. */
	payloadSummary: string | undefined;
	/** Bounded display summary of the request contents (summary mode). */
	messagesSummary: unknown;
}

/**
 * Build the provider_request raw trace record for one capture mode. Full mode
 * embeds the captured contents; summary mode embeds the bounded display
 * summary and marks full contents as omitted only when contents were captured.
 */
export function providerRequestTraceRecord(
	input: ProviderRequestTraceInput,
): { type: string } & Record<string, unknown> {
	const base = {
		type: "provider_request",
		turnIndex: input.turnIndex,
		model: input.model,
		requestSource: input.requestSource,
		messageCount: input.capture.messageCount,
		estimatedBytes: input.capture.estimatedBytes,
		payloadCaptured: input.payloadCaptured,
		payloadSummary: input.payloadSummary,
	};
	if (input.captureMode === "full") {
		return { ...base, captureMode: "full", messages: input.capture.captured };
	}
	return {
		...base,
		captureMode: "summary",
		messagesSummary: input.messagesSummary,
		fullMessagesOmitted:
			input.capture.captured !== undefined ? true : undefined,
	};
}

export function providerRequestContents(
	payload: Record<string, unknown> | undefined,
): ProviderRequestContents | undefined {
	if (!payload) return undefined;
	if (Array.isArray(payload.messages))
		return { field: "messages", items: payload.messages };
	if (typeof payload.input === "string")
		return { field: "input-text", text: payload.input };
	if (Array.isArray(payload.input))
		return { field: "input-items", items: payload.input };
	return undefined;
}

/** Responses input item types that carry tool-call request data. */
export const RESPONSES_TOOL_CALL_ITEM_TYPES = new Set([
	"function_call",
	"custom_tool_call",
]);

/** Responses input item types that carry tool output data. */
export const RESPONSES_TOOL_OUTPUT_ITEM_TYPES = new Set([
	"function_call_output",
	"custom_tool_call_output",
]);

/** True for JSON objects other than arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const RESPONSES_TEXT_PART_TYPES = new Set([
	"text",
	"input_text",
	"output_text",
]);

/**
 * Responses content parts name their text variants input_text/output_text;
 * normalize them so shared message summarization can extract the text.
 */
function normalizeResponsesTextParts(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((part) =>
		isNamedTextPart(part) ? { type: "text", text: part.text } : part,
	);
}

/** A content part carrying plain text under a Responses text-part type. */
function isNamedTextPart(
	part: unknown,
): part is { type: string; text: string } {
	if (!isRecord(part)) return false;
	return (
		typeof part.type === "string" &&
		RESPONSES_TEXT_PART_TYPES.has(part.type) &&
		typeof part.text === "string"
	);
}

function summarizeResponseInputItem(
	config: Config,
	item: unknown,
): { role: string; content: string } {
	if (typeof item === "string") {
		return { role: "user", content: summarizeMessageContent(config, item) };
	}
	if (!isRecord(item)) {
		return { role: "unknown", content: summarizeMessageContent(config, item) };
	}
	if (typeof item.role === "string") {
		return {
			role: item.role,
			content: summarizeMessageContent(
				config,
				normalizeResponsesTextParts(item.content),
			),
		};
	}
	return summarizeUnroledResponseItem(config, item);
}

/**
 * Unroled Responses items are typed structs: summarize their shape and
 * correlation ids, never their contents.
 */
function summarizeUnroledResponseItem(
	config: Config,
	data: Record<string, unknown>,
): { role: string; content: string } {
	const itemType = typeof data.type === "string" ? data.type : "unknown";
	if (RESPONSES_TOOL_CALL_ITEM_TYPES.has(itemType)) {
		return toolCallItemSummary(config, itemType, data);
	}
	if (RESPONSES_TOOL_OUTPUT_ITEM_TYPES.has(itemType)) {
		return toolOutputItemSummary(config, itemType, data);
	}
	if (itemType === "reasoning") {
		// Reasoning summaries and encrypted content are never expanded here.
		return { role: "assistant", content: "[reasoning item]" };
	}
	return { role: itemType, content: `[${itemType} item]` };
}

/** Tool inputs are tool-call data: record the call shape, never the arguments. */
function toolCallItemSummary(
	config: Config,
	itemType: string,
	data: Record<string, unknown>,
): { role: string; content: string } {
	const name = typeof data.name === "string" ? data.name : "unknown";
	return {
		role: "assistant",
		content: telemetryText(
			config,
			`[${itemType}: ${name}]`,
			config.traceInputMaxChars,
		),
	};
}

/** Tool outputs stay structural; full text belongs to tool records. */
function toolOutputItemSummary(
	config: Config,
	itemType: string,
	data: Record<string, unknown>,
): { role: string; content: string } {
	const callId = typeof data.call_id === "string" ? data.call_id : "unknown";
	return {
		role: "tool",
		content: telemetryText(
			config,
			`[${itemType}: ${callId}]`,
			config.traceInputMaxChars,
		),
	};
}

/**
 * Summarize a Responses-style request input (item array or plain string) with
 * the same per-item bounds and redaction chat messages receive.
 */
export function summarizeProviderRequestInput(config: Config, input: unknown) {
	const items =
		typeof input === "string"
			? [input]
			: Array.isArray(input)
				? input
				: undefined;
	if (!items) return undefined;
	const limit = 40;
	const selected = items
		.slice(-limit)
		.map((item) => summarizeResponseInputItem(config, item));
	if (items.length > limit) {
		selected.unshift({
			role: "system",
			content: `[truncated ${items.length - limit} earlier item(s)]`,
		});
	}
	return selected;
}

export function estimateJsonBytes(value: unknown) {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8");
	} catch {
		return undefined;
	}
}

export function summarizeProviderRequestMessages(
	config: Config,
	messages: unknown,
) {
	if (!Array.isArray(messages)) return undefined;
	return summarizeMessages(
		config,
		messages as Array<{ role?: string; content?: unknown }>,
	);
}

export function redactToolContent(config: Config, result: unknown): string {
	if (!result) return "";
	if (typeof result === "string") return redactString(config, result);
	if (typeof result === "object") {
		const data = result as {
			content?: Array<{ type: string; text?: string }>;
		};
		if (data.content) {
			const textParts: string[] = [];
			let imageCount = 0;
			for (const item of data.content) {
				if (item.type === "text" && item.text) {
					textParts.push(item.text);
				} else if (item.type === "image" || item.type === "image_url") {
					imageCount++;
				}
			}
			let result = textParts.join("\n");
			if (imageCount > 0) {
				result += `${result ? "\n" : ""}[${imageCount} image content block(s) from tool result]`;
			}
			if (result) return redactString(config, result);
		}
	}
	try {
		return redactString(config, JSON.stringify(result, null, 2));
	} catch {
		return "[unserializable]";
	}
}

export function summarizeToolResult(config: Config, result: unknown) {
	if (!result) return "";
	if (typeof result === "string")
		return telemetryText(config, result, config.toolOutputMaxChars);
	if (typeof result === "object") {
		const data = result as { content?: Array<{ type: string; text?: string }> };
		const text = extractTextFromContent(data.content);
		if (text) return telemetryText(config, text, config.toolOutputMaxChars);
	}
	return safeJson(config, result, config.toolOutputMaxChars);
}

export function usageDetailsFromUsage(usage?: PiUsage) {
	if (!usage) return undefined;
	const details: Record<string, number> = {};
	if (usage.input) details.input = usage.input;
	if (usage.output) details.output = usage.output;
	if (usage.cacheRead) details.input_cached_read = usage.cacheRead;
	if (usage.cacheWrite) details.input_cached_write = usage.cacheWrite;
	if (usage.totalTokens) details.total = usage.totalTokens;
	return Object.keys(details).length > 0 ? details : undefined;
}

export function standardUsageFromUsage(usage?: PiUsage) {
	if (!usage) return undefined;
	const standard: Record<string, number> = {};
	if (usage.input) standard.input = usage.input;
	if (usage.output) standard.output = usage.output;
	if (usage.totalTokens) {
		standard.total = usage.totalTokens;
	} else if (usage.input || usage.output) {
		standard.total = (usage.input ?? 0) + (usage.output ?? 0);
	}
	return Object.keys(standard).length > 0 ? standard : undefined;
}

export function costDetailsFromUsage(usage?: PiUsage) {
	const cost = usage?.cost;
	if (!cost) return undefined;
	const details: Record<string, number> = {};
	if (typeof cost.input === "number") details.input = cost.input;
	if (typeof cost.output === "number") details.output = cost.output;
	if (typeof cost.total === "number") details.total = cost.total;
	if (
		Object.keys(details).length === 0 ||
		Object.values(details).every((value) => value === 0)
	)
		return undefined;
	return details;
}

export function getUserId(config?: Config) {
	return config?.userId || undefined;
}

export function getRuntimeName() {
	return process.env.TIA_ACTIVE === "1" ? "tia" : "pi";
}

export function getSessionRoot(sessionFile: string) {
	const marker = "/sessions/";
	const index = sessionFile.indexOf(marker);
	return index >= 0
		? sessionFile.slice(0, index + marker.length - 1)
		: undefined;
}

function rawTraceBase(state: SessionState<PromptState>, turnIndex?: number) {
	return {
		timestamp: new Date().toISOString(),
		sessionId: state.sessionId || undefined,
		sessionFile: state.sessionFile || undefined,
		turnIndex,
		provider: state.provider || undefined,
		model: state.model || undefined,
		runtime: getRuntimeName(),
	};
}

export function currentTurnIndex(prompt: PromptState) {
	const activeTurns = Array.from(prompt.activeTurns.values());
	return activeTurns.length > 0
		? activeTurns[activeTurns.length - 1]?.index
		: undefined;
}

export function writeRawTrace(
	config: Config,
	state: SessionState<PromptState>,
	record: { type: string } & Record<string, unknown>,
) {
	appendRawTrace(config, state.sessionFile, {
		...rawTraceBase(
			state,
			typeof record.turnIndex === "number" ? record.turnIndex : undefined,
		),
		redaction: redactionMetadata(config),
		traceId: state.promptState?.trace?.id,
		...record,
	});
}

export function buildTraceTags(
	config: Config | undefined,
	state: SessionState<PromptState>,
	cwd: string,
) {
	const runtime = getRuntimeName();
	const tags = [
		"pi",
		"pi-langfuse",
		`runtime:${runtime}`,
		...(config?.defaultTags ?? []),
	];
	const projectName = basename(cwd || process.cwd());
	if (projectName) tags.push(`project:${projectName}`);
	if (state.provider) tags.push(`provider:${state.provider}`);
	if (state.model) tags.push(`model:${state.model}`);
	if (state.sessionReason) tags.push(`session:${state.sessionReason}`);
	return Array.from(new Set(tags)).slice(0, 20);
}
