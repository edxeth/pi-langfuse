import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapturePolicy } from "./payload-policy.js";

export const EXTENSION_ID = "pi-langfuse";
const EXTENSIONS_SETTINGS_KEY = "extensions:settings";

export type CaptureOverrideSetting = "inherit" | "on" | "off";
export type PayloadLimitSetting = number | "unlimited";

function settingsFile() {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"settings.json",
	);
}

export interface SettingsValues {
	enabled: boolean;
	"public-key": string;
	"secret-key": string;
	"base-url": string;
	"user-id": string;
	"default-tags": string;
	release: string;
	environment: string;
	"trace-input-max-chars": number;
	"trace-output-max-chars": number;
	"tool-args-max-chars": number;
	"tool-output-max-chars": number;
	"capture-tool-progress": boolean;
	"capture-message-updates": boolean;
	"capture-policy"?: CapturePolicy;
	"capture-prompt"?: CaptureOverrideSetting | boolean;
	"capture-system-prompt"?: CaptureOverrideSetting | boolean;
	"capture-provider-input"?: CaptureOverrideSetting | boolean;
	"capture-assistant-output"?: CaptureOverrideSetting | boolean;
	"capture-tool-input"?: CaptureOverrideSetting | boolean;
	"capture-tool-output"?: CaptureOverrideSetting | boolean;
	"capture-metadata"?: CaptureOverrideSetting | boolean;
	"payload-max-string-chars"?: PayloadLimitSetting;
	"payload-max-tool-chars"?: PayloadLimitSetting;
	"payload-max-depth"?: PayloadLimitSetting;
	"payload-max-array-items"?: PayloadLimitSetting;
	"payload-max-object-keys"?: PayloadLimitSetting;
	"payload-max-nodes"?: PayloadLimitSetting;
	"redaction-enabled": boolean;
	"raw-trace-enabled": boolean;
	"raw-trace-dir": string;
}

export const DEFAULT_SETTINGS: SettingsValues = {
	enabled: true,
	"public-key": "",
	"secret-key": "",
	"base-url": "https://cloud.langfuse.com",
	"user-id": "",
	"default-tags": "",
	release: "",
	environment: "",
	"trace-input-max-chars": 2000,
	"trace-output-max-chars": 2000,
	"tool-args-max-chars": 500,
	"tool-output-max-chars": 2000,
	"capture-tool-progress": true,
	"capture-message-updates": false,
	"capture-policy": "full-debug",
	"capture-prompt": "inherit",
	"capture-system-prompt": "inherit",
	"capture-provider-input": "inherit",
	"capture-assistant-output": "inherit",
	"capture-tool-input": "inherit",
	"capture-tool-output": "inherit",
	"capture-metadata": "inherit",
	"payload-max-string-chars": "unlimited",
	"payload-max-tool-chars": "unlimited",
	"payload-max-depth": "unlimited",
	"payload-max-array-items": "unlimited",
	"payload-max-object-keys": "unlimited",
	"payload-max-nodes": "unlimited",
	"redaction-enabled": true,
	"raw-trace-enabled": false,
	"raw-trace-dir": "",
};

const SETTINGS_DOCUMENTATION = `# Langfuse settings

These settings control how the Langfuse extension connects to your Langfuse project.

## Notes

- Settings entered here are stored in plain text by pi-extension-settings.
- If you prefer not to store keys here, keep using pi-langfuse.json or environment variables.
- Resolution order is: settings panel -> pi-langfuse.json -> environment variables -> defaults.
- When a setting is empty, this panel shows the live fallback value currently resolved from pi-langfuse.json, environment variables, or built-in defaults.
- Tag lists are comma-separated.
- Character limits and payload budgets are bounded during config resolution; use \`unlimited\` for an explicit unlimited budget.
- Secret redaction is enabled by default. Disable it only for explicit local debugging.
`;

