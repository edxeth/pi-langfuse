import { createHash } from "node:crypto";
import { RAW_CAPTURE_PROVENANCE_KEY } from "./payload-policy.js";

/**
 * Conversion of sanitized raw-trace derivatives into local training review
 * records. One sample is one normally completed assistant generation: the
 * full provider context observed in its `provider_request` record, followed
 * by the structured final answer of the `assistant_output` record that
 * answers it. Nothing is reconstructed from summaries; anything that cannot
 * be proven complete, paired, and unambiguous is rejected with a reason.
 */

export const TRAINING_FORMATS = [
	"openai-chat",
	"anthropic-messages",
	"sharegpt",
] as const;
export type TrainingFormat = (typeof TRAINING_FORMATS)[number];

export const EXPORT_CONSENTS = ["unknown", "granted", "denied"] as const;
export type ExportConsent = (typeof EXPORT_CONSENTS)[number];

/** Stamped on every record: these are review artifacts, not upload-ready sets. */
export const TRAINING_REVIEW_NOTICE =
	"Local review record, not a certified provider-upload-ready dataset. Consent and license are operator declarations that no scan verified.";

export interface TrainingDeclaration {
	consent: ExportConsent;
	license: string;
}

export interface TrainingExample {
	schema: "pi-langfuse.training-example/v1";
	format: TrainingFormat;
	id: string;
	source: {
		path: string;
		requestLine: number;
		responseLine: number;
		turnIndex: number;
	};
	provider?: string;
	model?: string;
	consent: ExportConsent;
	license: string;
	/** Source content the target format cannot carry, by category. */
	omitted: string[];
	notice: string;
	example: Record<string, unknown>;
}

export interface TrainingRejection {
	/** Stable reason code; never contains source content. */
	reason: string;
	/** 1-based line of the rejected record in the derivative file. */
	line: number;
}

export interface TrainingConversion {
	examples: TrainingExample[];
	rejections: TrainingRejection[];
}

type JsonRecord = Record<string, unknown>;

interface RawLine {
	line: number;
	record: JsonRecord;
}

/** An unconvertible sample; thrown while converting, reported as a reason. */
class SampleRejection extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

function reject(reason: string): never {
	throw new SampleRejection(reason);
}

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reason codes are fixed vocabulary; source strings only enter as slugs. */
function slug(value: unknown) {
	return typeof value === "string"
		? value
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, "-")
				.slice(0, 40) || "empty"
		: "unknown";
}

/** Records that end one prompt's raw-trace segment. */
const SEGMENT_BOUNDARY_TYPES = new Set([
	"agent_prompt_start",
	"session_start",
	"session_end",
	"session_compact",
]);

const SUPPORTED_REQUEST_SOURCES = new Set([
	"payload.messages",
	"payload.context",
	"payload.input",
]);

/** Text content-block types of Pi, Anthropic, and Responses messages. */
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);
/** Assistant stop reasons that mean the stored history turn is incomplete. */
const INCOMPLETE_STOP_REASONS = new Set(["error", "aborted", "length"]);

// ---------------------------------------------------------------------------
// Context normalization

interface ToolCall {
	id: string;
	name: string;
	args: JsonRecord;
}

type Turn =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string; calls: ToolCall[] }
	| {
			role: "tool";
			callId: string;
			toolName: string | undefined;
			text: string;
			isError: boolean;
	  };

interface NormalizedContext {
	system: string | undefined;
	turns: Turn[];
	/** Source content categories no target format here carries. */
	omitted: Set<string>;
}

function nonEmptyString(value: unknown, reason: string): string {
	if (typeof value !== "string" || value.length === 0) reject(reason);
	return value;
}

/** One text block of a content array; any other block makes the sample unconvertible. */
function textBlock(block: unknown): string {
	if (!isRecord(block) || typeof block.type !== "string") {
		return reject("malformed-content");
	}
	if (!TEXT_BLOCK_TYPES.has(block.type)) {
		return reject(`unsupported-content-${slug(block.type)}`);
	}
	if (typeof block.text !== "string") return reject("malformed-content");
	return block.text;
}

