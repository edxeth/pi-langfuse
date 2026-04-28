import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const EXTENSION_ID = "pi-langfuse";
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
const EXTENSIONS_SETTINGS_KEY = "extensions:settings";

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
};

export const SETTINGS_DOCUMENTATION = `# Langfuse settings

These settings control how the Langfuse extension connects to your Langfuse project.

## Notes

- Settings entered here are stored in plain text by pi-extension-settings.
- If you prefer not to store keys here, keep using config.json or environment variables.
- Resolution order is: settings panel -> config.json -> environment variables -> defaults.
- When a setting is empty, this panel shows the live fallback value currently resolved from config.json, environment variables, or built-in defaults.
- Tag lists are comma-separated.
- Character limits are bounded to sensible minimums/maximums during config resolution.
`;

export function createSettingsNodes(defaults: SettingsValues) {
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
				"Langfuse public key. Empty means use config.json/env fallback shown here.",
			default: defaults["public-key"],
		},
		"secret-key": {
			_tag: "text",
			label: "Secret Key",
			description:
				"Langfuse secret key. Empty means use config.json/env fallback shown here.",
			default: defaults["secret-key"],
		},
		"base-url": {
			_tag: "text",
			label: "Base URL",
			description:
				"Langfuse base URL. Empty means use config.json/env fallback shown here.",
			default: defaults["base-url"],
		},
		"user-id": {
			_tag: "text",
			label: "User ID Override",
			description:
				"Optional fixed user ID. Empty means use config.json/env fallback shown here.",
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
	} as const;
}

function loadSettingsFile(): Record<string, Record<string, unknown>> {
	if (!existsSync(SETTINGS_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<
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
	const dir = dirname(SETTINGS_FILE);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let fullContent: Record<string, unknown> = {};
	if (existsSync(SETTINGS_FILE)) {
		try {
			fullContent = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<
				string,
				unknown
			>;
		} catch {
			fullContent = {};
		}
	}

	fullContent[EXTENSIONS_SETTINGS_KEY] = values;
	writeFileSync(
		SETTINGS_FILE,
		`${JSON.stringify(fullContent, null, 2)}\n`,
		"utf-8",
	);
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