function createSettingsNodes(defaults: SettingsValues) {
	return {
		enabled: {
			_tag: "boolean",
			label: "Enabled",
			description: "Enable Langfuse tracing.",
			default: defaults.enabled,
		},
		"public-key": {
			_tag: "text",
			label: "Public Key",
			description:
				"Langfuse public key. Empty means use pi-langfuse.json/env fallback shown here.",
			default: defaults["public-key"],
		},
		"secret-key": {
			_tag: "text",
			label: "Secret Key",
			description:
				"Langfuse secret key. Empty means use pi-langfuse.json/env fallback shown here.",
			default: defaults["secret-key"],
		},
		"base-url": {
			_tag: "text",
			label: "Base URL",
			description:
				"Langfuse base URL. Empty means use pi-langfuse.json/env fallback shown here.",
			default: defaults["base-url"],
		},
		"user-id": {
			_tag: "text",
			label: "User ID Override",
			description:
				"Optional fixed user ID. Empty means use pi-langfuse.json/env fallback shown here.",
			default: defaults["user-id"],
		},
		"default-tags": {
			_tag: "text",
			label: "Default Tags",
			description: "Optional comma-separated tags added to every trace.",
			default: defaults["default-tags"],
		},
		release: {
			_tag: "text",
			label: "Release",
			description: "Optional release name/version (e.g. v1.0.0).",
			default: defaults.release,
		},
		environment: {
			_tag: "text",
			label: "Environment",
			description: "Optional environment name (e.g. production, staging).",
			default: defaults.environment,
		},
		"trace-input-max-chars": {
			_tag: "number",
			label: "Trace Input Max Chars",
			description: "Maximum prompt/input characters recorded in Langfuse.",
			default: defaults["trace-input-max-chars"],
		},
		"trace-output-max-chars": {
			_tag: "number",
			label: "Trace Output Max Chars",
			description: "Maximum assistant/output characters recorded in Langfuse.",
			default: defaults["trace-output-max-chars"],
		},
		"tool-args-max-chars": {
			_tag: "number",
			label: "Tool Args Max Chars",
			description: "Maximum tool argument summary length recorded in Langfuse.",
			default: defaults["tool-args-max-chars"],
		},
		"tool-output-max-chars": {
			_tag: "number",
			label: "Tool Output Max Chars",
			description: "Maximum tool output summary length recorded in Langfuse.",
			default: defaults["tool-output-max-chars"],
		},
		"capture-tool-progress": {
			_tag: "boolean",
			label: "Capture Tool Progress",
			description: "Record partial tool_execution_update output in Langfuse.",
			default: defaults["capture-tool-progress"],
		},
		"capture-message-updates": {
			_tag: "boolean",
			label: "Capture Message Updates",
			description:
				"Reserved for future streaming assistant update capture. Currently stored but not used.",
			default: defaults["capture-message-updates"],
		},
		"capture-policy": {
			_tag: "text",
			label: "Capture Policy",
			description:
				"Choose metadata-only, prompts-only, conversations, or full-debug. The default full-debug policy preserves current capture behavior.",
			default: defaults["capture-policy"],
		},
		"capture-prompt": {
			_tag: "text",
			label: "Capture User Prompt",
			description:
				"Use inherit, on, or off to override the selected policy for user prompt text.",
			default: defaults["capture-prompt"],
		},
		"capture-system-prompt": {
			_tag: "text",
			label: "Capture System Prompt",
			description:
				"Use inherit, on, or off to override the selected policy for system prompt text.",
			default: defaults["capture-system-prompt"],
		},
		"capture-provider-input": {
			_tag: "text",
			label: "Capture Provider Input",
			description:
				"Use inherit, on, or off to override provider request message capture.",
			default: defaults["capture-provider-input"],
		},
		"capture-assistant-output": {
			_tag: "text",
			label: "Capture Assistant Output",
			description:
				"Use inherit, on, or off to override assistant output capture.",
			default: defaults["capture-assistant-output"],
		},
		"capture-tool-input": {
			_tag: "text",
			label: "Capture Tool Input",
			description:
				"Use inherit, on, or off to override tool names, arguments, and inputs.",
			default: defaults["capture-tool-input"],
		},
		"capture-tool-output": {
			_tag: "text",
			label: "Capture Tool Output",
			description:
				"Use inherit, on, or off to override tool results and progress.",
			default: defaults["capture-tool-output"],
		},
		"capture-metadata": {
			_tag: "text",
			label: "Capture Metadata",
			description:
				"Use inherit, on, or off to override trace and observation metadata.",
			default: defaults["capture-metadata"],
		},
		"payload-max-string-chars": {
			_tag: "text",
			label: "Payload Max String Chars",
			description: "Maximum ordinary payload string length, or unlimited.",
			default: defaults["payload-max-string-chars"],
		},
		"payload-max-tool-chars": {
			_tag: "text",
			label: "Payload Max Tool Chars",
			description: "Maximum tool payload string length, or unlimited.",
			default: defaults["payload-max-tool-chars"],
		},
		"payload-max-depth": {
			_tag: "text",
			label: "Payload Max Depth",
			description: "Maximum nested payload depth, or unlimited.",
			default: defaults["payload-max-depth"],
		},
		"payload-max-array-items": {
			_tag: "text",
			label: "Payload Max Array Items",
			description: "Maximum items kept from each payload array, or unlimited.",
			default: defaults["payload-max-array-items"],
		},
		"payload-max-object-keys": {
			_tag: "text",
			label: "Payload Max Object Keys",
			description: "Maximum keys kept from each payload object, or unlimited.",
			default: defaults["payload-max-object-keys"],
		},
		"payload-max-nodes": {
			_tag: "text",
			label: "Payload Max Nodes",
			description: "Maximum total payload nodes, or unlimited.",
			default: defaults["payload-max-nodes"],
		},
		"redaction-enabled": {
			_tag: "boolean",
			label: "Secret Redaction",
			description:
				"Redact known secrets and common token patterns before writing Langfuse or raw trace payloads. Disable only for explicit local debugging.",
			default: defaults["redaction-enabled"],
		},
		"raw-trace-enabled": {
			_tag: "boolean",
			label: "Raw Trace Export",
			description:
				"Write redacted JSONL companion traces for audit/training workflows.",
			default: defaults["raw-trace-enabled"],
		},
		"raw-trace-dir": {
			_tag: "string",
			label: "Raw Trace Directory",
			description:
				"Directory for raw trace JSONL files. Leave empty to use the default ~/.pi/agent/langfuse/raw-traces path.",
			default: defaults["raw-trace-dir"],
		},
	} as const;
}