/** Join text blocks with a newline, as Pi renders multi-block text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return reject("malformed-content");
	return content.map((block) => textBlock(block)).join("\n");
}

function sectionTexts(sections: unknown): string[] {
	if (!isRecord(sections)) return reject("malformed-content");
	const parts: string[] = [];
	for (const value of Object.values(sections)) {
		if (value === null) continue;
		if (typeof value !== "string") return reject("malformed-content");
		parts.push(value);
	}
	return parts;
}

/** A Pi system message renders as its content plus its non-null sections. */
function systemText(message: JsonRecord): string {
	const parts: string[] = [];
	if (message.content !== undefined && message.content !== null) {
		parts.push(textOf(message.content));
	}
	if (message.sections !== undefined) {
		parts.push(...sectionTexts(message.sections));
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

function parseArguments(value: unknown): JsonRecord {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return reject("invalid-tool-arguments");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return reject("invalid-tool-arguments");
	}
	return isRecord(parsed) ? parsed : reject("invalid-tool-arguments");
}

function toolCall(id: unknown, name: unknown, args: unknown): ToolCall {
	return {
		id: nonEmptyString(id, "malformed-tool-call"),
		name: nonEmptyString(name, "malformed-tool-call"),
		args: parseArguments(args),
	};
}

/** Tool-call content blocks by type, with the field that carries the arguments. */
const TOOL_BLOCK_ARGUMENTS = new Map([
	["toolCall", "arguments"],
	["tool_use", "input"],
]);
const REASONING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

interface AssistantParts {
	texts: string[];
	calls: ToolCall[];
}

function addAssistantBlock(
	block: unknown,
	parts: AssistantParts,
	omitted: Set<string>,
) {
	if (!isRecord(block) || typeof block.type !== "string") {
		return reject("malformed-content");
	}
	if (TEXT_BLOCK_TYPES.has(block.type)) {
		parts.texts.push(textBlock(block));
		return;
	}
	const argumentsKey = TOOL_BLOCK_ARGUMENTS.get(block.type);
	if (argumentsKey !== undefined) {
		parts.calls.push(toolCall(block.id, block.name, block[argumentsKey]));
		return;
	}
	if (REASONING_BLOCK_TYPES.has(block.type)) {
		omitted.add("reasoning");
		return;
	}
	return reject(`unsupported-content-${slug(block.type)}`);
}

function assistantParts(content: unknown, omitted: Set<string>) {
	const parts: AssistantParts = { texts: [], calls: [] };
	if (typeof content === "string") {
		parts.texts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) addAssistantBlock(block, parts, omitted);
	} else if (content !== undefined && content !== null) {
		return reject("malformed-content");
	}
	return parts;
}

/** One Chat Completions `tool_calls` entry. */
function wireToolCall(call: unknown): ToolCall {
	if (!isRecord(call) || call.type !== "function") {
		return reject("unsupported-tool-call-type");
	}
	const fn = call.function;
	if (!isRecord(fn)) return reject("malformed-tool-call");
	return toolCall(call.id, fn.name, fn.arguments);
}

function wireToolCalls(toolCalls: unknown): ToolCall[] {
	if (toolCalls === undefined) return [];
	if (!Array.isArray(toolCalls)) return reject("malformed-tool-call");
	return toolCalls.map((call) => wireToolCall(call));
}

function normalizeAssistant(
	message: JsonRecord,
	omitted: Set<string>,
): Extract<Turn, { role: "assistant" }> {
	if (
		typeof message.stopReason === "string" &&
		INCOMPLETE_STOP_REASONS.has(message.stopReason)
	) {
		reject("incomplete-history-turn");
	}
	const { texts, calls } = assistantParts(message.content, omitted);
	calls.push(...wireToolCalls(message.tool_calls));
	const text = texts.join("\n");
	if (text.length === 0 && calls.length === 0) {
		return reject("empty-assistant-turn");
	}
	return { role: "assistant", text, calls };
}

