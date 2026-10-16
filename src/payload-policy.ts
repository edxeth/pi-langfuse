import {
	allCaptureFieldsEnabled,
	CAPTURE_POLICIES,
	type CaptureField,
	type CapturePolicy,
	type CapturePolicyConfig,
	DEFAULT_CAPTURE_POLICY,
	isCaptureEnabled,
	normalizeCapturePolicy,
} from "./capture-policy.js";
import {
	isBinaryKey,
	isSensitiveKey,
	type RedactionConfig,
	sanitizeForTelemetry,
} from "./redaction.js";
import {
	RESPONSES_TOOL_CALL_ITEM_TYPES,
	RESPONSES_TOOL_OUTPUT_ITEM_TYPES,
} from "./telemetry-helpers.js";

export {
	CAPTURE_POLICIES,
	type CaptureField,
	type CapturePolicy,
	DEFAULT_CAPTURE_POLICY,
	isCaptureEnabled,
	normalizeCapturePolicy,
};

export interface PayloadPolicyConfig
	extends CapturePolicyConfig,
		RedactionConfig {
	payloadMaxStringChars?: number;
	payloadMaxToolChars?: number;
	payloadMaxDepth?: number;
	payloadMaxArrayItems?: number;
	payloadMaxObjectKeys?: number;
	payloadMaxNodes?: number;
}

export interface PayloadLimits {
	maxStringChars: number;
	maxToolChars: number;
	maxDepth: number;
	maxArrayItems: number;
	maxObjectKeys: number;
	maxNodes: number;
}

interface ShapeOptions {
	forceCapture?: boolean;
}

interface ShapeState {
	nodes: number;
	active: WeakSet<object>;
}

function sanitizeLimits(limits: PayloadLimits, field: CaptureField) {
	return {
		maxStringChars:
			field === "toolInput" || field === "toolOutput"
				? limits.maxToolChars
				: limits.maxStringChars,
		maxDepth: limits.maxDepth,
		maxArrayItems: limits.maxArrayItems,
		maxObjectKeys: limits.maxObjectKeys,
		maxNodes: limits.maxNodes,
	};
}

const OPAQUE_REPLAY_SIGNATURE_KEYS = new Set([
	"thoughtSignature",
	"textSignature",
	"thinkingSignature",
]);

function isOpaqueReplaySignatureKey(key: string) {
	return OPAQUE_REPLAY_SIGNATURE_KEYS.has(key);
}

const STRUCTURAL_KEYS = new Set([
	"type",
	"timestamp",
	"name",
	"id",
	"traceId",
	"parentObservationId",
	"sessionId",
	"turnIndex",
	"toolCallId",
	"provider",
	"model",
	"runtime",
	"redaction",
	"isError",
	"usage",
	"usageDetails",
	"costDetails",
	"modelParameters",
	"completionStartTime",
	"messageCount",
	"messagesSummaryOmitted",
	"estimatedBytes",
	"payloadCaptured",
	"captureMode",
	"fullMessagesOmitted",
	// Names of stored-context references; training export needs them whatever
	// the capture policy drops.
	"serverSideContext",
	"contentTruncated",
	"resultTruncated",
	"imgBlocks",
	"compactCount",
	"durationMs",
	"completed",
	"abandoned",
	"failed",
	"stopReason",
	"turns",
	"toolCalls",
	"toolErrors",
	"tokensIn",
	"tokensOut",
	"cacheRead",
	"cacheWrite",
	"messageModel",
	"sessionReason",
]);

function normalizedLimit(value: unknown, fallback: number) {
	if (value === Infinity) return Infinity;
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	if (value === Infinity) return Infinity;
	return Math.max(0, Math.floor(value));
}

export function getPayloadLimits(config: PayloadPolicyConfig): PayloadLimits {
	return {
		maxStringChars: normalizedLimit(config.payloadMaxStringChars, Infinity),
		maxToolChars: normalizedLimit(config.payloadMaxToolChars, Infinity),
		maxDepth: normalizedLimit(config.payloadMaxDepth, Infinity),
		maxArrayItems: normalizedLimit(config.payloadMaxArrayItems, Infinity),
		maxObjectKeys: normalizedLimit(config.payloadMaxObjectKeys, Infinity),
		maxNodes: normalizedLimit(config.payloadMaxNodes, Infinity),
	};
}

