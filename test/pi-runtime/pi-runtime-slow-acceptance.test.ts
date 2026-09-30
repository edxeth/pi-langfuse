import { afterEach, describe, expect, it } from "vitest";
import { flushClient, shutdownClient } from "../../src/langfuse-client.js";
import { subscribeRuntimeErrors } from "../../src/runtime-diagnostics.js";
import { createRuntimeCase, type RuntimeCase } from "./isolated-pi.js";
import { decodeOtlpPayload, spansByName } from "./otlp.js";

let activeCase: RuntimeCase | undefined;

afterEach(async () => {
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
});

describe("pi runtime slow OTLP acceptance on production timeouts", () => {
	it("accepts delayed exports without timeout warnings at prompt settlement", async () => {
		// No timeout overrides: short test budgets would hide the production
		// regression. Pi and Langfuse both use isolated, local test boundaries.
		const runtimeCase = await createRuntimeCase({
			name: "slow-acceptance",
			provider: { kind: "faux" },
		});
		activeCase = runtimeCase;
		const { recorder, session, piAi, faux } = runtimeCase;
		if (!faux) throw new Error("Expected isolated faux provider");
		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxText("slow acceptance answer")]),
		]);
		recorder.faults.acceptanceDelayMs = 2_500;

		const errors: string[] = [];
		const unsubscribe = subscribeRuntimeErrors(({ message }) => {
			errors.push(message);
		});
		try {
			await session.prompt("slow acceptance prompt");
			await session.waitForIdle();
			expect(errors).toEqual([]);
			// Pi may resolve the prompt before notification-only settlement
			// handlers finish. Drain their exports before inspecting acceptance.
			await flushClient();
			expect(errors).toEqual([]);
			expect(recorder.postsTotal).toBe(3);
			expect(recorder.postsAccepted).toBe(3);
			expect(recorder.postsRejected).toBe(0);
			const spans = recorder
				.acceptedPosts()
				.flatMap((record) => decodeOtlpPayload(record.body));
			expect(spans).toHaveLength(3);
			const byName = spansByName(spans);
			const root = byName["agent.prompt"]?.[0];
			const turn = byName["agent.turn"]?.[0];
			const generation = byName["llm-response"]?.[0];
			if (!root || !turn || !generation) {
				throw new Error("Expected complete prompt hierarchy");
			}
			expect(new Set(spans.map((span) => span.traceId))).toEqual(
				new Set([root.traceId]),
			);
			expect(new Set(spans.map((span) => span.spanId)).size).toBe(3);
			expect(root.parentSpanId).toBeUndefined();
			expect(turn.parentSpanId).toBe(root.spanId);
			expect(generation.parentSpanId).toBe(turn.spanId);
			expect(recorder.records.every((record) => record.method === "POST")).toBe(
				true,
			);
			expect(recorder.legacyHits).toEqual([]);
			session.dispose();
			await shutdownClient();
			expect(errors).toEqual([]);
		} finally {
			unsubscribe();
		}
	}, 15_000);
});