function normalizeUser(message: JsonRecord, turns: Turn[]) {
	const content = message.content;
	if (!Array.isArray(content)) {
		turns.push({ role: "user", text: textOf(content) });
		return;
	}
	// Anthropic carries tool results inside user messages: text before a
	// result and the result itself stay separate turns in source order.
	let pending: unknown[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		turns.push({ role: "user", text: textOf(pending) });
		pending = [];
	};
	for (const block of content) {
		if (isRecord(block) && block.type === "tool_result") {
			flush();
			turns.push({
				role: "tool",
				callId: nonEmptyString(block.tool_use_id, "malformed-tool-result"),
				toolName: undefined,
				text: block.content === undefined ? "" : textOf(block.content),
				isError: block.is_error === true,
			});
		} else {
			pending.push(block);
		}
	}
	flush();
}

function normalizeToolMessage(message: JsonRecord): Turn {
	return {
		role: "tool",
		callId: nonEmptyString(
			message.tool_call_id ?? message.toolCallId,
			"malformed-tool-result",
		),
		toolName:
			typeof message.toolName === "string" ? message.toolName : undefined,
		text: textOf(message.content),
		isError: message.isError === true,
	};
}

/** Unroled Responses items; `function_call` joins the assistant step before it. */
function normalizeResponsesItem(
	item: JsonRecord,
	turns: Turn[],
	omitted: Set<string>,
) {
	switch (item.type) {
		case "reasoning":
			omitted.add("reasoning");
			return;
		case "function_call": {
			const call = toolCall(item.call_id, item.name, item.arguments);
			const previous = turns.at(-1);
			if (previous?.role === "assistant") previous.calls.push(call);
			else turns.push({ role: "assistant", text: "", calls: [call] });
			return;
		}
		case "function_call_output":
			turns.push({
				role: "tool",
				callId: nonEmptyString(item.call_id, "malformed-tool-result"),
				toolName: undefined,
				text: textOf(item.output),
				isError: false,
			});
			return;
		default:
			return reject(`unsupported-item-${slug(item.type)}`);
	}
}

/**
 * Responses items report `status` (`in_progress | completed | incomplete`,
 * absent or null where the input schema allows). Only an explicit
 * `completed` proves the item finished; absence proves nothing either way
 * and is accepted.
 */
function assertItemCompleted(item: JsonRecord) {
	const status = item.status;
	if (status === undefined || status === null || status === "completed") return;
	if (typeof status !== "string") return reject("malformed-item-status");
	return reject(`incomplete-history-item-${slug(status)}`);
}

function normalizeSystemItem(
	item: JsonRecord,
	index: number,
	state: NormalizedContext,
) {
	if (index !== 0) return reject("unsupported-midconversation-system");
	if (state.system !== undefined) return reject("multiple-system-sources");
	state.system = systemText(item);
	// Pi attaches tool definitions to the system message; they are
	// request configuration, not conversation turns.
	if (item.toolsAdded !== undefined) state.omitted.add("tool-definitions");
}

type RoleNormalizer = (
	item: JsonRecord,
	index: number,
	state: NormalizedContext,
) => void;

function normalizeUserItem(
	item: JsonRecord,
	_index: number,
	state: NormalizedContext,
) {
	normalizeUser(item, state.turns);
}

function normalizeAssistantItem(
	item: JsonRecord,
	_index: number,
	state: NormalizedContext,
) {
	state.turns.push(normalizeAssistant(item, state.omitted));
}

function normalizeToolItem(
	item: JsonRecord,
	_index: number,
	state: NormalizedContext,
) {
	state.turns.push(normalizeToolMessage(item));
}

const ROLE_NORMALIZERS = new Map<string, RoleNormalizer>([
	["system", normalizeSystemItem],
	["developer", normalizeSystemItem],
	["user", normalizeUserItem],
	["assistant", normalizeAssistantItem],
	["tool", normalizeToolItem],
	["toolResult", normalizeToolItem],
	["tool_result", normalizeToolItem],
]);

