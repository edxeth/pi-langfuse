import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerExtension from "../../src/index.js";
import {
	type CompatibilityScenarioContext,
	createTestPi,
	eventHandler,
} from "./compatibility-fixtures.js";

/** Registers the turn-span provider-payload capture scenarios. Both cases share one capture driver. */
export function registerTurnSpanCaptureScenarios({
	telemetry,
	tempRoot,
}: CompatibilityScenarioContext): void {
	// When payload capture is enabled, the turn span metadata must carry the
	// bounded payload summary alongside the booked request; with capture off
	// the request is still booked but no payload text may reach the span.
	async function driveTurnSpanMetadataCapture(captureEnabled: boolean) {
		if (captureEnabled) {
			process.env.PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD = "1";
		}
		const agentDir = tempRoot(
			captureEnabled
				? "pi-langfuse-span-capture-agent-"
				: "pi-langfuse-span-nocapture-agent-",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPi({
			enabled: true,
			"public-key": "span-public",
			"secret-key": "span-secret",
			"base-url": "http://span-host",
		});
		await registerExtension(pi as unknown as ExtensionAPI);

		const context = {
			model: { id: "span-model", provider: "span-provider" },
			sessionManager: {
				getSessionFile: () =>
					"/tmp/pi-agent/sessions/--span--/span-session.jsonl",
				getSessionId: () => "span-session",
			},
		};
		const handler = (name: string) => eventHandler(pi, name);

		await handler("session_start")({ reason: "startup" }, context);
		await handler("model_select")(
			{ model: { id: "span-model", provider: "span-provider" } },
			context,
		);
		await handler("before_agent_start")(
			{
				prompt: "span prompt",
				systemPrompt: "span system",
				systemPromptOptions: { cwd: "/tmp/span" },
			},
			context,
		);
		await handler("agent_start")({}, context);
		await handler("turn_start")({ turnIndex: 0 }, context);
		await handler("before_provider_request")(
			{
				payload: {
					model: "span-model",
					messages: [{ role: "user", content: "CAPTURE-payload marker" }],
				},
			},
			context,
		);

		const turnRecord = telemetry.state.observations.find(
			(record) => record.name === "agent.turn",
		);
		if (!turnRecord) throw new Error("turn span missing");
		const updateCalls =
			(turnRecord.updateCalls as Array<Record<string, unknown>> | undefined) ??
			[];
		const requestUpdate = updateCalls.find((update) => {
			const metadata = update.metadata as
				| { requests?: unknown; providerPayload?: unknown }
				| undefined;
			return Array.isArray(metadata?.requests);
		});
		if (!requestUpdate) throw new Error("turn request booking missing");
		const metadata = requestUpdate.metadata as {
			requests: Array<{ model?: string; payloadSize?: number }>;
			providerPayload?: unknown;
		};

		await handler("message_start")({ message: { role: "assistant" } }, context);
		await handler("message_end")(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			context,
		);
		await handler("turn_end")(
			{
				turnIndex: 0,
				message: { role: "assistant", content: [] },
				toolResults: [],
			},
			context,
		);
		await handler("agent_end")({ messages: [] }, context);
		await handler("agent_settled")({}, context); // Pi settles every accepted run
		await handler("session_shutdown")({}, context);
		return metadata;
	}

	it("carries providerPayload on the turn span when payload capture is enabled", async () => {
		const metadata = await driveTurnSpanMetadataCapture(true);

		expect(metadata.requests).toHaveLength(1);
		expect(metadata.requests[0]).toMatchObject({
			model: "span-model",
		});
		expect(metadata.requests[0]?.payloadSize).toBeGreaterThan(0);
		expect(typeof metadata.providerPayload).toBe("string");
		expect(String(metadata.providerPayload)).toContain(
			"CAPTURE-payload marker",
		);
	});

	it("keeps providerPayload off the turn span when payload capture is disabled", async () => {
		const metadata = await driveTurnSpanMetadataCapture(false);

		expect(metadata.requests).toHaveLength(1);
		expect(metadata.requests[0]?.model).toBe("span-model");
		expect(metadata.providerPayload).toBeUndefined();
	});
}