function boundedString(value: string, maxChars: number) {
	return Number.isFinite(maxChars) && value.length > maxChars
		? value.slice(0, maxChars)
		: value;
}

/** Tool content has its own character budget. */
function maxCharsFor(field: CaptureField, limits: PayloadLimits) {
	return field === "toolInput" || field === "toolOutput"
		? limits.maxToolChars
		: limits.maxStringChars;
}

function boundValue(
	value: unknown,
	field: CaptureField,
	limits: PayloadLimits,
	state: ShapeState,
	depth: number,
): unknown {
	if (state.nodes >= limits.maxNodes) return undefined;
	state.nodes += 1;

	if (typeof value === "string") {
		return boundedString(value, maxCharsFor(field, limits));
	}
	if (!value || typeof value !== "object") return value;
	if (depth >= limits.maxDepth) return "[TRUNCATED:depth]";
	if (state.active.has(value)) return "[Circular]";
	state.active.add(value);

	try {
		if (Array.isArray(value)) {
			const output: unknown[] = [];
			const itemLimit = Math.min(value.length, limits.maxArrayItems);
			for (let index = 0; index < itemLimit; index += 1) {
				if (state.nodes >= limits.maxNodes) break;
				const item = boundValue(value[index], field, limits, state, depth + 1);
				if (item !== undefined) output.push(item);
			}
			return output;
		}

		const output: Record<string, unknown> = {};
		const keys = Object.keys(value as Record<string, unknown>);
		const keyLimit = Math.min(keys.length, limits.maxObjectKeys);
		for (let index = 0; index < keyLimit; index += 1) {
			if (state.nodes >= limits.maxNodes) break;
			const key = keys[index];
			if (!key || isOpaqueReplaySignatureKey(key)) continue;
			const item = boundValue(
				(value as Record<string, unknown>)[key],
				field,
				limits,
				state,
				depth + 1,
			);
			if (item !== undefined) output[key] = item;
		}
		return output;
	} finally {
		state.active.delete(value);
	}
}

/**
 * `key` names the field that holds `value` when the caller knows it, so the
 * identity policy can recognize user and repository fields at any depth.
 */
function shapeValueWithState<T>(
	config: PayloadPolicyConfig,
	field: CaptureField,
	value: T,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
	key?: string,
): T | undefined {
	if (value === undefined) return undefined;
	if (!options.forceCapture && !isCaptureEnabled(config, field))
		return undefined;
	const sanitized = sanitizeForTelemetry(
		config,
		value,
		process.env,
		new WeakSet<object>(),
		sanitizeLimits(limits, field),
		key,
	);
	return boundValue(sanitized, field, limits, state, 0) as T | undefined;
}

export function shapeTelemetryValue<T>(
	config: PayloadPolicyConfig,
	field: CaptureField,
	value: T,
	options: ShapeOptions = {},
): T | undefined {
	return shapeValueWithState(
		config,
		field,
		value,
		options,
		getPayloadLimits(config),
		{ nodes: 0, active: new WeakSet<object>() },
	);
}

function shapeValueForKey<T>(
	config: PayloadPolicyConfig,
	key: string,
	field: CaptureField,
	value: T,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): T | undefined {
	if (isOpaqueReplaySignatureKey(key)) return undefined;
	if (
		(isSensitiveKey(key) || isBinaryKey(key)) &&
		(options.forceCapture || isCaptureEnabled(config, field))
	) {
		const sanitizedRecord = sanitizeForTelemetry(
			config,
			{ [key]: value },
			process.env,
			new WeakSet<object>(),
			sanitizeLimits(limits, field),
		) as Record<string, unknown>;
		// Identity normalization can rewrite the single key, so read by position.
		return boundValue(
			Object.values(sanitizedRecord)[0],
			field,
			limits,
			state,
			0,
		) as T | undefined;
	}
	return shapeValueWithState(config, field, value, options, limits, state, key);
}

/**
 * Message keys that describe the message or its correlation, not content the
 * role owns. They stay independent of the role's content policy (metadata
 * field); every other key of a role-bearing message is wrapper data.
 */
