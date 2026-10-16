/**
 * Dialog-flow timing observed through pi-ask's `pi-ask:started` and
 * `pi-ask:completed` events.
 *
 * A flow is one open ask dialog. Its interval is the time between the two
 * events, not the whole `ask_user` tool span (which also covers setup and
 * result handling), and not proof of human participation: pi-ask lets a
 * trusted local bridge answer or cancel a flow remotely. Only correlation,
 * timing, and cancellation metadata are kept; questions and answers never
 * enter this state.
 */

/** Why pi-ask reports a flow as cancelled (`AskResult.cancelReason`). */
export type AskFlowCancelReason =
	| "user"
	| "aborted"
	| "ui_unavailable"
	| "invalid_input";

/**
 * Metadata of one pi-ask dialog flow, merged from its started and completed
 * events. A timestamp stays undefined until an event supplies a valid one.
 */
export interface AskFlowState {
	flowId: string;
	/** The Pi tool call that owns the flow; flows without one are not attributable. */
	toolCallId: string;
	source?: string;
	/** First valid `createdAt` of a `pi-ask:started` event for this flow. */
	startedAt?: number;
	/** First valid `completedAt` of a `pi-ask:completed` event for this flow. */
	completedAt?: number;
	cancelled?: boolean;
	cancelReason?: AskFlowCancelReason;
}

/**
 * Completeness of a dialog-wait measurement.
 *
 * `measured`: every observed flow has a valid start and end.
 * `incomplete`: some flow lacks its start or end event, or has an end before its start.
 * `ambiguous`: an event for a flow could belong to more than one session.
 */
export type AskWaitStatus = "measured" | "incomplete" | "ambiguous";

/** Outcome of the dialog-wait measurement for one prompt or one tool. */
export interface AskWaitSummary {
	/** Whether the measurement is complete; see {@link AskWaitStatus}. */
	status: AskWaitStatus;
	/** Union of the dialog intervals in ms; present only when `status` is `measured`. */
	waitMs?: number;
	/** Flows attributed to the owner. */
	flowCount: number;
	/** Attributed flows without a valid start and end. */
	incompleteFlowCount: number;
	/** Flows whose events matched several sessions and carry no timing. */
	ambiguousFlowCount: number;
	/** Attributed flows that ended cancelled; their open time still counts. */
	cancelledFlowCount: number;
}

const CANCEL_REASONS: readonly AskFlowCancelReason[] = [
	"user",
	"aborted",
	"ui_unavailable",
	"invalid_input",
];

/** Return `value` when it is a known pi-ask cancel reason, otherwise undefined. */
export function parseCancelReason(
	value: unknown,
): AskFlowCancelReason | undefined {
	return CANCEL_REASONS.find((reason) => reason === value);
}

function flowInterval(flow: AskFlowState): [number, number] | undefined {
	const { startedAt, completedAt } = flow;
	if (startedAt === undefined || completedAt === undefined) return undefined;
	return completedAt >= startedAt ? [startedAt, completedAt] : undefined;
}

/** Total length of the union of the intervals, so overlapping flows count once. */
function unionDurationMs(intervals: Array<[number, number]>) {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
	let total = 0;
	let currentEnd = Number.NEGATIVE_INFINITY;
	for (const [start, end] of sorted) {
		const from = Math.max(start, currentEnd);
		if (end > from) total += end - from;
		currentEnd = Math.max(currentEnd, end);
	}
	return total;
}

interface FlowTally {
	intervals: Array<[number, number]>;
	flowCount: number;
	incompleteFlowCount: number;
	cancelledFlowCount: number;
}

function tallyFlows(flows: Iterable<AskFlowState>): FlowTally {
	const tally: FlowTally = {
		intervals: [],
		flowCount: 0,
		incompleteFlowCount: 0,
		cancelledFlowCount: 0,
	};
	for (const flow of flows) {
		tally.flowCount += 1;
		if (flow.cancelled) tally.cancelledFlowCount += 1;
		const interval = flowInterval(flow);
		if (interval) tally.intervals.push(interval);
		else tally.incompleteFlowCount += 1;
	}
	return tally;
}

function askWaitStatus(
	incompleteFlowCount: number,
	ambiguousFlowCount: number,
): AskWaitStatus {
	if (ambiguousFlowCount > 0) return "ambiguous";
	return incompleteFlowCount > 0 ? "incomplete" : "measured";
}

/**
 * Summarize the flows attributed to one owner. Returns undefined when nothing
 * was observed, so "no pi-ask instrumentation" stays distinct from a measured
 * zero.
 */
export function summarizeAskWait(
	flows: Iterable<AskFlowState>,
	ambiguousFlowCount = 0,
): AskWaitSummary | undefined {
	const tally = tallyFlows(flows);
	if (tally.flowCount === 0 && ambiguousFlowCount === 0) return undefined;
	const status = askWaitStatus(tally.incompleteFlowCount, ambiguousFlowCount);
	return {
		status,
		waitMs:
			status === "measured" ? unionDurationMs(tally.intervals) : undefined,
		flowCount: tally.flowCount,
		incompleteFlowCount: tally.incompleteFlowCount,
		ambiguousFlowCount,
		cancelledFlowCount: tally.cancelledFlowCount,
	};
}

/** Describe one flow for tool-span metadata; contains no question or answer content. */
export function describeAskFlow(flow: AskFlowState) {
	const interval = flowInterval(flow);
	return {
		flowId: flow.flowId,
		source: flow.source,
		status: interval ? "measured" : "incomplete",
		durationMs: interval ? interval[1] - interval[0] : undefined,
		cancelled: flow.cancelled,
		cancelReason: flow.cancelReason,
	};
}
