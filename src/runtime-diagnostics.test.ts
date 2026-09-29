import { describe, expect, it, vi } from "vitest";
import {
	getLastRuntimeError,
	recordRuntimeError,
	subscribeRuntimeErrors,
} from "./runtime-diagnostics.js";

describe("runtime diagnostics", () => {
	it("records failures without terminal output and notifies only active subscribers", () => {
		const messages: string[] = [];
		const warning = vi.spyOn(console, "warn");
		const unsubscribe = subscribeRuntimeErrors((error) => {
			messages.push(error.message);
		});
		try {
			recordRuntimeError(new Error("OTLP export returned HTTP 401"));
			expect(messages).toEqual(["OTLP export returned HTTP 401"]);
			expect(getLastRuntimeError()?.message).toBe(messages[0]);
			expect(warning).not.toHaveBeenCalled();
			unsubscribe();
			recordRuntimeError("later failure");
			expect(messages).toHaveLength(1);
			expect(getLastRuntimeError()?.message).toBe("later failure");
		} finally {
			unsubscribe();
			warning.mockRestore();
		}
	});

	it("contains a failed UI callback without hiding the diagnostic", () => {
		const unsubscribe = subscribeRuntimeErrors(() => {
			throw new Error("UI disposed");
		});
		try {
			expect(() => recordRuntimeError("export failed")).not.toThrow();
			expect(getLastRuntimeError()?.message).toBe("export failed");
		} finally {
			unsubscribe();
		}
	});
});
