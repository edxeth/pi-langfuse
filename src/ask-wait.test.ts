import { describe, expect, it } from "vitest";
import {
	type AskFlowState,
	describeAskFlow,
	parseCancelReason,
	summarizeAskWait,
} from "./ask-wait.js";

/**
 * Contract: a dialog-wait is the union of the flows' open intervals, so
 * overlapping flows count once (documented on `AskWaitSummary.waitMs`).
 */
function flow(
	flowId: string,
	startedAt?: number,
	completedAt?: number,
	extra: Partial<AskFlowState> = {},
): AskFlowState {
	return {
		flowId,
		toolCallId: `tool-${flowId}`,
		startedAt,
		completedAt,
		...extra,
	};
}

describe("dialog wait of a set of flows", () => {
	it("counts overlapping flows once, whatever the order they arrive in", () => {
		const later = flow("a", 100, 200);
		const earlier = flow("b", 0, 150);

		expect(summarizeAskWait([later, earlier])).toMatchObject({
			status: "measured",
			waitMs: 200,
			flowCount: 2,
		});
		expect(summarizeAskWait([earlier, later])?.waitMs).toBe(200);
	});

	it("counts a flow nested inside another flow once", () => {
		const outer = flow("outer", 0, 100);
		const inner = flow("inner", 10, 20);
		const apart = flow("apart", 300, 340);

		expect(summarizeAskWait([apart, inner, outer])?.waitMs).toBe(140);
	});

	it("adds up flows that do not overlap, and counts touching flows without a gap", () => {
		expect(
			summarizeAskWait([flow("a", 0, 10), flow("b", 10, 25), flow("c", 40, 45)])
				?.waitMs,
		).toBe(30);
	});

	it("measures a flow that opened and closed at the same instant as zero", () => {
		expect(summarizeAskWait([flow("a", 50, 50)])).toMatchObject({
			status: "measured",
			waitMs: 0,
			incompleteFlowCount: 0,
		});
	});

	it("keeps the open time of a cancelled flow", () => {
		expect(
			summarizeAskWait([flow("a", 0, 40, { cancelled: true })]),
		).toMatchObject({ waitMs: 40, cancelledFlowCount: 1 });
	});

	it.each([
		["a flow that never started", flow("a", undefined, 10)],
		["a flow that never completed", flow("a", 10, undefined)],
		["a flow that completed before it started", flow("a", 20, 10)],
	])("reports %s as incomplete, with no duration", (_name, incomplete) => {
		const summary = summarizeAskWait([flow("ok", 0, 5), incomplete]);

		expect(summary).toMatchObject({
			status: "incomplete",
			flowCount: 2,
			incompleteFlowCount: 1,
		});
		expect(summary?.waitMs).toBeUndefined();
	});

	it("reports an ambiguous flow instead of a duration, and nothing when nothing was seen", () => {
		expect(summarizeAskWait([flow("ok", 0, 5)], 1)).toMatchObject({
			status: "ambiguous",
			ambiguousFlowCount: 1,
		});
		expect(summarizeAskWait([], 2)).toMatchObject({ status: "ambiguous" });
		expect(summarizeAskWait([])).toBeUndefined();
	});
});

describe("single flow description", () => {
	it("gives a measured flow its duration", () => {
		expect(
			describeAskFlow(flow("a", 10, 35, { source: "bridge", cancelled: true })),
		).toMatchObject({
			flowId: "a",
			source: "bridge",
			status: "measured",
			durationMs: 25,
			cancelled: true,
		});
	});

	it("gives an unfinished flow no duration", () => {
		expect(describeAskFlow(flow("a", 10, undefined))).toMatchObject({
			status: "incomplete",
			durationMs: undefined,
		});
	});
});

describe("cancel reasons", () => {
	it.each(["user", "aborted", "ui_unavailable", "invalid_input"])(
		"accepts the pi-ask reason %s",
		(reason) => {
			expect(parseCancelReason(reason)).toBe(reason);
		},
	);

	it.each(["", "timeout", 3, null, undefined])(
		"ignores %j, which pi-ask does not report",
		(value) => {
			expect(parseCancelReason(value)).toBeUndefined();
		},
	);
});