const MESSAGE_STRUCTURAL_KEYS = new Set([
	...STRUCTURAL_KEYS,
	"toolName",
	"customType",
	"display",
	"excludeFromContext",
	"exitCode",
	"cancelled",
	"truncated",
	"fromId",
	"tokensBefore",
	"api",
	"responseId",
	"errorMessage",
]);

/** Roles whose wrapper data is tool data (Pi `toolResult` and wire variants). */
function isToolResultRole(role: string) {
	return role === "tool" || role === "tool_result" || role === "toolResult";
}

const WRAPPER_OWNING_ROLES = new Set([
	"system",
	"user",
	"assistant",
	"model",
	"custom",
	"branchSummary",
	"compactionSummary",
	"bashExecution",
]);

/**
 * Field that owns a role's content-bearing wrapper data such as tool-result
 * `details`: the role's content field. Unroled items and unknown roles have no
 * owner and keep the metadata mapping.
 */
function wrapperDataField(role: string, key: string): CaptureField {
	if (isToolResultRole(role)) return "toolOutput";
	if (role === "bashExecution") {
		return key === "command" ? "toolInput" : "toolOutput";
	}
	if (WRAPPER_OWNING_ROLES.has(role)) return messageField(role, "content");
	return "metadata";
}

/** Capture field of a message's content by role; other roles are provider input. */
const CONTENT_FIELD_BY_ROLE: ReadonlyMap<string, CaptureField> = new Map([
	["system", "systemPrompt"],
	["user", "prompt"],
	["assistant", "assistantOutput"],
	["model", "assistantOutput"],
	["tool", "toolOutput"],
	["tool_result", "toolOutput"],
	["toolResult", "toolOutput"],
]);

function messageField(role: string, key: string): CaptureField {
	if (key === "content" || key === "parts") {
		return CONTENT_FIELD_BY_ROLE.get(role) ?? "providerInput";
	}
	// Pi system messages carry the prompt text in named sections; the
	// sections are system-prompt content, not metadata.
	if (key === "sections") {
		return role === "system" ? "systemPrompt" : "metadata";
	}
	if (key === "tool_calls" || key === "arguments") return "toolInput";
	if (MESSAGE_STRUCTURAL_KEYS.has(key)) return "metadata";
	return wrapperDataField(role, key);
}

/**
 * Field classification for unroled Responses input items. Role-bearing
 * messages keep the role-based mapping. Tool fields follow tool capture
 * policy; reasoning summaries follow assistant-output policy, while opaque
 * reasoning payloads remain excluded regardless of policy or overrides.
 */
function responsesItemField(
	itemType: string,
	key: string,
): CaptureField | "exclude" | undefined {
	if (itemType === "reasoning") {
		return reasoningItemField(key);
	}
	if (RESPONSES_TOOL_CALL_ITEM_TYPES.has(itemType)) {
		return toolCallItemField(key);
	}
	if (RESPONSES_TOOL_OUTPUT_ITEM_TYPES.has(itemType)) {
		return key === "output" ? "toolOutput" : undefined;
	}
	return undefined;
}

/** Tool-call request fields belong to tool-input capture. */
function toolCallItemField(key: string): CaptureField | undefined {
	return key === "arguments" || key === "input" ? "toolInput" : undefined;
}

/** Wire content-block types that carry tool-call request data. */
const TOOL_USE_BLOCK_TYPES = new Set(["tool_use", "toolCall"]);

/** Wire content-block types that carry tool result data. */
const TOOL_RESULT_BLOCK_TYPES = new Set(["tool_result"]);

/**
 * Wire content-block types that carry encrypted reasoning. Their opaque
 * payloads are never captured, like Responses encrypted reasoning and Google
 * thought parts; structural keys stay for correlation.
 */
const ENCRYPTED_REASONING_BLOCK_TYPES = new Set(["redacted_thinking"]);

/** Encrypted-reasoning payload keys that must never be captured. */
const ENCRYPTED_REASONING_DATA_KEYS = new Set(["data"]);

/** True for JSON objects other than arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Fields that hold role message content and can nest tool blocks. */
function isRoleContentField(field: CaptureField): boolean {
	return (
		field === "prompt" ||
		field === "systemPrompt" ||
		field === "assistantOutput" ||
		field === "toolOutput"
	);
}

