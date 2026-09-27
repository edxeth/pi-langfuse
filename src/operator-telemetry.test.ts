import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
	pollForTraceObservations,
	sendIsolatedTestTrace,
} from "./operator-telemetry.js";

const config: Config = {
	enabled: true,
	publicKey: "pk-lf-probe",
	secretKey: "sk-lf-probe-secret-1234567890",
	host: "http://localhost:3100",
	userId: "tester",
	defaultTags: [],
	release: "",
	environment: "",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: true,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: [],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

async function listen(
	handler: (
		request: { url?: string; body: string },
		response: {
			writeHead: (status: number, headers: Record<string, string>) => void;
			end: (body?: string) => void;
		},
	) => void,
) {
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			handler(
				{ url: request.url, body: Buffer.concat(chunks).toString("utf8") },
				{
					writeHead: (status, headers) => {
						response.statusCode = status;
						for (const [key, value] of Object.entries(headers)) {
							response.setHeader(key, value);
						}
					},
					end: (body) => response.end(body),
				},
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	servers.push({
		close: () => server.close(),
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

describe("isolated test trace probe", () => {
	it("sends an isolated span over the supported OTLP endpoint", async () => {
		let requestUrl: string | undefined;
		const host = await listen((request, response) => {
			requestUrl = request.url;
			response.writeHead(200, { "content-type": "application/json" });
			response.end("{}");
		});
		const seen = await sendIsolatedTestTrace(
			{ ...config, host },
			new AbortController().signal,
		);
		expect(seen.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(requestUrl).toBe("/api/public/otel/v1/traces");
	});

	it("rejects the documented partialSuccess rejection shapes", async () => {
		// The OTLP trace response reports rejections through rejectedSpans and
		// errorMessage; proto3 JSON may encode the int64 as a string.
		const cases: Array<{ code: number; body: string }> = [
			{
				code: 200,
				body: JSON.stringify({
					partialSuccess: { rejectedSpans: 1, errorMessage: "invalid span" },
				}),
			},
			{
				code: 200,
				body: JSON.stringify({
					partialSuccess: { rejectedSpans: "2" },
				}),
			},
			{
				code: 200,
				body: JSON.stringify({
					partialSuccess: { errorMessage: "span rejected by server" },
				}),
			},
		];
		for (const testCase of cases) {
			const host = await listen((_request, response) => {
				response.writeHead(testCase.code, {
					"content-type": "application/json",
				});
				response.end(testCase.body);
			});
			await expect(
				sendIsolatedTestTrace(
					{ ...config, host },
					new AbortController().signal,
				),
			).rejects.toThrow(/isolated test trace/);
		}
	});

	it("accepts an empty partialSuccess response", async () => {
		const host = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ partialSuccess: {} }));
		});
		await expect(
			sendIsolatedTestTrace({ ...config, host }, new AbortController().signal),
		).resolves.toMatchObject({ traceId: expect.any(String) });
	});
});

describe("v2 observations poll", () => {
	it("keeps polling through empty 200 pages until observations appear", async () => {
		let observationsCalls = 0;
		const host = await listen((request, response) => {
			if (!request.url?.includes("/api/public/v2/observations")) {
				response.writeHead(404, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			observationsCalls += 1;
			const data =
				observationsCalls < 3
					? []
					: [
							{ id: "obs-1", name: "test.parent" },
							{ id: "obs-2", name: "test.generation" },
						];
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data, meta: {} }));
		});
		const observations = await pollForTraceObservations({
			auth: "Basic dXNlcjpwYXNz",
			baseUrl: host,
			traceId: "a".repeat(32),
			expectedNames: ["test.parent", "test.generation"],
			intervalMs: 1,
			maxAttempts: 10,
		});
		expect(observationsCalls).toBe(3);
		expect(observations.map((observation) => observation.name)).toEqual([
			"test.parent",
			"test.generation",
		]);
	});

	it("reports the trace as unqueryable when the page never populates", async () => {
		let observationsCalls = 0;
		const host = await listen((request, response) => {
			if (!request.url?.includes("/api/public/v2/observations")) {
				response.writeHead(404, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			observationsCalls += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [], meta: {} }));
		});
		await expect(
			pollForTraceObservations({
				auth: "Basic dXNlcjpwYXNz",
				baseUrl: host,
				traceId: "b".repeat(32),
				expectedNames: ["test.parent"],
				intervalMs: 1,
				maxAttempts: 3,
			}),
		).rejects.toThrow(/not queryable/);
		expect(observationsCalls).toBe(3);
	});
});