function normalizeItem(item: unknown, index: number, state: NormalizedContext) {
	if (typeof item === "string") {
		state.turns.push({ role: "user", text: item });
		return;
	}
	if (!isRecord(item)) return reject("malformed-message");
	assertItemCompleted(item);
	if (typeof item.role !== "string") {
		normalizeResponsesItem(item, state.turns, state.omitted);
		return;
	}
	const normalizeRole = ROLE_NORMALIZERS.get(item.role);
	if (!normalizeRole) return reject(`unsupported-role-${slug(item.role)}`);
	normalizeRole(item, index, state);
}

function normalizeContext(
	messages: unknown,
	topLevelSystem: unknown,
): NormalizedContext {
	const items = typeof messages === "string" ? [messages] : messages;
	if (!Array.isArray(items)) return reject("malformed-request-messages");
	if (topLevelSystem !== undefined && typeof topLevelSystem !== "string") {
		return reject("malformed-content");
	}
	const state: NormalizedContext = {
		system: topLevelSystem,
		turns: [],
		omitted: new Set<string>(),
	};
	items.forEach((item, index) => {
		normalizeItem(item, index, state);
	});
	return state;
}

interface PairingState {
	seen: Set<string>;
	pending: Map<string, string>;
}

type ToolTurn = Extract<Turn, { role: "tool" }>;

function answerToolCall(state: PairingState, turn: ToolTurn) {
	const name = state.pending.get(turn.callId);
	if (name === undefined) {
		return reject(
			state.seen.has(turn.callId)
				? "duplicate-tool-result"
				: "orphan-tool-result",
		);
	}
	if (turn.toolName !== undefined && turn.toolName !== name) {
		return reject("tool-name-mismatch");
	}
	state.pending.delete(turn.callId);
}

function openToolCalls(state: PairingState, calls: ToolCall[]) {
	for (const call of calls) {
		if (state.seen.has(call.id)) return reject("duplicate-tool-call-id");
		state.seen.add(call.id);
		state.pending.set(call.id, call.name);
	}
}

/** The context must end on something the final answer can respond to. */
function assertAnswerableEnd(turns: Turn[]) {
	const last = turns.at(-1);
	if (!last) return reject("no-turns");
	if (last.role === "assistant") return reject("context-ends-with-assistant");
	if (!turns.some((turn) => turn.role === "user")) reject("no-user-turn");
}

/** Every call is answered exactly once, by a matching result, before the next turn. */
function validateToolPairing(turns: Turn[]) {
	const state: PairingState = { seen: new Set(), pending: new Map() };
	for (const turn of turns) {
		if (turn.role === "tool") {
			answerToolCall(state, turn);
			continue;
		}
		if (state.pending.size > 0) return reject("unanswered-tool-call");
		if (turn.role === "assistant") openToolCalls(state, turn.calls);
	}
	if (state.pending.size > 0) reject("unanswered-tool-call");
	assertAnswerableEnd(turns);
}

// ---------------------------------------------------------------------------
// Target formats

function openAiAssistant(turn: Extract<Turn, { role: "assistant" }>) {
	if (turn.calls.length === 0) {
		return { role: "assistant", content: turn.text };
	}
	return {
		role: "assistant",
		content: turn.text === "" ? null : turn.text,
		tool_calls: turn.calls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.args) },
		})),
	};
}

function openAiMessage(turn: Turn, omitted: Set<string>): JsonRecord {
	if (turn.role === "user") return { role: "user", content: turn.text };
	if (turn.role === "assistant") return openAiAssistant(turn);
	// Chat Completions tool messages have no error flag.
	if (turn.isError) omitted.add("tool-error-flag");
	return { role: "tool", tool_call_id: turn.callId, content: turn.text };
}

function toOpenAiChat(context: NormalizedContext, finalText: string) {
	const messages: JsonRecord[] = [];
	if (context.system !== undefined) {
		messages.push({ role: "system", content: context.system });
	}
	for (const turn of context.turns) {
		messages.push(openAiMessage(turn, context.omitted));
	}
	messages.push({ role: "assistant", content: finalText });
	return { messages };
}