/** Opaque reasoning payloads are excluded; item identity stays for correlation. */
function reasoningItemField(key: string): CaptureField | "exclude" | undefined {
	if (key === "summary") return "assistantOutput";
	if (key === "content" || key === "encrypted_content") return "exclude";
	return undefined;
}

function shapeProviderMessage(
	config: PayloadPolicyConfig,
	message: Record<string, unknown>,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): Record<string, unknown> | undefined {
	if (state.nodes >= limits.maxNodes) return undefined;
	state.nodes += 1;
	return shapeMessageEntries(config, message, options, limits, state);
}

/** Role-bearing chat messages carry role; unroled Responses items carry type. */
function messageKind(message: Record<string, unknown>) {
	const role = typeof message.role === "string" ? message.role : "";
	return {
		role,
		itemType:
			role === "" && typeof message.type === "string" ? message.type : "",
	};
}

/** Shape a provider message into its capture record: role plus classified keys. */
function shapeMessageEntries(
	config: PayloadPolicyConfig,
	message: Record<string, unknown>,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
) {
	const { role, itemType } = messageKind(message);
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(message)) {
		if (key === "role") {
			output.role = sanitizeForTelemetry(config, item);
			continue;
		}
		if (contentKeys >= limits.maxObjectKeys) break;
		const shaped = shapeMessageEntry(
			config,
			role,
			itemType,
			key,
			item,
			options,
			limits,
			state,
		);
		if (shaped === undefined) continue;
		output[key] = shaped;
		contentKeys += 1;
	}
	return output;
}

/** Shape one message content block: tool blocks follow tool capture policy. */
function shapeMessageContentBlock(
	config: PayloadPolicyConfig,
	defaultField: CaptureField,
	block: Record<string, unknown>,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): unknown {
	if (state.nodes >= limits.maxNodes) return undefined;
	state.nodes += 1;
	const blockType = typeof block.type === "string" ? block.type : "";
	const isToolUseBlock = TOOL_USE_BLOCK_TYPES.has(blockType);
	const isToolResultBlock = TOOL_RESULT_BLOCK_TYPES.has(blockType);
	const isEncryptedReasoningBlock =
		ENCRYPTED_REASONING_BLOCK_TYPES.has(blockType);
	// Google tool parts nest their data one level deeper than Anthropic
	// blocks: functionCall.args is tool input, functionResponse.response is
	// tool output.
	const googleToolPart = isRecord(block.functionCall)
		? {
				key: "functionCall" as const,
				dataKey: "args" as const,
				dataField: "toolInput" as CaptureField,
			}
		: isRecord(block.functionResponse)
			? {
					key: "functionResponse" as const,
					dataKey: "response" as const,
					dataField: "toolOutput" as CaptureField,
				}
			: undefined;
	// Google thought parts are model reasoning: never captured, regardless
	// of policy or overrides, like Responses reasoning items.
	if (
		!isToolUseBlock &&
		!isToolResultBlock &&
		!googleToolPart &&
		!isEncryptedReasoningBlock
	) {
		if (block.thought === true) return undefined;
		return shapeValueWithState(
			config,
			defaultField,
			block,
			options,
			limits,
			state,
		);
	}
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(block)) {
		if (state.nodes >= limits.maxNodes || contentKeys >= limits.maxObjectKeys)
			break;
		// Encrypted reasoning payloads are never captured, regardless of
		// policy or overrides; the block type stays for correlation.
		if (isEncryptedReasoningBlock && ENCRYPTED_REASONING_DATA_KEYS.has(key))
			continue;
		if (googleToolPart && key === googleToolPart.key) {
			if (!isRecord(item)) continue;
			const shapedPart = shapeGoogleToolPartData(
				config,
				item,
				googleToolPart.dataKey,
				googleToolPart.dataField,
				options,
				limits,
				state,
			);
			if (shapedPart === undefined) continue;
			output[key] = shapedPart;
			contentKeys += 1;
			continue;
		}
		const field = isToolUseBlock
			? (toolCallItemField(key) ?? "metadata")
			: isToolResultBlock
				? key === "content"
					? "toolOutput"
					: "metadata"
				: "metadata";
		const shaped = shapeValueForKey(
			config,
			key,
			field,
			item,
			options,
			limits,
			state,
		);
		if (shaped === undefined) continue;
		output[key] = shaped;
		contentKeys += 1;
	}
	return output;
}

