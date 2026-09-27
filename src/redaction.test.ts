import { performance } from "node:perf_hooks";
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
		expect(output).toContain("[REDACTED:openai-key:");
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

	it("redacts Stripe, SendGrid, Docker PAT, and Slack webhook patterns", () => {
		const output = redactString(
			config,
			[
				"sk_live_abcdefghijklmnop1234",
				"pk_test_abcdefghijklmnop12345678",
				"SG.abcdefghijklmnop1234567890.qwertyuiop1234567890asdfghjk",
				"dckr_pat_abcdefghijklmnop-1234567890abcdefGH",
				"https://hooks.slack.com/services/T00ABCDEF/B00ABCDEF/abcdefghijklmnop1234567890",
			].join(" "),
			{},
		);

		expect(output).toContain("[REDACTED:stripe-key:");
		expect(output).toContain("[REDACTED:sendgrid-key:");
		expect(output).toContain("[REDACTED:docker-pat:");
		expect(output).toContain("[REDACTED:slack-webhook-url:");
		expect(output).not.toContain("sk_live_");
		expect(output).not.toContain("pk_test_");
		expect(output).not.toContain("SG.");
		expect(output).not.toContain("dckr_pat_");
		expect(output).not.toContain("hooks.slack.com");
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

	it("redacts JSON-quoted secret assignments in plain and JSONL-escaped text", () => {
		const plain = redactString(
			config,
			'deploy ok {"password":"SuperSecret9"} done',
			{},
		);

		expect(plain).not.toContain("SuperSecret9");
		expect(plain).toContain('"password":"[REDACTED:password:');

		// JSONL embeds nested JSON with escaped quotes; redaction must keep the
		// escaping intact while removing the value.
		const escapedLine =
			'{"type":"message","text":"{\\"password\\":\\"SuperSecret9\\"}"}';
		const escaped = redactString(config, escapedLine, {});

		expect(escaped).not.toContain("SuperSecret9");
		expect(escaped).toContain('\\"password\\":\\"[REDACTED:password:');
	});

	it("redacts quoted secret assignments with single quotes and spacing", () => {
		const output = redactString(
			config,
			"{'password' : 'SuperSecret9'} {\"api key\":\"SuperSecret9\"}",
			{},
		);

		expect(output).not.toContain("SuperSecret9");
		expect(output).toContain("'[REDACTED:password:");
		expect(output).toContain('"[REDACTED:api-key:');
	});

	it("leaves non-sensitive quoted JSON fields and prose untouched", () => {
		const input = '{"username":"alice","count":"42"}';
		expect(redactString(config, input, {})).toBe(input);
		expect(redactString(config, 'the "password" field: required', {})).toBe(
			'the "password" field: required',
		);
	});

	it("scans escaped JSONL representations of quoted secret fields", () => {
		const escapedLine =
			'{"type":"tool_result","text":"{\\"password\\":\\"SuperSecret9\\"}"}';

		expect(
			scanForSecrets(config, escapedLine, {}).map((finding) => finding.reason),
		).toContain("password");
		expect(
			scanForSecrets(config, '{"password":"SuperSecret9"}', {}).map(
				(finding) => finding.reason,
			),
		).toContain("password");
		expect(
			scanForSecrets(config, '{"api key":"SuperSecret9"}', {}).map(
				(finding) => finding.reason,
			),
		).toContain("api-key");
		// Already-redacted values stay silent.
		expect(
			scanForSecrets(
				config,
				'{"password":"[REDACTED:password:abcd1234]"}',
				{},
			).map((finding) => finding.reason),
		).not.toContain("password");
	});

	it("resolves quoted secrets at any uniform escape depth in place", () => {
		// Uniform repeated serialization at any depth keeps symmetric quote
		// tokens, so the value extent is provable and the value is replaced
		// with a structure-preserving hashed placeholder.
		for (const backslashes of [7, 15, 31, 63, 1023, 4095]) {
			const deep = '{"password":"SuperSecret9"}'.replace(
				/"/g,
				`${"\\".repeat(backslashes)}"`,
			);
			const output = redactString(config, deep, {});
			expect(output).not.toContain("SuperSecret9");
			expect(output).toContain("[REDACTED:password:");
			expect(
				scanForSecrets(config, deep, {}).map((finding) => finding.reason),
			).toContain("password");
			// After redaction the scanner is silent about this shape.
			expect(
				scanForSecrets(config, output, {}).map((finding) => finding.reason),
			).not.toContain("suspicious-text");
		}
	});

	it("resolves whitespace and escape-prefixed deep values without leaking", () => {
		const wrap = (value: string) =>
			`{"password"${"\\".repeat(7)}:${"\\".repeat(7)}"${value}"}`;
		for (const value of [
			" SuperSecret9",
			"\tSuperSecret9",
			"\\ SuperSecret9",
			'\\"SuperSecret9\\"',
			"[REDACTED",
			"[REDACTED:password",
			"[REDACTED:password:abcd12345678] extra SuperSecret9",
		]) {
			const output = redactString(config, wrap(value), {});
			expect(output, `value ${JSON.stringify(value)}`).not.toContain(
				"SuperSecret9",
			);
		}
		// A value that is exactly a complete standalone placeholder stays when
		// the extent is provable (symmetric close token plus structural tail).
		const keptSource =
			'{"password":"[REDACTED:password:abcd12345678]"}'.replace(
				/"/g,
				`${"\\".repeat(7)}"`,
			);
		const kept = redactString(config, keptSource, {});
		expect(kept).toContain("[REDACTED:password:abcd12345678]");
		// An ambiguous extent (content backslash, bare quote, unterminated)
		// omits the whole string instead of guessing.
		for (const value of [`\\\\SuperSecret9`, 'SuperSecret9\\"trailing']) {
			expect(redactString(config, wrap(value), {})).toBe(
				"[REDACTED:suspicious-text]",
			);
		}
		expect(redactString(config, '{"password":"SuperSecret9', {})).toBe(
			"[REDACTED:suspicious-text]",
		);
	});

	it("recognizes JSON whitespace and serialized escapes around the separator", () => {
		// Pretty-printed JSON at depth 0: newline and CRLF between the key's
		// closing quote and the colon.
		const depth0Lf = '{\n  "password"\n  : "SuperSecret9"\n}';
		const depth0LfOut = redactString(config, depth0Lf, {});
		expect(depth0LfOut).not.toContain("SuperSecret9");
		expect(depth0LfOut).toContain("[REDACTED:password:");
		expect(
			scanForSecrets(config, depth0Lf, {}).map((finding) => finding.reason),
		).toContain("password");
		const depth0CrLf = '{\r\n  "password"\r\n  : "SuperSecret9"\r\n}';
		expect(redactString(config, depth0CrLf, {})).not.toContain("SuperSecret9");

		// Nested serialization turns the newline into backslash-n (and the tab
		// / CR forms likewise); the depth-N form nests those escapes further.
		const nested = (depth: number) => {
			let doc = '{\n  "password"\n  : "SuperSecret9"\n}';
			for (let d = 0; d < depth; d += 1) doc = JSON.stringify(doc);
			return doc;
		};
		for (const depth of [1, 3]) {
			const nestedOut = redactString(config, nested(depth), {});
			// Nested serialized whitespace is recognized as separator junk, so
			// the value is replaced in place behind its escaped tokens.
			expect(nestedOut, `nested depth ${depth}`).not.toContain("SuperSecret9");
			expect(nestedOut, `nested depth ${depth}`).toContain(
				"[REDACTED:password:",
			);
			expect(
				scanForSecrets(config, nestedOut, {}).map((finding) => finding.reason),
			).toEqual([]);
		}

		// The same contract applies after the colon.
		const postLf = '{"password":\n"SuperSecret9"}';
		expect(redactString(config, postLf, {})).not.toContain("SuperSecret9");
		const postSerialized = '{"password":\\n"SuperSecret9"}';
		expect(redactString(config, postSerialized, {})).not.toContain(
			"SuperSecret9",
		);
		const postTab = '{"password":\n\t"SuperSecret9"}';
		expect(redactString(config, postTab, {})).not.toContain("SuperSecret9");

		// Benign non-assignments stay untouched.
		const benignKey = '{\n  "note"\n  : "value with password word"\n}';
		expect(redactString(config, benignKey, {})).toBe(benignKey);
		const prose = 'the "password"\nis required reading';
		expect(redactString(config, prose, {})).toBe(prose);
		const serializedNote = '{"note"\\n: "it contains n after a slash"}';
		expect(redactString(config, serializedNote, {})).toBe(serializedNote);
	});

	it("fails closed on quoted sensitive values it cannot resolve", () => {
		// Truncated file tail: the quoted value never closes, so bounded
		// parsing cannot resolve it and the scanner must refuse approval.
		expect(
			scanForSecrets(config, '{"password":"SuperSecret9', {}).map(
				(finding) => finding.reason,
			),
		).toContain("suspicious-text");

		// A deep unredacted value is exactly delimited, so it is reported by
		// its field reason (it will be replaced by redaction).
		const depth4 = '{"password":"SuperSecret9"}'.replace(
			/"/g,
			`${"\\".repeat(15)}"`,
		);
		expect(
			scanForSecrets(config, depth4, {}).map((finding) => finding.reason),
		).toContain("password");
		// A resolved placeholder at the same depth stays silent.
		const depth4Redacted =
			'{"password":"[REDACTED:password:abcd1234]"}'.replace(
				/"/g,
				`${"\\".repeat(15)}"`,
			);
		expect(
			scanForSecrets(config, depth4Redacted, {}).map(
				(finding) => finding.reason,
			),
		).toEqual([]);

		// Empty quoted values have nothing to leak; token counters are not
		// sensitive fields.
		expect(scanForSecrets(config, '{"password":""}', {})).toEqual([]);
		expect(scanForSecrets(config, '{"total_tokens":"4096"}', {})).toEqual([]);
	});

	it("omits the whole string only when the value extent is unprovable", () => {
		// Truncated tails have no closing quote to parse against.
		expect(
			redactString(config, 'deploy ok {"password":"SuperSecret9', {}),
		).toBe("[REDACTED:suspicious-text]");

		// A bare closing quote after an escaped opening quote leaves the
		// extent unprovable (the trailing run cannot be attributed), so the
		// whole string is omitted rather than guessing.
		const bareClose = `{"password"${"\\".repeat(5)}:${"\\".repeat(5)}"SuperSecret9"${"\\".repeat(5)}}`;
		expect(redactString(config, bareClose, {})).toBe(
			"[REDACTED:suspicious-text]",
		);
		const mismatched = `{"password"${"\\".repeat(5)}:${"\\".repeat(2)}"SuperSecret9"}`;
		expect(redactString(config, mismatched, {})).toBe(
			"[REDACTED:suspicious-text]",
		);

		// Well-formed assignments are resolvable: structure-preserving
		// placeholders apply no matter how many there are, and the marker is
		// itself stable under re-redaction.
		const resolvable = '{"password":"SuperSecret9"} '.repeat(600);
		const resolvableOutput = redactString(config, resolvable, {});
		expect(resolvableOutput).not.toContain("SuperSecret9");
		expect(resolvableOutput).not.toBe("[REDACTED:suspicious-text]");
		expect(redactString(config, "[REDACTED:suspicious-text]", {})).toBe(
			"[REDACTED:suspicious-text]",
		);
	});

	it("omits suspicious text when long malformed runs defeat key parsing", () => {
		const malformed = `{"password"${"\\".repeat(50_000)}: "SuperSecret9"}`;
		const output = redactString(config, malformed, {});
		expect(output).not.toContain("SuperSecret9");
		expect(output).toContain("[REDACTED:password:");

		// A long run with no assignment shape is not suspicious text.
		const benignRun = `{"password"${"\\".repeat(50_000)}`;
		expect(redactString(config, benignRun, {})).toBe(benignRun);
	});

	it("scales linearly on repeated sensitive-word input", () => {
		const time = (fn: () => unknown) => {
			const start = performance.now();
			fn();
			return performance.now() - start;
		};
		// Quoted hint shape, unquoted hint shape, and a benign control.
		const quoted18 = '"password" '.repeat(1636);
		const quoted72 = '"password" '.repeat(6545);
		const unquoted18 = "password_ ".repeat(1800);
		const unquoted72 = "password_ ".repeat(7200);
		// Warm up and confirm benign text passes through unchanged.
		expect(redactString(config, quoted72, {})).toBe(quoted72);
		expect(redactString(config, unquoted72, {})).toBe(unquoted72);
		scanForSecrets(config, quoted72, {});
		scanForSecrets(config, unquoted72, {});

		for (const [small, large] of [
			[quoted18, quoted72],
			[unquoted18, unquoted72],
		]) {
			const smallRedact = time(() => redactString(config, small, {}));
			const largeRedact = time(() => redactString(config, large, {}));
			expect(largeRedact, `redact scaling ${large.length} bytes`).toBeLessThan(
				smallRedact * 10 + 250,
			);
			const smallScan = time(() => scanForSecrets(config, small, {}));
			const largeScan = time(() => scanForSecrets(config, large, {}));
			expect(largeScan, `scan scaling ${large.length} bytes`).toBeLessThan(
				smallScan * 10 + 250,
			);
		}
		const benign72 = "ordinary ".repeat(8000);
		expect(time(() => redactString(config, benign72, {}))).toBeLessThan(500);
		expect(time(() => scanForSecrets(config, benign72, {}))).toBeLessThan(500);
	});

	it("replaces unresolvable quoted secrets in shaped telemetry", () => {
		const depth6 = '{"password":"SuperSecret9"}'.replace(
			/"/g,
			`${"\\".repeat(63)}"`,
		);
		const sanitized = sanitizeForTelemetry(
			config,
			{ content: [{ type: "text", text: `deploy ok ${depth6} done` }] },
			{},
		);
		const text = JSON.stringify(sanitized);
		expect(text).not.toContain("SuperSecret9");
		expect(text).toContain("[REDACTED:password:");
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

	it("does not redact proper base64 data URIs or unrelated data-prefixed text", () => {
		const output = redactString(
			config,
			[
				"data:image/png;base64,abc123",
				'  path: string;\n\tdata: string;\n\tmimeType: ImageContent["mimeType"];',
				'.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });',
				"safe normal text with no data: prefix",
				'data: 0:"Hello! How can I help you today?"',
				'data: d:{"credits_used":0.0046,"tokens":{"input":60,"output":8,"total":68}}',
			].join("\n"),
			{},
		);

		expect(output).toContain("data:image/png;base64,abc123");
		expect(output).toContain("data: string;");
		expect(output).toContain('.stdout.on("data", (data: Buffer) =>');
		expect(output).toContain("safe normal text with no data: prefix");
		expect(output).toContain('data: 0:"Hello! How can I help you today?"');
		expect(output).toContain("credits_used");
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