type PlainTurn = Exclude<Turn, ToolTurn>;

/** Consecutive tool results share one Anthropic user message. */
function groupToolResults(turns: Turn[]): Array<PlainTurn | ToolTurn[]> {
	const grouped: Array<PlainTurn | ToolTurn[]> = [];
	for (const turn of turns) {
		const last = grouped.at(-1);
		if (turn.role !== "tool") grouped.push(turn);
		else if (Array.isArray(last)) last.push(turn);
		else grouped.push([turn]);
	}
	return grouped;
}

function anthropicAssistantContent(turn: Extract<Turn, { role: "assistant" }>) {
	if (turn.calls.length === 0) return turn.text;
	return [
		...(turn.text === "" ? [] : [{ type: "text", text: turn.text }]),
		...turn.calls.map((call) => ({
			type: "tool_use",
			id: call.id,
			name: call.name,
			input: call.args,
		})),
	];
}

function anthropicMessage(entry: PlainTurn | ToolTurn[]): JsonRecord {
	if (Array.isArray(entry)) {
		// Results must sit in the user message right after their calls.
		return {
			role: "user",
			content: entry.map((result) => ({
				type: "tool_result",
				tool_use_id: result.callId,
				content: result.text,
				...(result.isError ? { is_error: true } : {}),
			})),
		};
	}
	if (entry.role === "user") return { role: "user", content: entry.text };
	return { role: "assistant", content: anthropicAssistantContent(entry) };
}

function toAnthropicMessages(context: NormalizedContext, finalText: string) {
	const messages = groupToolResults(context.turns).map(anthropicMessage);
	// Anthropic conversations must open with a user message.
	if (messages.slice(0, 1).some((first) => first.role !== "user")) {
		reject("anthropic-first-message-not-user");
	}
	messages.push({ role: "assistant", content: finalText });
	return {
		...(context.system === undefined ? {} : { system: context.system }),
		messages,
	};
}

interface ShareGptTurn {
	from: string;
	value: string;
}

function shareGptTurn(turn: Turn, previousFrom: string): ShareGptTurn {
	if (
		turn.role === "tool" ||
		(turn.role === "assistant" && turn.calls.length)
	) {
		return reject("sharegpt-tools-unsupported");
	}
	const from = turn.role === "user" ? "human" : "gpt";
	if (from === previousFrom) return reject("sharegpt-not-alternating");
	return { from, value: turn.text };
}

/**
 * ShareGPT has no canonical tool schema, so only text human/gpt
 * conversations are faithful; the system prompt travels in a top-level
 * `system` field rather than an invented role.
 */
function toShareGpt(context: NormalizedContext, finalText: string) {
	const conversations: ShareGptTurn[] = [];
	for (const turn of context.turns) {
		conversations.push(shareGptTurn(turn, conversations.at(-1)?.from ?? "gpt"));
	}
	conversations.push({ from: "gpt", value: finalText });
	return {
		...(context.system === undefined ? {} : { system: context.system }),
		conversations,
	};
}

function toFormat(
	format: TrainingFormat,
	context: NormalizedContext,
	finalText: string,
) {
	switch (format) {
		case "openai-chat":
			return toOpenAiChat(context, finalText);
		case "anthropic-messages":
			return toAnthropicMessages(context, finalText);
		case "sharegpt":
			return toShareGpt(context, finalText);
	}
}

// ---------------------------------------------------------------------------
// Sample selection

interface CaptureProvenance {
	verified: unknown[];
	degraded: JsonRecord;
}

function captureProvenance(
	record: JsonRecord,
	label: "request" | "response",
): CaptureProvenance {
	const provenance = record[RAW_CAPTURE_PROVENANCE_KEY];
	if (
		!isRecord(provenance) ||
		provenance.schema !== 1 ||
		!Array.isArray(provenance.verified) ||
		!isRecord(provenance.degraded)
	) {
		return reject(`${label}-capture-provenance-missing`);
	}
	return { verified: provenance.verified, degraded: provenance.degraded };
}