/** Shape a Google functionCall/functionResponse payload's classified keys. */
function shapeGoogleToolPartData(
	config: PayloadPolicyConfig,
	data: Record<string, unknown>,
	contentKey: string,
	contentField: CaptureField,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): Record<string, unknown> | undefined {
	if (state.nodes >= limits.maxNodes) return undefined;
	state.nodes += 1;
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(data)) {
		if (state.nodes >= limits.maxNodes || contentKeys >= limits.maxObjectKeys)
			break;
		const field = key === contentKey ? contentField : "metadata";
		const shaped = shapeValueForKey(
			config,
			key,
			field,
			item,
			options,
			limits,
			state,
		);
		if (shaped === undefined) continue;
		output[key] = shaped;
		contentKeys += 1;
	}
	return output;
}

/**
 * Shape the content blocks of a role-bearing message. Recognized tool blocks
 * (Anthropic tool_use/tool_result) are classified per key so nested tool data
 * cannot bypass tool capture opt-outs; every other block keeps the enclosing
 * message's field.
 */
function shapeMessageContentBlocks(
	config: PayloadPolicyConfig,
	field: CaptureField,
	blocks: unknown[],
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): unknown[] {
	const output: unknown[] = [];
	const itemLimit = Math.min(blocks.length, limits.maxArrayItems);
	for (let index = 0; index < itemLimit; index += 1) {
		if (state.nodes >= limits.maxNodes) break;
		const block = blocks[index];
		const shaped =
			block && typeof block === "object" && !Array.isArray(block)
				? shapeMessageContentBlock(
						config,
						field,
						block as Record<string, unknown>,
						options,
						limits,
						state,
					)
				: shapeValueWithState(config, field, block, options, limits, state);
		if (shaped !== undefined) output.push(shaped);
	}
	return output;
}

/** Shape one non-role key of a provider message; undefined means dropped. */
function shapeMessageEntry(
	config: PayloadPolicyConfig,
	role: string,
	itemType: string,
	key: string,
	item: unknown,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
) {
	const itemField = itemType ? responsesItemField(itemType, key) : undefined;
	if (itemField === "exclude") return undefined;
	const field = itemField ?? messageField(role, key);
	if (field === "providerInput") {
		return shapeProviderInputValue(config, item, options, limits, state);
	}
	if (isRoleContentField(field) && Array.isArray(item)) {
		if (!options.forceCapture && !isCaptureEnabled(config, field))
			return undefined;
		return shapeMessageContentBlocks(
			config,
			field,
			item,
			options,
			limits,
			state,
		);
	}
	return shapeValueForKey(config, key, field, item, options, limits, state);
}

function shapeProviderInputValue<T>(
	config: PayloadPolicyConfig,
	value: T,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): T | undefined {
	if (
		!options.forceCapture &&
		!isCaptureEnabled(config, "providerInput") &&
		!isCaptureEnabled(config, "prompt") &&
		!isCaptureEnabled(config, "systemPrompt") &&
		!isCaptureEnabled(config, "assistantOutput") &&
		!isCaptureEnabled(config, "toolOutput")
	)
		return undefined;
	if (Array.isArray(value)) {
		const output: unknown[] = [];
		const itemLimit = Math.min(value.length, limits.maxArrayItems);
		for (let index = 0; index < itemLimit; index += 1) {
			const item = value[index];
			const shaped =
				item && typeof item === "object" && !Array.isArray(item)
					? shapeProviderMessage(
							config,
							item as Record<string, unknown>,
							options,
							limits,
							state,
						)
					: shapeValueWithState(
							config,
							"providerInput",
							item,
							options,
							limits,
							state,
						);
			if (shaped !== undefined) output.push(shaped);
			if (state.nodes >= limits.maxNodes) break;
		}
		return output as T;
	}
	if (!value || typeof value !== "object") {
		return shapeValueWithState(
			config,
			"providerInput",
			value,
			options,
			limits,
			state,
		);
	}
	const data = value as Record<string, unknown>;
	if (!Array.isArray(data.messages)) {
		return shapeValueWithState(
			config,
			"providerInput",
			value,
			options,
			limits,
			state,
		);
	}
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(data)) {
		if (contentKeys >= limits.maxObjectKeys) break;
		const shaped =
			key === "messages"
				? shapeProviderInputValue(config, item, options, limits, state)
				: shapeValueForKey(
						config,
						key,
						"providerInput",
						item,
						options,
						limits,
						state,
					);
		if (shaped !== undefined) {
			output[key] = shaped;
			contentKeys += 1;
		}
	}
	return output as T;
}

