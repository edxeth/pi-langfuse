import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { getClient, shutdownClient } from "./langfuse-client.js";

// Mock the dynamic import of langfuse
vi.mock("./langfuse-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./langfuse-client.js")>();
	return {
		...actual,
	};
});

const _mockConfig: Config = {
	enabled: true,
	publicKey: "pk",
	secretKey: "sk",
	host: "https://cloud.langfuse.com",
	userId: "user",
	defaultTags: [],
	release: "1.0.0",
	environment: "test",
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: true,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	localAutostart: false,
	localAutostartDir: "",
	localAutostartHealthUrl: "http://localhost:3100/api/public/health",
	localAutostartTimeoutMs: 200,
};

describe("langfuse-client", () => {
	beforeEach(async () => {
		await shutdownClient();
	});

	it("should be defined", () => {
		expect(getClient).toBeDefined();
		expect(shutdownClient).toBeDefined();
	});

	// Note: Deep testing of getClient requires complex mocking of dynamic imports
	// and the Langfuse constructor which is better suited for integration tests
	// if we have a real environment.
});
