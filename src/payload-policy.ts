import {
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
	"estimatedBytes",
	"payloadCaptured",
	"captureMode",
	"fullMessagesOmitted",
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
		return boundedString(
			value,
			field === "toolInput" || field === "toolOutput"
				? limits.maxToolChars
				: limits.maxStringChars,
		);
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
			if (!key) continue;
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

function shapeValueWithState<T>(
	config: PayloadPolicyConfig,
	field: CaptureField,
	value: T,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
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
		return boundValue(sanitizedRecord[key], field, limits, state, 0) as
			| T
			| undefined;
	}
	return shapeValueWithState(config, field, value, options, limits, state);
}

function messageField(role: string, key: string): CaptureField {
	if (key === "content" || key === "parts") {
		switch (role) {
			case "system":
				return "systemPrompt";
			case "user":
				return "prompt";
			case "assistant":
			case "model":
				return "assistantOutput";
			case "tool":
			case "tool_result":
			case "toolResult":
				return "toolOutput";
			default:
				return "providerInput";
		}
	}
	// Pi system messages carry the prompt text in named sections; the
	// sections are system-prompt content, not metadata.
	if (key === "sections") {
		return role === "system" ? "systemPrompt" : "metadata";
	}
	if (key === "tool_calls" || key === "arguments") return "toolInput";
	return "metadata";
}

/**
 * Field classification for unroled Responses input items. Role-bearing
 * messages keep the role-based mapping. Tool fields on these items follow
 * tool capture policy, and reasoning contents are excluded from capture
 * entirely — summaries and encrypted reasoning blobs are never persisted,
 * regardless of policy or overrides.
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

/** Reasoning contents are never captured; id/type stay for correlation. */
function reasoningItemField(key: string): CaptureField | "exclude" | undefined {
	if (key === "summary" || key === "content" || key === "encrypted_content") {
		return "exclude";
	}
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

function shapeFieldValue<T>(
	config: PayloadPolicyConfig,
	key: string,
	field: CaptureField,
	value: T,
	options: ShapeOptions,
	limits: PayloadLimits,
	state: ShapeState,
): T | undefined {
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
	return Object.keys(output).length > 0 || options.forceCapture
		? output
		: undefined;
}

function shapeRecord(
	config: PayloadPolicyConfig,
	value: Record<string, unknown>,
	fieldForKey: (key: string) => CaptureField | undefined,
	options: ShapeOptions,
) {
	const limits = getPayloadLimits(config);
	const state: ShapeState = { nodes: 0, active: new WeakSet<object>() };
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(value)) {
		const field = fieldForKey(key);
		if (field !== undefined) {
			if (state.nodes >= limits.maxNodes) continue;
			if (contentKeys >= limits.maxObjectKeys) continue;
		}
		const shaped =
			field === "metadata"
				? shapeMetadata(config, item, options, limits, state)
				: field
					? shapeFieldValue(config, key, field, item, options, limits, state)
					: sanitizeForTelemetry(config, item);
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

function observationField(name: string, key: string): CaptureField | undefined {
	if (key === "metadata") return "metadata";
	if (key === "input") {
		if (name.startsWith("tool:")) return "toolInput";
		if (name === "llm-response") return "providerInput";
		if (name === "agent.prompt") return "prompt";
		return "metadata";
	}
	if (key === "output") {
		if (name.startsWith("tool:")) return "toolOutput";
		return "assistantOutput";
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

function rawField(type: string, key: string): CaptureField | undefined {
	if (key === "prompt") return "prompt";
	if (key === "systemPrompt") return "systemPrompt";
	if (
		key === "messages" ||
		key === "messagesSummary" ||
		key === "payloadSummary"
	)
		return "providerInput";
	if (key === "args" || key === "input" || key === "argsSummary")
		return type.startsWith("tool_") || type === "tool_call"
			? "toolInput"
			: "providerInput";
	if (key === "inputSummary") return "toolInput";
	if (key === "text") return "assistantOutput";
	if (key === "thinking") return "assistantOutput";
	if (key === "contentSummary" || key === "resultSummary") return "toolOutput";
	return undefined;
}

export function shapeRawTraceRecord<T extends Record<string, unknown>>(
	config: PayloadPolicyConfig,
	record: T,
): T {
	return shapeRecord(
		config,
		record,
		(key) => {
			if (STRUCTURAL_KEYS.has(key)) return undefined;
			return rawField(String(record.type ?? ""), key) ?? "metadata";
		},
		{},
	) as T;
}

export function shapeExportValue<T>(config: PayloadPolicyConfig, value: T): T {
	return sanitizeForTelemetry(
		{ ...config, redactionEnabled: true },
		value,
	) as T;
}
