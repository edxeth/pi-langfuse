import { describe, expect, it } from "vitest";
import { addIndirectUsage, type PromptState } from "./lifecycle-types.js";

/** Only the totals `addIndirectUsage` reads and writes. */
function emptyTotals() {
	return {
		indirectTokensIn: 0,
		indirectTokensOut: 0,
		indirectCacheRead: 0,
		indirectCacheWrite: 0,
		indirectCost: 0,
	};
}

function accumulate(
	totals: ReturnType<typeof emptyTotals>,
	usage: Parameters<typeof addIndirectUsage>[1],
) {
	return addIndirectUsage(totals as unknown as PromptState, usage);
}

describe("indirect usage accumulation", () => {
	it("leaves the totals alone and reports nothing added when there is no usage", () => {
		const totals = emptyTotals();

		expect(accumulate(totals, undefined)).toBe(false);
		expect(totals).toEqual(emptyTotals());
	});

	it("adds input, cache reads and writes to input tokens, and tracks each part", () => {
		const totals = emptyTotals();

		const added = accumulate(totals, {
			input: 100,
			output: 20,
			cacheRead: 30,
			cacheWrite: 4,
			cost: { total: 0.25 },
		});

		expect(added).toBe(true);
		expect(totals).toEqual({
			indirectTokensIn: 134,
			indirectTokensOut: 20,
			indirectCacheRead: 30,
			indirectCacheWrite: 4,
			indirectCost: 0.25,
		});
	});

	it("accumulates across reports", () => {
		const totals = emptyTotals();

		accumulate(totals, { input: 10, output: 1, cost: { total: 0.5 } });
		accumulate(totals, {
			input: 5,
			cacheRead: 2,
			output: 3,
			cost: { total: 0.25 },
		});

		expect(totals).toEqual({
			indirectTokensIn: 17,
			indirectTokensOut: 4,
			indirectCacheRead: 2,
			indirectCacheWrite: 0,
			indirectCost: 0.75,
		});
	});

	it.each([
		["an empty report", {}],
		["a report with a cost that has no total", { cost: {} }],
	])("counts %s as zero without NaN", (_name, usage) => {
		const totals = emptyTotals();

		expect(accumulate(totals, usage)).toBe(true);
		expect(totals).toEqual(emptyTotals());
	});

	it("counts a report that only has output", () => {
		const totals = emptyTotals();

		accumulate(totals, { output: 7 });

		expect(totals).toEqual({ ...emptyTotals(), indirectTokensOut: 7 });
	});

	it("counts a report that only has cache writes as input", () => {
		const totals = emptyTotals();

		accumulate(totals, { cacheWrite: 9 });

		expect(totals).toEqual({
			...emptyTotals(),
			indirectTokensIn: 9,
			indirectCacheWrite: 9,
		});
	});
});
