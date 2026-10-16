import { describe, expect, it } from "vitest";
import {
	boundRawRequestSummaryRecord,
	fitRawRequestSummary,
	isRawRequestSummaryRecord,
	type MessageSummary,
	rawSummaryItems,
} from "./raw-request-summary.js";

const SUMMARY_MAX_BYTES = 4_096;
const PREVIEW_MAX_CHARS = 200;

function bytesOf(systemPrompt: string | undefined, items: unknown[]) {
	return Buffer.byteLength(
		JSON.stringify({
			...(systemPrompt === undefined ? {} : { systemPrompt }),
			messagesSummary: items,
		}),
		"utf-8",
	);
}

const longMessage = (index: number) => ({
	role: "user",
	content: `${index}:${"x".repeat(400)}`,
});

describe("raw request summary bounds", () => {
	it("recognizes only the summary form of a provider request", () => {
		const summary = {
			type: "provider_request",
			captureMode: "summary",
			messagesSummary: [],
		};

		expect(isRawRequestSummaryRecord(summary)).toBe(true);
		expect(isRawRequestSummaryRecord({ ...summary, captureMode: "full" })).toBe(
			false,
		);
		expect(
			isRawRequestSummaryRecord({ ...summary, type: "assistant_output" }),
		).toBe(false);
		expect(
			isRawRequestSummaryRecord({ ...summary, messagesSummary: "none" }),
		).toBe(false);
	});

	it("keeps the summary items as written, with an omission marker only when messages were omitted", () => {
		const messages = [{ role: "user", content: "hi" }];

		expect(
			rawSummaryItems({ messages, omitted: 0, systemPrompt: undefined }),
		).toEqual(messages);
		expect(
			rawSummaryItems({ messages, omitted: 3, systemPrompt: undefined }),
		).toEqual([
			{ role: "system", content: "[3 earlier message(s) omitted]" },
			...messages,
		]);
	});

	it("returns the same object when the summary already fits", () => {
		const parts = {
			systemPrompt: "be brief",
			messages: [{ role: "user", content: "short" }],
			omitted: 0,
		};

		expect(fitRawRequestSummary(parts)).toBe(parts);
	});

	it("cuts long previews, then drops the oldest messages until the pair fits", () => {
		const messages = Array.from({ length: 30 }, (_, index) =>
			longMessage(index),
		);

		const fitted = fitRawRequestSummary({
			systemPrompt: "s".repeat(500),
			messages,
			omitted: 2,
		});

		expect(Array.from(fitted.systemPrompt ?? "")).toHaveLength(
			PREVIEW_MAX_CHARS,
		);
		expect(fitted.systemPrompt?.endsWith("…")).toBe(true);
		expect(fitted.messages.length).toBeLessThan(30);
		// The newest messages survive; the dropped ones are counted, on top of
		// the omissions the request already recorded.
		expect(fitted.messages.at(-1)?.content.startsWith("29:")).toBe(true);
		expect(fitted.omitted).toBe(2 + (30 - fitted.messages.length));
		expect(
			bytesOf(fitted.systemPrompt, rawSummaryItems(fitted)),
		).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
		for (const message of fitted.messages) {
			expect(Array.from(message.content).length).toBeLessThanOrEqual(
				PREVIEW_MAX_CHARS,
			);
		}
	});

	it("leaves non-text message content untouched while cutting the rest", () => {
		const opaque = { role: "user", content: 42 as unknown as string };
		const fitted = fitRawRequestSummary({
			systemPrompt: undefined,
			messages: [opaque, longMessage(1)],
			omitted: 0,
		});

		expect(fitted.messages[0]).toBe(opaque);
		expect(Array.from(fitted.messages[1]?.content ?? "")).toHaveLength(
			PREVIEW_MAX_CHARS,
		);
	});

	it("counts a record without a recorded omission count from zero", () => {
		// The bounded record gains the omission count the input never had.
		const record: {
			type: string;
			captureMode: string;
			messagesSummary: MessageSummary[];
			messagesSummaryOmitted?: number;
		} = {
			type: "provider_request",
			captureMode: "summary",
			messagesSummary: Array.from({ length: 30 }, (_, index) =>
				longMessage(index),
			),
		};

		const bounded = boundRawRequestSummaryRecord(record);

		const kept = bounded.messagesSummary.length - 1;
		expect(bounded.messagesSummaryOmitted).toBe(30 - kept);
		expect(bounded.messagesSummary[0]).toEqual({
			role: "system",
			content: `[${30 - kept} earlier message(s) omitted]`,
		});
		expect(bounded).not.toHaveProperty("systemPrompt");
	});

	it("regenerates an existing omission marker from the recorded count instead of keeping it as a message", () => {
		const record = {
			type: "provider_request",
			captureMode: "summary",
			systemPrompt: "be brief",
			messagesSummary: [
				{ role: "system", content: "[7 earlier message(s) omitted]" },
				...Array.from({ length: 30 }, (_, index) => longMessage(index)),
			],
			messagesSummaryOmitted: 7,
		};

		const bounded = boundRawRequestSummaryRecord(record);

		const kept = bounded.messagesSummary.length - 1;
		expect(bounded.messagesSummaryOmitted).toBe(7 + (30 - kept));
		expect(bounded.messagesSummary[0]?.content).toBe(
			`[${7 + (30 - kept)} earlier message(s) omitted]`,
		);
		expect(bounded.systemPrompt).toBe("be brief");
		expect(
			bounded.messagesSummary.filter((item) =>
				item.content.includes("earlier message(s) omitted"),
			),
		).toHaveLength(1);
	});

	it("returns the same record when it already fits", () => {
		const record = {
			type: "provider_request",
			captureMode: "summary",
			messagesSummary: [{ role: "user", content: "short" }],
			messagesSummaryOmitted: 0,
		};

		expect(boundRawRequestSummaryRecord(record)).toBe(record);
	});
});