/** Assistant output keys, in shaping order, with the capture field each follows. */
const ASSISTANT_OUTPUT_FIELDS: ReadonlyArray<readonly [string, CaptureField]> =
	[
		["text", "assistantOutput"],
		["thinking", "assistantOutput"],
		["tool_calls", "toolInput"],
	];

/** A shaped object, kept when it has content or capture is forced. */
function presentOrForced(
	output: Record<string, unknown>,
	options: ShapeOptions,
) {
	return Object.keys(output).length > 0 || options.forceCapture
		? output
		: undefined;
}

function shapeAssistantOutput(
	config: PayloadPolicyConfig,
	value: Record<string, unknown>,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): Record<string, unknown> | undefined {
	const output: Record<string, unknown> = {};
	for (const [key, field] of ASSISTANT_OUTPUT_FIELDS) {
		if (!(key in value)) continue;
		const shaped = shapeValueForKey(
			config,
			key,
			field,
			value[key],
			options,
			limits,
			state,
		);
		if (shaped !== undefined) output[key] = shaped;
	}
	return presentOrForced(output, options);
}

/** A record that holds any key `shapeAssistantOutput` shapes. */
function isAssistantOutputRecord(
	value: unknown,
): value is Record<string, unknown> {
	return (
		isRecord(value) && ASSISTANT_OUTPUT_FIELDS.some(([key]) => key in value)
	);
}

function shapeFieldValue<T>(
	config: PayloadPolicyConfig,
	key: string,
	field: CaptureField,
	value: T,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): T | undefined {
	if (field === "assistantOutput" && isAssistantOutputRecord(value)) {
		return shapeAssistantOutput(config, value, options, limits, state) as
			| T
			| undefined;
	}
	return field === "providerInput"
		? shapeProviderInputValue(config, value, options, limits, state)
		: shapeValueForKey(config, key, field, value, options, limits, state);
}

function metadataField(key: string): CaptureField {
	switch (key) {
		case "systemPrompt":
			return "systemPrompt";
		case "providerPayload":
		case "payloadSummary":
			return "providerInput";
		case "argsSummary":
		case "inputSummary":
			return "toolInput";
		case "thinking":
			return "assistantOutput";
		case "contentSummary":
		case "resultSummary":
			return "toolOutput";
		default:
			return "metadata";
	}
}

function shapeMetadata(
	config: PayloadPolicyConfig,
	key: string,
	value: unknown,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return shapeValueWithState(
			config,
			"metadata",
			value,
			options,
			limits,
			state,
			key,
		);
	}

	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (state.nodes >= limits.maxNodes || contentKeys >= limits.maxObjectKeys)
			break;
		const field = metadataField(key);
		const shaped = shapeValueForKey(
			config,
			key,
			field,
			item,
			options,
			limits,
			state,
		);
		if (shaped !== undefined) {
			output[key] = shaped;
			contentKeys += 1;
		}
	}
	return presentOrForced(output, options);
}

/** Shape one record entry by its capture field; no field means plain sanitization. */
function shapeRecordEntry(
	config: PayloadPolicyConfig,
	key: string,
	item: unknown,
	field: CaptureField | undefined,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): unknown {
	if (field === "metadata") {
		return shapeMetadata(config, key, item, options, limits, state);
	}
	if (field) {
		return shapeFieldValue(config, key, field, item, options, limits, state);
	}
	return sanitizeForTelemetry(
		config,
		item,
		process.env,
		new WeakSet<object>(),
		undefined,
		key,
	);
}

