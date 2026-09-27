import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
	flushClient,
	getRuntime,
	shutdownClient,
} from "../src/langfuse-client.js";
import { pollForTraceObservations } from "../src/operator-telemetry.js";

const skipE2E =
	process.env.RUN_LANGFUSE_E2E !== "1" ||
	!process.env.LANGFUSE_PUBLIC_KEY ||
	!process.env.LANGFUSE_SECRET_KEY;

describe.runIf(!skipE2E)("Langfuse E2E Integration", () => {
	const config = resolveConfig({});
	const testId = randomUUID().replaceAll("-", "");

	beforeEach(async () => {
		await shutdownClient();
	});

	it("should successfully ingest and retrieve a hierarchical trace", async () => {
		const lf = await getRuntime(config);

		// 1. Create a complex hierarchy
		const trace = lf.trace({
			name: "e2e-pi-test",
			id: testId,
			tags: ["env:e2e-test"],
			metadata: { testRunner: "vitest" },
		});

		const span = lf.span({
			name: "test.parent",
			traceId: trace.id,
			input: "parent input",
		});

		const generation = lf.generation({
			name: "test.generation",
			traceId: trace.id,
			parentObservationId: span.id,
			model: "gpt-3.5-turbo",
			input: "What is 2+2?",
		});

		generation.end({
			output: "4",
			usage: { total: 10, input: 5, output: 5 },
		});

		span.end({ output: "done" });
		// End the prompt root so the trace is complete before flushing.
		trace.end?.({ output: "done" });

		// 2. Force flush to server
		await flushClient();

		// 3. Poll the supported v2 observations API to verify retrieval. The
		// legacy trace read endpoint is unavailable on Langfuse server v4,
		// while the v2 observations endpoint is shared by v3 and v4. The poll
		// waits for the expected observations, because a 200 with an empty
		// page just means indexing has not caught up yet.
		// Langfuse API uses Basic Auth with public_key:secret_key
		const auth = Buffer.from(
			`${config.publicKey}:${config.secretKey}`,
		).toString("base64");
		const baseUrl = config.host.endsWith("/")
			? config.host.slice(0, -1)
			: config.host;

		const observations = await pollForTraceObservations({
			auth,
			baseUrl,
			traceId: testId,
			expectedNames: ["test.parent", "test.generation"],
		});

		// Check observations count (Span + Generation)
		expect(observations.length).toBeGreaterThanOrEqual(2);

		const parentSpan = observations.find((o) => o.name === "test.parent");
		expect(parentSpan).toBeDefined();
		expect(parentSpan?.type).toBe("SPAN");
		const genObs = observations.find((o) => o.name === "test.generation");
		expect(genObs).toBeDefined();
		if (!genObs) throw new Error("Generation observation was not retrieved");
		expect(genObs.model).toBe("gpt-3.5-turbo");
		expect(genObs?.usageDetails?.total).toBe(10);
	}, 30000); // 30s timeout for E2E
});