function loadSettingsFile(): Record<string, Record<string, unknown>> {
	const file = settingsFile();
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<
			string,
			unknown
		>;
		const extensionSettings = parsed[EXTENSIONS_SETTINGS_KEY];
		return typeof extensionSettings === "object" && extensionSettings !== null
			? (extensionSettings as Record<string, Record<string, unknown>>)
			: {};
	} catch {
		return {};
	}
}

function saveSettingsFile(values: Record<string, Record<string, unknown>>) {
	const file = settingsFile();
	const dir = dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let fullContent: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			fullContent = JSON.parse(readFileSync(file, "utf-8")) as Record<
				string,
				unknown
			>;
		} catch {
			fullContent = {};
		}
	}

	fullContent[EXTENSIONS_SETTINGS_KEY] = values;
	writeFileSync(file, `${JSON.stringify(fullContent, null, 2)}\n`, "utf-8");
}

export function getStoredSettingsValues(
	pi?: ExtensionAPI,
): Partial<SettingsValues> {
	const probe = { id: EXTENSION_ID, values: undefined as unknown };
	if (pi) {
		pi.events.emit("extension:settings:get", probe);
		if (probe.values && typeof probe.values === "object") {
			return probe.values as Partial<SettingsValues>;
		}
	}

	const allValues = loadSettingsFile();
	return (allValues[EXTENSION_ID] ?? {}) as Partial<SettingsValues>;
}

