import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS,
	EXTENSION_ID,
	getSettingsValues,
	getStoredSettingsValues,
	setSettingsValues,
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
		vi.mocked(fs.readFileSync).mockClear();
		vi.mocked(fs.writeFileSync).mockClear();
		vi.mocked(fs.mkdirSync).mockClear();
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

	it("should merge written values with unrelated existing preferences", () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				theme: "dark",
				"extensions:settings": { "other-ext": { keep: true } },
			}),
		);

		setSettingsValues({ enabled: false });

		expect(fs.writeFileSync).toHaveBeenCalledOnce();
		const written = JSON.parse(
			vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
		);
		expect(written.theme).toBe("dark");
		expect(written["extensions:settings"]["other-ext"]).toEqual({ keep: true });
		expect(written["extensions:settings"][EXTENSION_ID]).toEqual({
			enabled: false,
		});
	});

	it("should refuse the write and keep original bytes when settings.json is malformed", () => {
		const malformed = '{"theme":"dark","packages":{,,,}';
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(malformed);

		let message = "";
		try {
			setSettingsValues({ enabled: false });
		} catch (error) {
			message = String((error as Error).message);
		}

		expect(message).toContain("settings.json");
		expect(message).toContain("not valid JSON");
		expect(fs.writeFileSync).not.toHaveBeenCalled();
		// The only read was the parse attempt; no write ever rewrote the file.
		expect(
			vi
				.mocked(fs.readFileSync)
				.mock.results.every((r) => r.value === malformed),
		).toBe(true);
	});

	it("should refuse non-object JSON documents with actionable errors", () => {
		const nonObjects = ["[]", "42", "null", '"just a string"'];
		for (const raw of nonObjects) {
			vi.mocked(fs.writeFileSync).mockClear();
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(raw);

			let message = "";
			try {
				setSettingsValues({ enabled: false });
			} catch (error) {
				message = String((error as Error).message);
			}

			expect(message).toContain("settings.json");
			expect(message).toContain("JSON object");
			expect(fs.writeFileSync).not.toHaveBeenCalled();
		}
	});
});