/**
 * The record must prove, from its own capture provenance, that every required
 * field was emitted complete, and that no optional context field was degraded.
 */
function requireCapture(
	record: JsonRecord,
	required: string[],
	guarded: string[],
	label: "request" | "response",
) {
	const provenance = captureProvenance(record, label);
	for (const key of [...required, ...guarded]) {
		const degraded = provenance.degraded[key];
		if (degraded !== undefined) {
			return reject(`${label}-capture-${slug(degraded)}`);
		}
	}
	for (const key of required) {
		if (provenance.verified.includes(key)) continue;
		return reject(
			record[key] === undefined
				? `${label}-${key}-missing`
				: `${label}-capture-provenance-missing`,
		);
	}
}

function assertSupportedRequestSource(source: unknown) {
	if (typeof source !== "string" || !SUPPORTED_REQUEST_SOURCES.has(source)) {
		return reject(`unsupported-request-source-${slug(source)}`);
	}
}

/** Cardinality recorded before shaping must match what survived it. */
function assertMessageCount(request: JsonRecord) {
	const count = Array.isArray(request.messages) ? request.messages.length : 1;
	if (request.messageCount !== count) {
		return reject("request-cardinality-mismatch");
	}
}

function assertCompleteRequest(request: JsonRecord) {
	if (request.captureMode !== "full") return reject("request-not-full-capture");
	// The provider continues stored state the record never observed, so the
	// captured items are not the full context. Nothing is looked up or rebuilt.
	if (request.serverSideContext !== undefined) {
		return reject("request-server-side-context");
	}
	assertSupportedRequestSource(request.requestSource);
	requireCapture(request, ["messages"], ["systemPrompt"], "request");
	assertMessageCount(request);
}

function assertCompleteResponse(response: JsonRecord) {
	// The ending is judged first: an aborted or errored answer is reported as
	// such, which is more useful than whatever else it lacks.
	if (response.stopReason !== "stop") {
		return reject(`stop-reason-${slug(response.stopReason)}`);
	}
	requireCapture(response, ["text", "toolCalls"], [], "response");
	if (!Array.isArray(response.toolCalls)) return reject("malformed-response");
	if (response.toolCalls.length > 0) {
		return reject("final-response-has-tool-calls");
	}
	if (typeof response.text !== "string" || response.text.trim() === "") {
		return reject("empty-final-response");
	}
}

function buildExample(
	request: RawLine,
	response: RawLine,
	format: TrainingFormat,
	source: string,
	declaration: TrainingDeclaration,
): TrainingExample {
	assertCompleteResponse(response.record);
	assertCompleteRequest(request.record);
	if (request.record.traceId !== response.record.traceId) {
		reject("trace-mismatch");
	}
	const context = normalizeContext(
		request.record.messages,
		request.record.systemPrompt,
	);
	validateToolPairing(context.turns);
	const finalText = response.record.text as string;
	if (
		typeof response.record.thinking === "string" &&
		response.record.thinking.length > 0
	) {
		context.omitted.add("reasoning");
	}
	const example = toFormat(format, context, finalText);
	const turnIndex = request.record.turnIndex as number;
	return {
		schema: "pi-langfuse.training-example/v1",
		format,
		id: createHash("sha256")
			.update(`${source}\0${request.line}\0${response.line}`)
			.digest("hex")
			.slice(0, 16),
		source: {
			path: source,
			requestLine: request.line,
			responseLine: response.line,
			turnIndex,
		},
		...(typeof request.record.provider === "string"
			? { provider: request.record.provider }
			: {}),
		...(typeof request.record.model === "string"
			? { model: request.record.model }
			: {}),
		consent: declaration.consent,
		license: declaration.license,
		omitted: [...context.omitted].sort(),
		notice: TRAINING_REVIEW_NOTICE,
		example,
	};
}