function shapeRecord(
	config: PayloadPolicyConfig,
	value: Record<string, unknown>,
	fieldForKey: (key: string) => CaptureField | undefined,
	options: ShapeOptions,
	limits: PayloadLimits = getPayloadLimits(config),
) {
	const state: ShapeState = { nodes: 0, active: new WeakSet<object>() };
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(value)) {
		if (isOpaqueReplaySignatureKey(key)) continue;
		const field = fieldForKey(key);
		if (field !== undefined) {
			if (state.nodes >= limits.maxNodes) continue;
			if (contentKeys >= limits.maxObjectKeys) continue;
		}
		const shaped = shapeRecordEntry(
			config,
			key,
			item,
			field,
			options,
			limits,
			state,
		);
		if (shaped !== undefined) {
			output[key] = shaped;
			if (field !== undefined) contentKeys += 1;
		}
	}
	return output;
}

export function shapeLangfuseTraceBody<T extends Record<string, unknown>>(
	config: PayloadPolicyConfig,
	body: T,
): T {
	return shapeRecord(
		config,
		body,
		(key) => {
			if (key === "input") return "prompt";
			if (key === "output") return "assistantOutput";
			if (key === "metadata") return "metadata";
			if (STRUCTURAL_KEYS.has(key)) return undefined;
			return "metadata";
		},
		{},
	) as T;
}

function observationInputField(name: string): CaptureField {
	if (name.startsWith("tool:")) return "toolInput";
	if (name === "llm-response" || name === "agent.turn") return "providerInput";
	if (name === "agent.prompt") return "prompt";
	return "metadata";
}

function observationField(name: string, key: string): CaptureField | undefined {
	if (key === "metadata") return "metadata";
	if (key === "input") return observationInputField(name);
	if (key === "output") {
		return name.startsWith("tool:") ? "toolOutput" : "assistantOutput";
	}
	if (key === "statusMessage") return "metadata";
	if (STRUCTURAL_KEYS.has(key)) return undefined;
	return "metadata";
}

export function shapeLangfuseObservationBody<T extends Record<string, unknown>>(
	config: PayloadPolicyConfig,
	name: string,
	body: T,
): T {
	return shapeRecord(
		config,
		body,
		(key) => observationField(name, key),
		{},
	) as T;
}

/** Raw-record keys whose capture field does not depend on the record type. */
const RAW_FIELD_BY_KEY: ReadonlyMap<string, CaptureField> = new Map([
	["prompt", "prompt"],
	["systemPrompt", "systemPrompt"],
	["messages", "providerInput"],
	["messagesSummary", "providerInput"],
	["payloadSummary", "providerInput"],
	["inputSummary", "toolInput"],
	["text", "assistantOutput"],
	["thinking", "assistantOutput"],
	["contentSummary", "toolOutput"],
	["resultSummary", "toolOutput"],
]);

function rawField(type: string, key: string): CaptureField | undefined {
	if (key === "args" || key === "input" || key === "argsSummary") {
		return type.startsWith("tool_") || type === "tool_call"
			? "toolInput"
			: "providerInput";
	}
	return RAW_FIELD_BY_KEY.get(key);
}

/** Raw record types that carry the content a training sample is built from. */
const RAW_PROVENANCE_RECORD_TYPES: ReadonlySet<string> = new Set([
	"provider_request",
	"assistant_output",
]);

/** Key under which shaped raw records report their capture provenance. */
export const RAW_CAPTURE_PROVENANCE_KEY = "captureProvenance";

/**
 * Why a content field of a raw record was not captured completely:
 * `policy-omitted` when capture-policy fields dropped content, otherwise
 * `budget-truncated` when only the payload limits cut it.
 */
export type RawFieldDegradation = "policy-omitted" | "budget-truncated";

/**
 * Measured, not configured: what shaping did to each content field of one
 * raw record. A field is `verified` only when its emitted value equals the
 * value of the same shaping run with every capture field forced on and every
 * payload limit lifted, so neither the policy nor a budget removed content.
 * Redaction, identity normalization, and the unconditional removal of opaque
 * reasoning payloads apply to both runs and are not degradations.
 */
