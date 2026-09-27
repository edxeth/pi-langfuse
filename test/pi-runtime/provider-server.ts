import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Deterministic local provider speaking the `pi-messages` wire protocol
 * (POST <baseUrl>/messages, SSE reply of serialized assistant-message events
 * plus a terminal done/error event). Used through an agentDir models.json
 * custom provider so the tests drive the provider boundary Pi really uses.
 *
 * Each call is recorded with its full request body so tests can assert that
 * the outgoing provider payload is untouched by telemetry capture.
 */

export type PiMessagesEvent = Record<string, unknown>;

export type ProviderReply =
	| { status: number; body?: string }
	| { events: PiMessagesEvent[] };

export type RecordedProviderRequest = {
	call: number;
	url: string;
	authorization: string | null;
	body: unknown;
};

export type PiMessagesServer = {
	port: number;
	url: string;
	requests: RecordedProviderRequest[];
	close(): Promise<void>;
};

export function startPiMessagesServer(
	respond: (call: number, body: unknown) => ProviderReply,
): Promise<PiMessagesServer> {
	const requests: RecordedProviderRequest[] = [];
	let call = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			call += 1;
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
			} catch {
				body = undefined;
			}
			requests.push({
				call,
				url: request.url || "",
				authorization: request.headers.authorization ?? null,
				body,
			});
			const reply = respond(call, body);
			if ("status" in reply) {
				response.writeHead(reply.status, { "content-type": "text/plain" });
				response.end(
					reply.body ?? `${reply.status} synthetic provider failure`,
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of reply.events) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				port,
				url: `http://127.0.0.1:${port}`,
				requests,
				close: () =>
					new Promise((done, fail) => {
						server.close((error) => (error ? fail(error) : done()));
					}),
			});
		});
	});
}

export type UsageShape = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

export function usageOf(
	input: number,
	output: number,
	costTotal: number,
): UsageShape {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: costTotal,
		},
	};
}

/** SSE script for one plain-text assistant answer. */
export function textAnswerEvents(
	text: string,
	usage: UsageShape,
): PiMessagesEvent[] {
	return [
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: text },
		{ type: "text_end", contentIndex: 0, content: text },
		{ type: "done", reason: "stop", usage },
	];
}
