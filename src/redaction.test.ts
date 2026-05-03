import { describe, expect, it } from "vitest";
import {
	isSensitiveKey,
	redactString,
	sanitizeForTelemetry,
	scanForSecrets,
} from "./redaction.js";

const config = {
	redactionEnabled: true,
	redactionAdditionalSecrets: ["manually-configured-secret"],
	secretKey: "sk-lf-test-secret-1234567890",
};

describe("redaction", () => {
	it("redacts exact configured and environment secrets deterministically", () => {
		const env = {
			OPENAI_API_KEY: "sk-proj-thisisaverylongopenaitestkey",
			NORMAL_VALUE: "not-redacted",
		};

		const output = redactString(
			config,
			"keys sk-lf-test-secret-1234567890 sk-proj-thisisaverylongopenaitestkey manually-configured-secret",
			env,
		);

		expect(output).not.toContain("sk-lf-test-secret-1234567890");
		expect(output).not.toContain("sk-proj-thisisaverylongopenaitestkey");
		expect(output).not.toContain("manually-configured-secret");
		expect(output).toContain("[REDACTED:langfuse-secret-key:");
		expect(output).toContain("[REDACTED:openai-api-key:");
		expect(output).toContain("[REDACTED:configured-secret:");
	});

	it("redacts common token patterns without knowing them in advance", () => {
		const output = redactString(
			config,
			"ghp_abcdefghijklmnopqrstuvwxyz1234567890 hf_abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrstuvwxyz123456",
			{},
		);

		expect(output).toContain("[REDACTED:github-token:");
		expect(output).toContain("[REDACTED:huggingface-token:");
		expect(output).toContain("[REDACTED:bearer-token:");
		expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
		expect(output).not.toContain("hf_abcdefghijklmnopqrstuvwxyz");
	});

	it("redacts .env-style secret assignments while preserving useful shape", () => {
		const output = redactString(
			config,
			"LANGFUSE_SECRET_KEY=sk-lf-example123456\nPASSWORD='supersecretvalue'\nPWD=/tmp/project",
			{},
		);

		expect(output).toContain(
			"LANGFUSE_SECRET_KEY=[REDACTED:langfuse-secret-key:",
		);
		expect(output).toContain("PASSWORD='[REDACTED:password:");
		expect(output).toContain("PWD=/tmp/project");
		expect(output).not.toContain("sk-lf-example123456");
		expect(output).not.toContain("supersecretvalue");
	});

	it("redacts sensitive object fields recursively", () => {
		const sanitized = sanitizeForTelemetry(
			config,
			{
				publicKey: "pk-lf-not-secret",
				secretKey: "sk-lf-test-secret-1234567890",
				nested: {
					authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
					message: "safe value",
				},
			},
			{},
		);

		expect(sanitized.publicKey).toBe("pk-lf-not-secret");
		expect(String(sanitized.secretKey)).toContain("[REDACTED:secret-key:");
		expect(String(sanitized.nested.authorization)).toContain(
			"[REDACTED:authorization:",
		);
		expect(sanitized.nested.message).toBe("safe value");
	});

	it("redacts PII-ish text, embedded credentials, and large blobs", () => {
		const base64Blob = "A".repeat(140);
		const hexBlob = "a".repeat(100);
		const output = redactString(
			config,
			`Contact jane.doe@example.com or +1 415-555-1212. Card 4111-1111-1111-1111. Fetch https://user:pass@example.test/path. data:image/png;base64,${base64Blob} ${hexBlob}`,
			{},
		);

		expect(output).toContain("[REDACTED:email:");
		expect(output).toContain("[REDACTED:phone-number:");
		expect(output).toContain("[REDACTED:credit-card:");
		expect(output).toContain("[REDACTED:url-embedded-credentials:");
		expect(output).toContain("[REDACTED:data-url:");
		expect(output).toContain("[REDACTED:long-hex-blob:");
		expect(output).not.toContain("jane.doe@example.com");
		expect(output).not.toContain("4111-1111-1111-1111");
		expect(output).not.toContain("https://user:pass@example.test/path");
		expect(output).not.toContain(base64Blob);
		expect(output).not.toContain(hexBlob);
	});

	it("redacts binary/image-like object fields", () => {
		const sanitized = sanitizeForTelemetry(config, {
			image: `data:image/png;base64,${"A".repeat(140)}`,
			contentBytes: "deadbeef".repeat(40),
			message: "safe text",
		});

		expect(String(sanitized.image)).toContain("[REDACTED:image:");
		expect(String(sanitized.contentBytes)).toContain(
			"[REDACTED:content-bytes:",
		);
		expect(sanitized.message).toBe("safe text");
	});

	it("scans residual PII-ish and blob patterns without flagging timestamps", () => {
		const findings = scanForSecrets(
			config,
			`email jane.doe@example.com card 4111-1111-1111-1111 token ${"A".repeat(140)} timestamp 2026-05-02T20:38:26.032Z`,
			{},
		).map((finding) => finding.reason);

		expect(findings).toContain("email");
		expect(findings).toContain("credit-card");
		expect(findings).toContain("long-base64-blob");
		expect(findings).not.toContain("phone-number");
	});

	it("can be explicitly disabled for dangerous local debugging", () => {
		expect(
			redactString(
				{ ...config, redactionEnabled: false },
				"sk-lf-test-secret-1234567890",
				{},
			),
		).toBe("sk-lf-test-secret-1234567890");
	});

	it("does not treat publicKey, paths, or token counters as sensitive field names", () => {
		expect(isSensitiveKey("publicKey")).toBe(false);
		expect(isSensitiveKey("cwd")).toBe(false);
		expect(isSensitiveKey("PWD")).toBe(false);
		expect(isSensitiveKey("totalTokens")).toBe(false);
		expect(isSensitiveKey("max_completion_tokens")).toBe(false);
		expect(isSensitiveKey("secretKey")).toBe(true);
		expect(isSensitiveKey("access_token")).toBe(true);
	});
});
