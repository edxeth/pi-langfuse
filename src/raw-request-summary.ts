/**
 * Bounds of the compact provider-request summary written to raw traces.
 *
 * The summary is built before the writer shapes it (policy, identity, and
 * redaction), and shaping can make it longer: cutting a preview can expose a
 * secret-shaped token that the writer replaces with a longer marker. Both the
 * builder and the writer therefore enforce these bounds through
 * `fitRawRequestSummary`; the writer repeats shaping after every cut.
 *
 * This module has no runtime imports so both sides can share it without a
 * module cycle.
 */

export const RAW_REQUEST_SUMMARY_MAX_MESSAGES = 20;
const RAW_REQUEST_SUMMARY_MAX_PREVIEW_CHARS = 200;
/** UTF-8 budget of the serialized `{ systemPrompt, messagesSummary }` pair. */
const RAW_REQUEST_SUMMARY_MAX_BYTES = 4_096;

export type MessageSummary = { role: string; content: string };

/** The parts of one summary: kept messages, without the omission marker. */
export interface RawRequestSummaryParts {
	systemPrompt: string | undefined;
	messages: MessageSummary[];
	/** Messages of the request that the summary does not carry. */
	omitted: number;
}

const OMITTED_MARKER_PATTERN = /^\[(\d+) earlier message\(s\) omitted\]$/;

/** Cut text to the preview bound in code points, ending in an ellipsis. */
function rawSummaryPreview(text: string) {
	const characters = Array.from(text);
	return characters.length > RAW_REQUEST_SUMMARY_MAX_PREVIEW_CHARS
		? `${characters
				.slice(0, RAW_REQUEST_SUMMARY_MAX_PREVIEW_CHARS - 1)
				.join("")}…`
		: text;
}

/** The summary items as written: an omission marker, then the kept messages. */
export function rawSummaryItems({
	messages,
	omitted,
}: RawRequestSummaryParts): MessageSummary[] {
	return omitted > 0
		? [
				{ role: "system", content: `[${omitted} earlier message(s) omitted]` },
				...messages,
			]
		: [...messages];
}

function serializedBytes(parts: RawRequestSummaryParts) {
	return Buffer.byteLength(
		JSON.stringify({
			...(parts.systemPrompt !== undefined
				? { systemPrompt: parts.systemPrompt }
				: {}),
			messagesSummary: rawSummaryItems(parts),
		}),
		"utf-8",
	);
}

function cutMessagePreview(message: MessageSummary): MessageSummary {
	if (typeof message.content !== "string") return message;
	const content = rawSummaryPreview(message.content);
	return content === message.content ? message : { ...message, content };
}

function cutPreviews(parts: RawRequestSummaryParts): RawRequestSummaryParts {
	return {
		systemPrompt:
			parts.systemPrompt === undefined
				? undefined
				: rawSummaryPreview(parts.systemPrompt),
		messages: parts.messages.map(cutMessagePreview),
		omitted: parts.omitted,
	};
}

function dropOldestToFit(parts: RawRequestSummaryParts) {
	let fitted = parts;
	while (
		serializedBytes(fitted) > RAW_REQUEST_SUMMARY_MAX_BYTES &&
		fitted.messages.length > 0
	) {
		fitted = {
			...fitted,
			messages: fitted.messages.slice(1),
			omitted: fitted.omitted + 1,
		};
	}
	return fitted;
}

function isSameSummary(
	left: RawRequestSummaryParts,
	right: RawRequestSummaryParts,
) {
	return (
		left.systemPrompt === right.systemPrompt &&
		left.omitted === right.omitted &&
		left.messages.length === right.messages.length &&
		left.messages.every((message, index) => message === right.messages[index])
	);
}

/**
 * Cut every preview to its bound, then drop the oldest messages until the
 * serialized pair fits its byte budget. Returns the same object when nothing
 * had to change.
 */
export function fitRawRequestSummary(
	parts: RawRequestSummaryParts,
): RawRequestSummaryParts {
	const fitted = dropOldestToFit(cutPreviews(parts));
	return isSameSummary(fitted, parts) ? parts : fitted;
}

/** True for the summary form of a provider-request record. */
export function isRawRequestSummaryRecord(
	record: Record<string, unknown>,
): boolean {
	return (
		record.type === "provider_request" &&
		record.captureMode === "summary" &&
		Array.isArray(record.messagesSummary)
	);
}

/**
 * Parts of a shaped provider-request summary record. Items the writer's
 * policy emptied keep their place; a leading omission marker is regenerated
 * from the count instead of being kept as a message.
 */
function summaryParts(record: Record<string, unknown>): RawRequestSummaryParts {
	const items = record.messagesSummary as MessageSummary[];
	const first = items[0];
	const recorded =
		typeof record.messagesSummaryOmitted === "number"
			? record.messagesSummaryOmitted
			: 0;
	const hasMarker =
		first?.role === "system" &&
		typeof first.content === "string" &&
		OMITTED_MARKER_PATTERN.test(first.content);
	return {
		systemPrompt:
			typeof record.systemPrompt === "string" ? record.systemPrompt : undefined,
		messages: hasMarker ? items.slice(1) : items,
		omitted: recorded,
	};
}

/**
 * Enforce the summary bounds on a shaped record. Returns the same record when
 * it already fits; otherwise a record whose cut summary the caller must shape
 * again, because a cut can create text that shaping changes.
 */
export function boundRawRequestSummaryRecord<T extends Record<string, unknown>>(
	record: T,
): T {
	const parts = summaryParts(record);
	const fitted = fitRawRequestSummary(parts);
	if (fitted === parts) return record;
	return {
		...record,
		...(fitted.systemPrompt !== undefined
			? { systemPrompt: fitted.systemPrompt }
			: {}),
		messagesSummary: rawSummaryItems(fitted),
		messagesSummaryOmitted: fitted.omitted,
	};
}
