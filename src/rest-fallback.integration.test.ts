import { createServer } from "node:http";
import { LangfuseClient } from "@langfuse/client";
import { afterEach, describe, expect, it } from "vitest";
import {
	completeTrace,
	createOtlpFallbackTransport,
	createRestFallbackStore,
	drainCompletedRestFallback,
	endObservation,
	recordObservation,
	recordTrace,
} from "./rest-fallback.js";

const traceId = "a".repeat(32);
const timestamp = "2026-09-27T00:00:00.000Z";
const options = {
	requestTimeoutMs: 200,
	visibilityTimeoutMs: 100,
	pollIntervalMs: 5,
};
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function completedStore(count = 2) {
	const store = createRestFallbackStore();
	recordTrace(store, { id: traceId, timestamp, body: { name: "fixture" } });
	for (let index = 1; index <= count; index += 1) {
		const id = index.toString(16).padStart(16, "0");
		recordObservation(store, {
			id,
			traceId,
			name: index === 1 ? "agent.prompt" : "agent.turn",
			type: "SPAN",
			startTime: timestamp,
		});
		endObservation(store, id, timestamp);
	}
	completeTrace(store, traceId);
	return store;
}

async function fixture() {
	const state = {
		mode: "v3",
		readStatus: 200,
		v2Status: 404,
		visible: [] as unknown[],
		acceptReplay: true,
		requests: [] as URL[],
		replays: 0,
		/** Extra latency for every observations read, to exercise deadlines. */
		readDelayMs: 0,
		/** First v1 page number that answers 404; 0 disables the failure. */
		failV1FromPage: 0,
		/** Answer v2 reads with a 200 carrying a null data array. */
		nullV2Data: false,
	};
	const server = createServer((request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		state.requests.push(url);
		response.setHeader("content-type", "application/json");
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			if (url.pathname === "/api/public/otel/v1/traces") {
				state.replays += 1;
				if (state.acceptReplay) {
					const payload = JSON.parse(Buffer.concat(chunks).toString());
					for (const resource of payload.resourceSpans) {
						for (const scope of resource.scopeSpans) {
							for (const span of scope.spans) {
								if (!state.visible.includes(span.spanId)) {
									state.visible.push(span.spanId);
								}
							}
						}
					}
				}
				response.end("{}");
				return;
			}
			if (state.readDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, state.readDelayMs));
			}
			const v2 = url.pathname === "/api/public/v2/observations";
			const supported = v2 ? state.mode === "v4" : state.mode === "v3";
			const limit = Number(url.searchParams.get("limit") || 100);
			const page = Number(url.searchParams.get("page") || 1);
			const legacyPageFailure =
				!v2 && state.failV1FromPage > 0 && page >= state.failV1FromPage;
			response.statusCode =
				!supported || legacyPageFailure
					? v2
						? state.v2Status
						: 404
					: state.readStatus;
			if (response.statusCode !== 200) {
				response.end(
					JSON.stringify({ message: "Observation API unavailable" }),
				);
				return;
			}
			if (v2 && state.nullV2Data) {
				response.end(JSON.stringify({ data: null, meta: {} }));
				return;
			}
			const offset = v2
				? Number(url.searchParams.get("cursor") || 0)
				: (page - 1) * limit;
			const data = state.visible
				.slice(offset, offset + limit)
				.map((id) => ({ id, traceId }));
			const meta = v2
				? {
						cursor:
							offset + limit < state.visible.length
								? String(offset + limit)
								: undefined,
					}
				: { page, limit, totalPages: Math.ceil(state.visible.length / limit) };
			response.end(JSON.stringify({ data, meta }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No TCP port");
	const connection = {
		host: `http://127.0.0.1:${address.port}`,
		publicKey: "pk-local-fixture",
		secretKey: "sk-local-fixture",
	};
	const client = new LangfuseClient({
		...connection,
		baseUrl: connection.host,
	});
	cleanup.push(() => client.shutdown());
	return {
		state,
		deps: { client, transport: createOtlpFallbackTransport(connection) },
	};
}

describe("confirmation against Langfuse server modes", () => {
	it.each([
		{ mode: "v3", extraCount: 100 },
		{ mode: "v4", extraCount: 1000 },
	])(
		"finds expected IDs after additional server observations in $mode",
		async ({ mode, extraCount }) => {
			const { state, deps } = await fixture();
			state.mode = mode;
			const store = completedStore();
			state.visible = [
				...Array.from({ length: extraCount }, (_, index) => `extra-${index}`),
				...store.observations.keys(),
			];
			// This is an ID-pagination test, not a 100ms latency assertion.
			// Leave room for cold SDK/network setup under parallel suite load.
			expect(
				await drainCompletedRestFallback(store, deps, {
					...options,
					requestTimeoutMs: 2_000,
					visibilityTimeoutMs: 2_000,
				}),
			).toEqual({
				problems: [],
				terminalLosses: [],
			});
			expect(state.replays).toBe(0);
			expect(store.traces.size).toBe(0);
		},
	);

	it("confirms stored v3 observations without replay or the footer warning", async () => {
		const { state, deps } = await fixture();
		const store = completedStore();
		state.visible = [...store.observations.keys()];
		const result = await drainCompletedRestFallback(store, deps, options);
		expect(result).toEqual({ problems: [], terminalLosses: [] });
		expect(state.replays).toBe(0);
		expect(store.traces.size).toBe(0);
		// Reuse the selected API for later prompts, not one failing probe per prompt.
		await drainCompletedRestFallback(completedStore(), deps, options);
		expect(
			state.requests.filter((url) => url.pathname.includes("/v2/")),
		).toHaveLength(1);
		expect(
			state.requests.every(
				(url) => url.searchParams.get("traceId") === traceId,
			),
		).toBe(true);
	});

	it("uses v4 directly without calling the removed v1 endpoint", async () => {
		const { state, deps } = await fixture();
		state.mode = "v4";
		const store = completedStore();
		state.visible = [...store.observations.keys()];
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		expect(state.requests.map((url) => url.pathname)).toEqual([
			"/api/public/v2/observations",
		]);
	});

	it("paginates v3 observations before declaring the trace complete", async () => {
		const { state, deps } = await fixture();
		const store = completedStore(101);
		state.visible = [...store.observations.keys()];
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		expect(state.replays).toBe(0);
		expect(
			state.requests.some((url) => url.searchParams.get("page") === "2"),
		).toBe(true);
	});

	it("replays missing v3 observations and confirms all original IDs", async () => {
		const { state, deps } = await fixture();
		const store = completedStore();
		const expected = [...store.observations.keys()];
		state.visible = expected.slice(0, 1);
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		expect(state.replays).toBe(1);
		expect(state.visible).toEqual(expected);
		expect(store.traces.size).toBe(0);
	});

	it("still warns and retains recovery data if v3 observations remain missing", async () => {
		const { state, deps } = await fixture();
		state.acceptReplay = false;
		const store = completedStore();
		const result = await drainCompletedRestFallback(store, deps, options);
		expect(result.problems.join("; ")).toContain(
			"not confirmed by the observations API",
		);
		expect(store.traces.size).toBe(1);
		expect(state.replays).toBe(1);
	});

	it.each([401, 403, 500])(
		"does not switch API on v2 HTTP %s",
		async (status) => {
			const { state, deps } = await fixture();
			state.v2Status = status;
			const store = completedStore();
			state.visible = [...store.observations.keys()];
			const result = await drainCompletedRestFallback(store, deps, options);
			expect(result.problems.join("; ")).toContain("not confirmed");
			expect(
				state.requests.some(
					(url) => url.pathname === "/api/public/observations",
				),
			).toBe(false);
			expect(store.traces.size).toBe(1);
		},
	);
});

describe("negotiation and deadline honesty across API versions", () => {
	it("re-confirms through v2 after a remembered v1 server upgrades to v4", async () => {
		const { state, deps } = await fixture();
		const store = completedStore();
		state.visible = [...store.observations.keys()];
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		state.mode = "v4";
		expect(
			await drainCompletedRestFallback(completedStore(), deps, options),
		).toEqual({ problems: [], terminalLosses: [] });
		// One v1 upgrade probe, one v2 confirmation; later prompts never probe v1 again.
		expect(
			state.requests.filter(
				(url) => url.pathname === "/api/public/observations",
			),
		).toHaveLength(2);
		expect(
			state.requests.filter(
				(url) => url.pathname === "/api/public/v2/observations",
			),
		).toHaveLength(2);
	});

	it("does not switch API when a later v1 page fails", async () => {
		const { state, deps } = await fixture();
		state.failV1FromPage = 2;
		const store = completedStore(150);
		state.visible = [...store.observations.keys()];
		const result = await drainCompletedRestFallback(store, deps, options);
		expect(result.problems.join("; ")).toContain("not confirmed");
		// Only the initial v2 probe ran; the v1 page failure never re-opens v2.
		expect(
			state.requests.filter((url) => url.pathname.includes("/v2/")),
		).toHaveLength(1);
		expect(state.replays).toBe(1);
		expect(store.traces.size).toBe(1);
	});

	it("does not negotiate once the visibility deadline has passed", async () => {
		const { state, deps } = await fixture();
		const store = completedStore();
		state.visible = [...store.observations.keys()];
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		state.mode = "v4";
		state.readDelayMs = 20;
		const requestsBefore = state.requests.length;
		const result = await drainCompletedRestFallback(completedStore(), deps, {
			...options,
			visibilityTimeoutMs: 5,
		});
		expect(result.problems.join("; ")).toContain("not confirmed");
		expect(
			state.requests
				.slice(requestsBefore)
				.filter((url) => url.pathname === "/api/public/v2/observations"),
		).toHaveLength(0);
	});

	it("stops paginating at the shared deadline and stays unconfirmed", async () => {
		const { state, deps } = await fixture();
		state.readDelayMs = 20;
		const store = completedStore(101);
		state.visible = [...store.observations.keys()];
		const result = await drainCompletedRestFallback(store, deps, {
			...options,
			visibilityTimeoutMs: 10,
		});
		expect(result.problems.join("; ")).toContain("not confirmed");
		expect(state.replays).toBe(1);
		expect(store.traces.size).toBe(1);
	});

	it("confirms v4 observations across cursor pages", async () => {
		const { state, deps } = await fixture();
		state.mode = "v4";
		const store = completedStore(1001);
		state.visible = [...store.observations.keys()];
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		expect(state.replays).toBe(0);
		expect(state.requests).toHaveLength(2);
		expect(state.requests[0].searchParams.get("cursor")).toBeNull();
		expect(state.requests[1].searchParams.get("cursor")).toBe("1000");
		expect(store.traces.size).toBe(0);
	});

	it("reports unconfirmed when v4 pagination exhausts the page budget", async () => {
		const { state, deps } = await fixture();
		state.mode = "v4";
		const store = completedStore(5001);
		state.visible = [...store.observations.keys()];
		const result = await drainCompletedRestFallback(store, deps, {
			requestTimeoutMs: 2000,
			// Generous window: the five-page budget must exhaust before the
			// deadline check, even on a loaded machine, so this pins the
			// budget-exhaustion path specifically.
			visibilityTimeoutMs: 1000,
			pollIntervalMs: 5,
		});
		// Either honest diagnostic is acceptable: under extreme load the large
		// replay send itself may fail instead of landing unconfirmed.
		expect(result.problems.join("; ")).toMatch(
			/not confirmed|ingestion failed/,
		);
		expect(state.replays).toBe(1);
		expect(store.traces.size).toBe(1);
	});

	it("ignores malformed server rows instead of counting them as confirmed", async () => {
		const { state, deps } = await fixture();
		const store = completedStore();
		const expected = [...store.observations.keys()];
		state.visible = [expected[0], null];
		expect(await drainCompletedRestFallback(store, deps, options)).toEqual({
			problems: [],
			terminalLosses: [],
		});
		expect(state.replays).toBe(1);
		expect(store.traces.size).toBe(0);
	});

	it("stays unconfirmed when v2 answers 200 with a null data array", async () => {
		const { state, deps } = await fixture();
		state.mode = "v4";
		state.nullV2Data = true;
		const store = completedStore();
		state.visible = [...store.observations.keys()];
		const result = await drainCompletedRestFallback(store, deps, options);
		expect(result.problems.join("; ")).toContain("not confirmed");
		expect(state.replays).toBe(1);
		expect(store.traces.size).toBe(1);
	});

	it("stays unconfirmed when the client cannot answer the v2 check", async () => {
		const client = {
			api: { observations: { getMany: () => undefined } },
		} as unknown as LangfuseClient;
		const deps = { client, transport: { async sendSpans() {} } };
		const store = completedStore();
		const result = await drainCompletedRestFallback(store, deps, options);
		expect(result.problems.join("; ")).toContain("not confirmed");
		expect(store.traces.size).toBe(1);
	});

	it("stays unconfirmed when only the legacy surface is missing after a v2 404", async () => {
		const notFound = Object.assign(new Error("gone"), { statusCode: 404 });
		const client = {
			api: {
				observations: { getMany: () => Promise.reject(notFound) },
			},
		} as unknown as LangfuseClient;
		const deps = { client, transport: { async sendSpans() {} } };
		const store = completedStore();
		const result = await drainCompletedRestFallback(store, deps, options);
		expect(result.problems.join("; ")).toContain("not confirmed");
		expect(store.traces.size).toBe(1);
	});
});