export function getSettingsValues(pi?: ExtensionAPI): SettingsValues {
	const values = getStoredSettingsValues(pi);
	return {
		enabled: values.enabled ?? DEFAULT_SETTINGS.enabled,
		"public-key": values["public-key"] ?? DEFAULT_SETTINGS["public-key"],
		"secret-key": values["secret-key"] ?? DEFAULT_SETTINGS["secret-key"],
		"base-url": values["base-url"] ?? DEFAULT_SETTINGS["base-url"],
		"user-id": values["user-id"] ?? DEFAULT_SETTINGS["user-id"],
		"default-tags": values["default-tags"] ?? DEFAULT_SETTINGS["default-tags"],
		release: values.release ?? DEFAULT_SETTINGS.release,
		environment: values.environment ?? DEFAULT_SETTINGS.environment,
		"trace-input-max-chars":
			values["trace-input-max-chars"] ??
			DEFAULT_SETTINGS["trace-input-max-chars"],
		"trace-output-max-chars":
			values["trace-output-max-chars"] ??
			DEFAULT_SETTINGS["trace-output-max-chars"],
		"tool-args-max-chars":
			values["tool-args-max-chars"] ?? DEFAULT_SETTINGS["tool-args-max-chars"],
		"tool-output-max-chars":
			values["tool-output-max-chars"] ??
			DEFAULT_SETTINGS["tool-output-max-chars"],
		"capture-tool-progress":
			values["capture-tool-progress"] ??
			DEFAULT_SETTINGS["capture-tool-progress"],
		"capture-message-updates":
			values["capture-message-updates"] ??
			DEFAULT_SETTINGS["capture-message-updates"],
		"capture-policy":
			values["capture-policy"] ?? DEFAULT_SETTINGS["capture-policy"],
		"capture-prompt":
			values["capture-prompt"] ?? DEFAULT_SETTINGS["capture-prompt"],
		"capture-system-prompt":
			values["capture-system-prompt"] ??
			DEFAULT_SETTINGS["capture-system-prompt"],
		"capture-provider-input":
			values["capture-provider-input"] ??
			DEFAULT_SETTINGS["capture-provider-input"],
		"capture-assistant-output":
			values["capture-assistant-output"] ??
			DEFAULT_SETTINGS["capture-assistant-output"],
		"capture-tool-input":
			values["capture-tool-input"] ?? DEFAULT_SETTINGS["capture-tool-input"],
		"capture-tool-output":
			values["capture-tool-output"] ?? DEFAULT_SETTINGS["capture-tool-output"],
		"capture-metadata":
			values["capture-metadata"] ?? DEFAULT_SETTINGS["capture-metadata"],
		"payload-max-string-chars":
			values["payload-max-string-chars"] ??
			DEFAULT_SETTINGS["payload-max-string-chars"],
		"payload-max-tool-chars":
			values["payload-max-tool-chars"] ??
			DEFAULT_SETTINGS["payload-max-tool-chars"],
		"payload-max-depth":
			values["payload-max-depth"] ?? DEFAULT_SETTINGS["payload-max-depth"],
		"payload-max-array-items":
			values["payload-max-array-items"] ??
			DEFAULT_SETTINGS["payload-max-array-items"],
		"payload-max-object-keys":
			values["payload-max-object-keys"] ??
			DEFAULT_SETTINGS["payload-max-object-keys"],
		"payload-max-nodes":
			values["payload-max-nodes"] ?? DEFAULT_SETTINGS["payload-max-nodes"],
		"redaction-enabled":
			values["redaction-enabled"] ?? DEFAULT_SETTINGS["redaction-enabled"],
		"raw-trace-enabled":
			values["raw-trace-enabled"] ?? DEFAULT_SETTINGS["raw-trace-enabled"],
		"raw-trace-dir":
			values["raw-trace-dir"] ?? DEFAULT_SETTINGS["raw-trace-dir"],
	};
}

export function setSettingsValues(nextValues: Partial<SettingsValues>) {
	const allValues = loadSettingsFile();
	allValues[EXTENSION_ID] = {
		...(allValues[EXTENSION_ID] ?? {}),
		...nextValues,
	};
	saveSettingsFile(allValues);
}

export function registerSettings(
	pi: ExtensionAPI,
	defaults: SettingsValues = DEFAULT_SETTINGS,
) {
	pi.events.emit("pi-extension-settings:register", {
		extension: EXTENSION_ID,
		nodes: createSettingsNodes(defaults),
		documentation: SETTINGS_DOCUMENTATION,
	});
}