describe("raw request summary exact bounds", () => {
	const message = (content: string, role = "user"): MessageSummary => ({
		role,
		content,
	});
	const fitParts = (messages: MessageSummary[], systemPrompt?: string) =>
		fitRawRequestSummary({ systemPrompt, messages, omitted: 0 });

	it("keeps a preview of exactly the bound and cuts one character more with an ellipsis", () => {
		const exact = message("é".repeat(PREVIEW_MAX_CHARS));
		const one = fitParts([exact]);
		const over = fitParts([message("é".repeat(PREVIEW_MAX_CHARS + 1))]);

		expect(one.messages[0]).toBe(exact);
		expect(over.messages[0]?.content).toBe(
			`${"é".repeat(PREVIEW_MAX_CHARS - 1)}…`,
		);
		expect(fitParts([], "s".repeat(PREVIEW_MAX_CHARS + 1)).systemPrompt).toBe(
			`${"s".repeat(PREVIEW_MAX_CHARS - 1)}…`,
		);
	});

	it("writes an omission marker only when messages were omitted", () => {
		const kept = [message("kept")];

		expect(
			rawSummaryItems({ systemPrompt: undefined, messages: kept, omitted: 0 }),
		).toEqual(kept);
		expect(
			rawSummaryItems({ systemPrompt: undefined, messages: kept, omitted: 1 }),
		).toEqual([
			{ role: "system", content: "[1 earlier message(s) omitted]" },
			...kept,
		]);
	});

	/** Messages whose serialized summary is exactly `target` bytes. */
	function messagesOfSize(target: number) {
		const messages: MessageSummary[] = [];
		const bytes = () => bytesOf(undefined, messages);
		while (bytes() + 131 <= target) messages.push(message("a".repeat(100)));
		let missing = target - bytes();
		for (let index = messages.length - 1; missing > 0; index -= 1) {
			const room = Math.min(missing, PREVIEW_MAX_CHARS - 100);
			messages[index] = message("a".repeat(100 + room));
			missing -= room;
		}
		return messages;
	}

	it("keeps a summary of exactly the byte budget and drops the oldest message for one byte more", () => {
		const exact = messagesOfSize(SUMMARY_MAX_BYTES);
		expect(bytesOf(undefined, exact)).toBe(SUMMARY_MAX_BYTES);
		const parts = { systemPrompt: undefined, messages: exact, omitted: 0 };

		expect(fitRawRequestSummary(parts)).toBe(parts);

		const over = [...exact];
		const last = over.length - 1;
		over[last] = message(`${over[last]?.content}a`);
		expect(bytesOf(undefined, over)).toBe(SUMMARY_MAX_BYTES + 1);
		const fitted = fitRawRequestSummary({ ...parts, messages: over });
		expect(fitted.omitted).toBe(1);
		expect(fitted.messages).toEqual(over.slice(1));
	});

	it("drops even the last message when its role alone exceeds the byte budget", () => {
		const fitted = fitParts([
			message("short", "r".repeat(SUMMARY_MAX_BYTES + 100)),
		]);

		expect(fitted.messages).toEqual([]);
		expect(fitted.omitted).toBe(1);
		expect(
			bytesOf(fitted.systemPrompt, rawSummaryItems(fitted)),
		).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
	});

	it.each([
		[
			"a user message that looks like a marker",
			message("[3 earlier message(s) omitted]", "user"),
		],
		["a system message that is not a marker", message("be brief", "system")],
	])("keeps %s as a message when it leads a summary", (_name, first) => {
		const record = {
			type: "provider_request",
			captureMode: "summary",
			messagesSummary: [first, message("x".repeat(500))],
			messagesSummaryOmitted: 0,
		};

		const bounded = boundRawRequestSummaryRecord(record);

		expect(bounded.messagesSummary).toHaveLength(2);
		expect(bounded.messagesSummary[0]).toEqual(first);
		expect(bounded.messagesSummaryOmitted).toBe(0);
	});
});