export interface RawCaptureProvenance {
	schema: 1;
	/** Top-level content fields emitted completely. */
	verified: string[];
	/** Top-level content fields present in the source but emitted degraded. */
	degraded: Record<string, RawFieldDegradation>;
}

const UNLIMITED_PAYLOAD_LIMITS: PayloadLimits = {
	maxStringChars: Infinity,
	maxToolChars: Infinity,
	maxDepth: Infinity,
	maxArrayItems: Infinity,
	maxObjectKeys: Infinity,
	maxNodes: Infinity,
};

function sameShapedValue(left: unknown, right: unknown) {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** The shaping runs one raw record's provenance is judged against. */
interface ProvenanceRuns {
	/** What was emitted. */
	actual: Record<string, unknown>;
	/** The same policy with every payload limit lifted. */
	unbounded: Record<string, unknown>;
	/** Every capture field forced on and every payload limit lifted. */
	reference: Record<string, unknown>;
}

function provenanceRuns(
	config: PayloadPolicyConfig,
	record: Record<string, unknown>,
	fieldForKey: (key: string) => CaptureField | undefined,
	actual: Record<string, unknown>,
): ProvenanceRuns {
	const limits = getPayloadLimits(config);
	const unlimited = Object.entries(limits).every(
		([, limit]) => limit === Infinity,
	);
	// Without a finite limit the actual run already is the unbounded one, and
	// with every capture field also enabled it is the reference too; any other
	// config needs the comparison runs.
	const unbounded = unlimited
		? actual
		: shapeRecord(config, record, fieldForKey, {}, UNLIMITED_PAYLOAD_LIMITS);
	const reference =
		unlimited && allCaptureFieldsEnabled(config)
			? actual
			: shapeRecord(
					config,
					record,
					fieldForKey,
					{ forceCapture: true },
					UNLIMITED_PAYLOAD_LIMITS,
				);
	return { actual, unbounded, reference };
}

/** Why one content field was degraded; undefined when it is verified. */
function fieldDegradation(
	key: string,
	{ actual, unbounded, reference }: ProvenanceRuns,
): RawFieldDegradation | undefined {
	if (reference === actual || sameShapedValue(actual[key], reference[key])) {
		return undefined;
	}
	return sameShapedValue(unbounded[key], reference[key])
		? "budget-truncated"
		: "policy-omitted";
}

function rawCaptureProvenance(
	config: PayloadPolicyConfig,
	record: Record<string, unknown>,
	fieldForKey: (key: string) => CaptureField | undefined,
	actual: Record<string, unknown>,
): RawCaptureProvenance {
	const runs = provenanceRuns(config, record, fieldForKey, actual);
	const provenance: RawCaptureProvenance = {
		schema: 1,
		verified: [],
		degraded: {},
	};
	for (const [key, item] of Object.entries(record)) {
		const field = fieldForKey(key);
		if (item === undefined || field === undefined || field === "metadata")
			continue;
		const degradation = fieldDegradation(key, runs);
		if (degradation) provenance.degraded[key] = degradation;
		else provenance.verified.push(key);
	}
	return provenance;
}

export function shapeRawTraceRecord<T extends Record<string, unknown>>(
	config: PayloadPolicyConfig,
	record: T,
): T {
	const type = String(record.type ?? "");
	const fieldForKey = (key: string) => {
		// Assistant output uses this name for argument-bearing calls; other
		// records keep the legacy structural call-count field.
		if (type === "assistant_output" && key === "toolCalls") return "toolInput";
		if (STRUCTURAL_KEYS.has(key)) return undefined;
		return rawField(type, key) ?? "metadata";
	};
	const shaped = shapeRecord(config, record, fieldForKey, {});
	if (!RAW_PROVENANCE_RECORD_TYPES.has(type)) return shaped as T;
	const withProvenance: Record<string, unknown> = {
		...shaped,
		[RAW_CAPTURE_PROVENANCE_KEY]: rawCaptureProvenance(
			config,
			record,
			fieldForKey,
			shaped,
		),
	};
	return withProvenance as T;
}

export function shapeExportValue<T>(config: PayloadPolicyConfig, value: T): T {
	return sanitizeForTelemetry(
		{ ...config, redactionEnabled: true },
		value,
	) as T;
}
