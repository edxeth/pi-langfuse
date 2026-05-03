import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS,
	EXTENSION_ID,
	getSettingsValues,
	getStoredSettingsValues,
} from "./settings.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn(),
	};
});

describe("settings", () => {
	beforeEach(() => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("should return default settings when file does not exist", () => {
		const settings = getSettingsValues();
		expect(settings).toEqual(DEFAULT_SETTINGS);
	});

	it("should merge stored values with defaults", () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				"extensions:settings": {
					[EXTENSION_ID]: {
						enabled: false,
						"public-key": "test-key",
					},
				},
			}),
		);

		const settings = getSettingsValues();
		expect(settings.enabled).toBe(false);
		expect(settings["public-key"]).toBe("test-key");
		expect(settings["base-url"]).toBe(DEFAULT_SETTINGS["base-url"]);
	});

	it("should register settings with pi", async () => {
		const mockPi = {
			events: {
				emit: vi.fn(),
			},
		};
		const mod = await import("./settings.js");
		mod.registerSettings(mockPi as unknown as ExtensionAPI);
		expect(mockPi.events.emit).toHaveBeenCalledWith(
			"pi-extension-settings:register",
			expect.any(Object),
		);
	});

	it("should retrieve values via event if available", () => {
		const mockPi = {
			events: {
				emit: vi.fn((event, probe) => {
					if (event === "extension:settings:get") {
						probe.values = { enabled: false };
					}
				}),
			},
		};
		const values = getStoredSettingsValues(mockPi as unknown as ExtensionAPI);
		expect(values.enabled).toBe(false);
	});
});
