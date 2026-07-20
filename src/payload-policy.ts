import {
	isBinaryKey,
	isSensitiveKey,
	type RedactionConfig,
	sanitizeForTelemetry,
} from "./redaction.js";

export const DEFAULT_CAPTURE_POLICY = "full-debug" as const;

export const CAPTURE_POLICIES = [
	"metadata-only",
	"prompts-only",
	"conversations",
	"full-debug",
] as const;

export type CapturePolicy = (typeof CAPTURE_POLICIES)[number];

export type CaptureField =
	| "prompt"
	| "systemPrompt"
	| "providerInput"
	| "assistantOutput"
	| "toolInput"
	| "toolOutput"
	| "metadata";

export interface PayloadPolicyConfig extends RedactionConfig {
	capturePolicy?: CapturePolicy;
	capturePrompt?: boolean;
	captureSystemPrompt?: boolean;
	captureProviderInput?: boolean;
	captureAssistantOutput?: boolean;
	captureToolInput?: boolean;
	captureToolOutput?: boolean;
	captureMetadata?: boolean;
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

const POLICY_FIELDS: Record<CapturePolicy, Record<CaptureField, boolean>> = {
	"metadata-only": {
		prompt: false,
		systemPrompt: false,
		providerInput: false,
		assistantOutput: false,
		toolInput: false,
		toolOutput: false,
		metadata: true,
	},
	"prompts-only": {
		prompt: true,
		systemPrompt: true,
		providerInput: false,
		assistantOutput: false,
		toolInput: false,
		toolOutput: false,
		metadata: true,
	},
	conversations: {
		prompt: true,
		systemPrompt: true,
		providerInput: true,
		assistantOutput: true,
		toolInput: false,
		toolOutput: false,
		metadata: true,
	},
	"full-debug": {
		prompt: true,
		systemPrompt: true,
		providerInput: true,
		assistantOutput: true,
		toolInput: true,
		toolOutput: true,
		metadata: true,
	},
};

const OVERRIDE_KEYS: Record<CaptureField, keyof PayloadPolicyConfig> = {
	prompt: "capturePrompt",
	systemPrompt: "captureSystemPrompt",
	providerInput: "captureProviderInput",
	assistantOutput: "captureAssistantOutput",
	toolInput: "captureToolInput",
	toolOutput: "captureToolOutput",
	metadata: "captureMetadata",
};

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

function policyFor(value: unknown): CapturePolicy {
	return typeof value === "string" &&
		CAPTURE_POLICIES.includes(value as CapturePolicy)
		? (value as CapturePolicy)
		: DEFAULT_CAPTURE_POLICY;
}

export function normalizeCapturePolicy(
	value: unknown,
): CapturePolicy | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return CAPTURE_POLICIES.includes(normalized as CapturePolicy)
		? (normalized as CapturePolicy)
		: undefined;
}

export function isCaptureEnabled(
	config: PayloadPolicyConfig,
	field: CaptureField,
): boolean {
	const override = config[OVERRIDE_KEYS[field]];
	if (typeof override === "boolean") return override;
	return POLICY_FIELDS[policyFor(config.capturePolicy)][field];
}

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
	if (key === "content") {
		switch (role) {
			case "system":
				return "systemPrompt";
			case "user":
				return "prompt";
			case "assistant":
				return "assistantOutput";
			case "tool":
			case "tool_result":
				return "toolOutput";
			default:
				return "providerInput";
		}
	}
	if (key === "tool_calls" || key === "arguments") return "toolInput";
	return "metadata";
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
	const role = typeof message.role === "string" ? message.role : "";
	const output: Record<string, unknown> = {};
	let contentKeys = 0;
	for (const [key, item] of Object.entries(message)) {
		if (key === "role") {
			output.role = sanitizeForTelemetry(config, item);
			continue;
		}
		if (contentKeys >= limits.maxObjectKeys) break;
		const field = messageField(role, key);
		const shaped =
			field === "providerInput"
				? shapeProviderInputValue(config, item, options, limits, state)
				: shapeValueForKey(config, key, field, item, options, limits, state);
		if (shaped !== undefined) {
			output[key] = shaped;
			contentKeys += 1;
		}
	}
	return output;
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
