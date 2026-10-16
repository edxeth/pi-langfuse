import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { redactString, scanForSecrets } from "./redaction.js";

// Timing checks live apart from the behavior suites: they guard scan cost,
// not results, so the mutation gate's select list leaves this file out.
const config = {
	redactionEnabled: true,
	redactionAdditionalSecrets: ["manually-configured-secret"],
	secretKey: "sk-lf-test-secret-1234567890",
};

describe("redaction performance", () => {
	it("scales linearly on repeated sensitive-word input", () => {
		const time = (fn: () => unknown) => {
			const start = performance.now();
			fn();
			return performance.now() - start;
		};
		// Quoted hint shape, unquoted hint shape, and a benign control.
		const quoted18 = '"password" '.repeat(1636);
		const quoted72 = '"password" '.repeat(6545);
		const unquoted18 = "password_ ".repeat(1800);
		const unquoted72 = "password_ ".repeat(7200);
		// Quote-dense text whose quoted-key candidates all fail: the text inside
		// a failed candidate is scanned again as ordinary text, which must stay
		// linear. Each unit repeats to about 18 KB and 72 KB.
		const quoteDense = [
			'"a" ',
			"it's ",
			"'\"",
			'\\"a ',
			'"password ',
			'"password=abcdefghijkl ',
		].map((unit): [string, string] => [
			unit.repeat(Math.ceil(18_000 / unit.length)),
			unit.repeat(Math.ceil(72_000 / unit.length)),
		]);
		// One quote that opens a very long candidate, never closed.
		const longInterior: [string, string] = [
			`"${"password ".repeat(1800)}`,
			`"${"password ".repeat(7200)}`,
		];
		// A long chain of pairs that share their quotes.
		const sharedChain = (pairs: number): string =>
			`"password":"hunter2hunter2"${'token":"abcdefghijkl"'.repeat(pairs)}`;
		// Warm up and confirm benign text passes through unchanged.
		expect(redactString(config, quoted72, {})).toBe(quoted72);
		expect(redactString(config, unquoted72, {})).toBe(unquoted72);
		scanForSecrets(config, quoted72, {});
		scanForSecrets(config, unquoted72, {});

		for (const [small, large] of [
			[quoted18, quoted72],
			[unquoted18, unquoted72],
			...quoteDense,
			longInterior,
			[sharedChain(1000), sharedChain(4000)],
		]) {
			// A linear time on omitted text would prove nothing.
			expect(redactString(config, large, {})).not.toBe(
				"[REDACTED:suspicious-text]",
			);
			const smallRedact = time(() => redactString(config, small, {}));
			const largeRedact = time(() => redactString(config, large, {}));
			expect(largeRedact, `redact scaling ${large.length} bytes`).toBeLessThan(
				smallRedact * 10 + 250,
			);
			const smallScan = time(() => scanForSecrets(config, small, {}));
			const largeScan = time(() => scanForSecrets(config, large, {}));
			expect(largeScan, `scan scaling ${large.length} bytes`).toBeLessThan(
				smallScan * 10 + 250,
			);
		}
		// Strings that end with an assignment, each with a longer escape run, so
		// no later quote closes an earlier one. Deciding each string's close
		// must not rescan the rest of the text: about 35 times the bytes must
		// cost well under the 200 times that a size^1.5 scan would.
		const growingRuns = (pairs: number): string =>
			Array.from({ length: pairs }, (_, index) => {
				const quote = `${"\\".repeat(pairs + index)}"`;
				return `${quote}note password:${quote}, `;
			}).join("");
		const runsSmall = growingRuns(128);
		const runsLarge = growingRuns(768);
		scanForSecrets(config, runsSmall, {});
		const runsSmallScan = time(() => scanForSecrets(config, runsSmall, {}));
		const runsLargeScan = time(() => scanForSecrets(config, runsLarge, {}));
		expect(runsLargeScan, "growing escape runs").toBeLessThan(
			runsSmallScan * 60 + 250,
		);
		const benign72 = "ordinary ".repeat(8000);
		expect(time(() => redactString(config, benign72, {}))).toBeLessThan(500);
		expect(time(() => scanForSecrets(config, benign72, {}))).toBeLessThan(500);
	});
});