function parseSegments(content: string, rejections: TrainingRejection[]) {
	const segments: RawLine[][] = [[]];
	content.split(/\r?\n/).forEach((text, index) => {
		if (!text.trim()) return;
		const line = index + 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (!isRecord(parsed)) {
			// An unreadable record could be the missing half of a pair, so it
			// ends the segment instead of being skipped.
			rejections.push({ reason: "malformed-record", line });
			segments.push([]);
			return;
		}
		if (SEGMENT_BOUNDARY_TYPES.has(String(parsed.type))) {
			segments.push([]);
			return;
		}
		segments.at(-1)?.push({ line, record: parsed });
	});
	return segments;
}

const PAIRING_TYPES = new Set(["provider_request", "assistant_output"]);

type Pairing = { response: RawLine } | { reason: string; consumed: RawLine[] };

function recordsOfType(segment: RawLine[], type: string) {
	return segment.filter((entry) => entry.record.type === type);
}

function recordsOfTurn(segment: RawLine[], type: string, turn: unknown) {
	return recordsOfType(segment, type).filter(
		(entry) => entry.record.turnIndex === turn,
	);
}

/** The answer of the request's own turn, if the very next record is it. */
function pairRequest(segment: RawLine[], request: RawLine): Pairing {
	const turn = request.record.turnIndex;
	if (!Number.isInteger(turn)) {
		return { reason: "missing-turn-index", consumed: [] };
	}
	const answers = recordsOfTurn(segment, "assistant_output", turn);
	if (
		recordsOfTurn(segment, "provider_request", turn).length > 1 ||
		answers.length > 1
	) {
		return { reason: "ambiguous-turn", consumed: answers };
	}
	const next = segment
		.slice(segment.indexOf(request) + 1)
		.find((entry) => PAIRING_TYPES.has(String(entry.record.type)));
	if (
		next?.record.type !== "assistant_output" ||
		next.record.turnIndex !== turn
	) {
		return { reason: "no-matching-response", consumed: [] };
	}
	return { response: next };
}

function convertSegment(
	segment: RawLine[],
	options: ConvertOptions,
	conversion: TrainingConversion,
) {
	const consumed = new Set<RawLine>();
	for (const request of recordsOfType(segment, "provider_request")) {
		const pairing = pairRequest(segment, request);
		if ("response" in pairing) {
			consumed.add(pairing.response);
			convertPair(request, pairing.response, options, conversion);
			continue;
		}
		for (const response of pairing.consumed) consumed.add(response);
		conversion.rejections.push({ reason: pairing.reason, line: request.line });
	}
	for (const response of recordsOfType(segment, "assistant_output")) {
		if (consumed.has(response)) continue;
		conversion.rejections.push({
			reason: "orphan-response",
			line: response.line,
		});
	}
}

function convertPair(
	request: RawLine,
	response: RawLine,
	options: ConvertOptions,
	conversion: TrainingConversion,
) {
	try {
		conversion.examples.push(
			buildExample(
				request,
				response,
				options.format,
				options.source,
				options.declaration,
			),
		);
	} catch (error) {
		if (!(error instanceof SampleRejection)) throw error;
		conversion.rejections.push({ reason: error.reason, line: request.line });
	}
}

interface ConvertOptions {
	format: TrainingFormat;
	source: string;
	declaration: TrainingDeclaration;
}

/**
 * Convert one sanitized raw-trace file. Requests and answers pair only by
 * actual record boundaries: within one prompt segment, a request pairs with
 * the very next request-or-answer record when it is an answer of the same
 * turn. `turnIndex` resets across prompts and retries reuse it, so a turn
 * index that appears on more than one request or answer in a segment is
 * ambiguous and rejects every record involved instead of guessing chronology.
 */
export function convertRawTrace(
	content: string,
	options: ConvertOptions,
): TrainingConversion {
	const conversion: TrainingConversion = { examples: [], rejections: [] };
	for (const segment of parseSegments(content, conversion.rejections)) {
		convertSegment(segment, options, conversion);
	}
	return conversion;
}
