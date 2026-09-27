/**
 * Capture policy matrix: which content fields a policy captures, and the
 * per-field overrides. Summarizers and shapers both consult this module so a
 * field excluded here cannot survive inside flattened summary strings either.
 */

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

/** Capture-policy flags shared by the shaping config and the runtime config. */
export interface CapturePolicyConfig {
	capturePolicy?: CapturePolicy;
	capturePrompt?: boolean;
	captureSystemPrompt?: boolean;
	captureProviderInput?: boolean;
	captureAssistantOutput?: boolean;
	captureToolInput?: boolean;
	captureToolOutput?: boolean;
	captureMetadata?: boolean;
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

const OVERRIDE_KEYS: Record<CaptureField, keyof CapturePolicyConfig> = {
	prompt: "capturePrompt",
	systemPrompt: "captureSystemPrompt",
	providerInput: "captureProviderInput",
	assistantOutput: "captureAssistantOutput",
	toolInput: "captureToolInput",
	toolOutput: "captureToolOutput",
	metadata: "captureMetadata",
};

function policyFor(value: unknown): CapturePolicy {
	return typeof value === "string" &&
		CAPTURE_POLICIES.includes(value as CapturePolicy)
		? (value as CapturePolicy)
		: DEFAULT_CAPTURE_POLICY;
}

/**
 * Normalize an untrusted policy name; undefined means the value was not a
 * recognized policy (distinct from falling back to the default).
 */
export function normalizeCapturePolicy(
	value: unknown,
): CapturePolicy | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return CAPTURE_POLICIES.includes(normalized as CapturePolicy)
		? (normalized as CapturePolicy)
		: undefined;
}

/**
 * Whether a capture field is enabled. An explicit boolean override wins over
 * the policy preset; otherwise the policy's field table decides.
 */
export function isCaptureEnabled(
	config: CapturePolicyConfig,
	field: CaptureField,
): boolean {
	const override = config[OVERRIDE_KEYS[field]];
	if (typeof override === "boolean") return override;
	return POLICY_FIELDS[policyFor(config.capturePolicy)][field];
}
