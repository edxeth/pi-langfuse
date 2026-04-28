import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
	flushClient,
	getClient,
	shutdownClient,
} from "../src/langfuse-client.js";

interface LangfuseTraceResponse {
	name: string;
	id: string;
	tags: string[];
	observations: Array<{
		name: string;
		model?: string;
		usage?: {
			total?: number;
		};
	}>;
}

const skipE2E =
	process.env.RUN_LANGFUSE_E2E !== "1" ||
	!process.env.LANGFUSE_PUBLIC_KEY ||
	!process.env.LANGFUSE_SECRET_KEY;

describe.runIf(!skipE2E)("Langfuse E2E Integration", () => {
	const config = resolveConfig({});
	const testId = `e2e-test-${randomUUID()}`;

	beforeEach(async () => {
		await shutdownClient();
	});

	it("should successfully ingest and retrieve a hierarchical trace", async () => {
		const lf = await getClient(config);

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

		// 2. Force flush to server
		await flushClient();

		// 3. Poll Langfuse API to verify retrieval
		// Langfuse API uses Basic Auth with public_key:secret_key
		const auth = Buffer.from(
			`${config.publicKey}:${config.secretKey}`,
		).toString("base64");
		const baseUrl = config.host.endsWith("/")
			? config.host.slice(0, -1)
			: config.host;
		const apiUrl = `${baseUrl}/api/public/traces/${testId}`;

		let retrievedTrace: LangfuseTraceResponse | null = null;
		let attempts = 0;
		const maxAttempts = 10;

		console.log(`Polling for trace ${testId} at ${apiUrl}...`);

		while (attempts < maxAttempts) {
			const response = await fetch(apiUrl, {
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/json",
				},
			});

			if (response.ok) {
				retrievedTrace = (await response.json()) as LangfuseTraceResponse;
				break;
			}

			attempts++;
			await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2s
		}

		expect(retrievedTrace).toBeDefined();
		if (!retrievedTrace) throw new Error(`Trace ${testId} was not retrieved`);
		expect(retrievedTrace.name).toBe("e2e-pi-test");
		expect(retrievedTrace.id).toBe(testId);
		expect(retrievedTrace.tags).toContain("env:e2e-test");

		// Check observations count (Span + Generation)
		expect(retrievedTrace.observations).toBeDefined();
		expect(retrievedTrace.observations.length).toBeGreaterThanOrEqual(2);

		const genObs = retrievedTrace.observations.find(
			(o) => o.name === "test.generation",
		);
		expect(genObs).toBeDefined();
		if (!genObs) throw new Error("Generation observation was not retrieved");
		expect(genObs.model).toBe("gpt-3.5-turbo");
		expect(genObs?.usage?.total).toBe(10);
	}, 30000); // 30s timeout for E2E
});
