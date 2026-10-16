import { describe, expect, it } from "vitest";
import {
	type RedactionConfig,
	redactString,
	sanitizeForTelemetry,
	scanForSecrets,
} from "./redaction.js";

const config: RedactionConfig = {
	redactionEnabled: true,
	secretKey: "sk-lf-test-secret-1234567890",
	redactionAdditionalSecrets: [],
};

/** Placeholders: the reason, then a fixed-length fingerprint. */
const PLACEHOLDERS = new Map([
	["<R>", "\\[REDACTED:password:[0-9a-f]{10}\\]"],
	["<T>", "\\[REDACTED:token:[0-9a-f]{10}\\]"],
	["<A>", "\\[REDACTED:[a-z0-9-]+:[0-9a-f]{10}\\]"],
]);

function expectMasked(input: string, shape: string) {
	// `shape` writes a password placeholder as `<R>`, a token placeholder as
	// `<T>`, and a placeholder for any key as `<A>`; everything else is literal.
	const pattern = new RegExp(
		`^${shape
			.split(/(<[RTA]>)/)
			.map(
				(part) =>
					PLACEHOLDERS.get(part) ?? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("")}$`,
	);
	expect(redactString(config, input)).toMatch(pattern);
}

describe("unquoted sensitive assignments", () => {
	it("leaves a short non-numeric value alone when little text follows it", () => {
		expect(redactString(config, "password=ab cd")).toBe("password=ab cd");
	});

	it.each([
		["to the end of the text", "password=ab cd ef gh ij kl", "password=<R>"],
		[
			"to a newline",
			"password=ab cd ef gh ij kl\nnext line",
			"password=<R>\nnext line",
		],
		[
			"to a carriage return",
			"password=ab cd ef gh ij kl\rnext",
			"password=<R>\rnext",
		],
		[
			"to a double quote",
			'password=ab cd ef gh ij kl"tail',
			'password=<R>"tail',
		],
		[
			"to a single quote",
			"password=ab cd ef gh ij kl'tail",
			"password=<R>'tail",
		],
		[
			"to an escaped double quote, which stays outside the value",
			'password=ab cd ef gh ij kl\\"tail',
			'password=<R>\\"tail',
		],
	])(
		"redacts a short first word with free text after it, %s",
		(_name, input, shape) => {
			expectMasked(input, shape);
		},
	);

	it("redacts a short numeric value", () => {
		expectMasked("password=123", "password=<R>");
	});

	it.each([
		["a double quote", 'token=abcdefghijkl\\"tail', 'token=<T>\\"tail'],
		["a single quote", "token=abcdefghijkl\\'tail", "token=<T>\\'tail"],
		["a longer run", 'token=abcdefghijkl\\\\\\"tail', 'token=<T>\\\\\\"tail'],
	])(
		"keeps the backslash run before %s out of the value",
		(_name, input, shape) => {
			// The run escapes the quote of an enclosing string; replacing it would
			// break that string's structure.
			expectMasked(input, shape);
		},
	);
});

describe("quoted sensitive keys", () => {
	it("accepts a key whose closing quote is lost to a backslash run before the colon", () => {
		expectMasked(
			'"password\\: "secretvalue-123" tail',
			'"password\\: "<R>" tail',
		);
	});

	it("does not treat a key followed by other text as an assignment", () => {
		expect(redactString(config, '"password!value tail')).toBe(
			'"password!value tail',
		);
	});

	it.each([
		["an object end", '{"password": 12345}', '{"password": "<R>"}'],
		["an array end", '[{"password": 12345 }]', '[{"password": "<R>" }]'],
		["a comma", '{"password": 1e5, "k": 1}', '{"password": "<R>", "k": 1}'],
		["the end of the text", '"password": 12345', '"password": "<R>"'],
		[
			"the closing quote of an enclosing string",
			'"{\\"password\\": 12345"',
			'"{\\"password\\": \\"<R>\\""',
		],
	])("redacts a JSON number that ends at %s", (_name, input, shape) => {
		expectMasked(input, shape);
	});

	it.each([
		'{"password": true}',
		'{"password": null}',
		'{"password": {"set": false}}',
		'{"password": [1, 2]}',
		'{"password": }',
	])(
		"leaves a sensitive key with a JSON literal, container, or no value alone: %s",
		(input) => {
			expect(redactString(config, input)).toBe(input);
		},
	);

	it.each([
		["an object", '{"password": hunter2hunter2}', '{"password": <R>}'],
		["prose", '"password": hunter2hunter2 next', '"password": <R> next'],
		[
			"serialized JSON",
			'{\\"password\\": hunter2hunter2}',
			'{\\"password\\": <R>}',
		],
		[
			"a word that starts like a literal",
			'{"password": trueSecret99}',
			'{"password": <R>}',
		],
		[
			"a literal glued to a word",
			'{"password": true/hunter2hunter2}',
			'{"password": <R>}',
		],
		[
			"a Python literal glued to a word",
			'"password": True/hunter2hunter2',
			'"password": <R>',
		],
	])(
		"redacts a bare word value of a sensitive quoted key in %s",
		(_name, input, shape) => {
			expectMasked(input, shape);
			expect(scanForSecrets(config, redactString(config, input))).toEqual([]);
		},
	);

	it.each([
		["a lone minus sign", '{"password": -}'],
		["a fraction without digits", '{"password": 12.}'],
		["an exponent without digits", '{"password": 1e}'],
		["a leading zero", '{"password": 01}'],
		["trailing text after the number", '{"password": 12345 x}'],
	])(
		"omits the whole text for %s, since the value extent is unprovable",
		(_name, input) => {
			expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
		},
	);
});

describe("telemetry sanitizer value kinds", () => {
	const redacting = config;
	const passthrough: RedactionConfig = { ...config, redactionEnabled: false };
	const anonymous = (() => () => {})();

	it("renders bigints and functions as text when redacting", () => {
		function named() {}

		expect(sanitizeForTelemetry(redacting, [10n, named, anonymous])).toEqual([
			"10",
			"[function named]",
			"[function anonymous]",
		]);
	});

	it("keeps bigints and functions as they are when only limits apply", () => {
		function named() {}

		const output = sanitizeForTelemetry(
			passthrough,
			[10n, named],
			process.env,
			undefined,
			{ maxDepth: 5 },
		);

		expect(output).toEqual([10n, named]);
	});

	it("sanitizes an error's name, message, and stack, and tolerates a missing stack", () => {
		const withStack = new Error("failed with password=hunter2hunter2");
		const withoutStack = new Error("plain");
		delete withoutStack.stack;

		// An error leaves sanitization as a plain object, not as an Error.
		const [first, second] = sanitizeForTelemetry<unknown[]>(redacting, [
			withStack,
			withoutStack,
		]);

		expect(first).toMatchObject({
			name: "Error",
			message: expect.not.stringContaining("hunter2hunter2"),
			stack: expect.not.stringContaining("hunter2hunter2"),
		});
		expect(second).toEqual({
			name: "Error",
			message: "plain",
			stack: undefined,
		});
	});

	it("marks a cycle instead of following it", () => {
		const node: Record<string, unknown> = { label: "root" };
		node.self = node;

		expect(sanitizeForTelemetry(redacting, node)).toEqual({
			label: "root",
			self: "[Circular]",
		});
	});

	it("stops at the node budget and bounds each string by its own limit", () => {
		const limited = sanitizeForTelemetry(
			redacting,
			{ a: 1, b: 2, c: 3 },
			process.env,
			undefined,
			{ maxNodes: 2 },
		);
		const unbounded = sanitizeForTelemetry(
			redacting,
			["abcdef"],
			process.env,
			undefined,
			{ maxStringChars: 3 },
		);

		expect(limited).toEqual({ a: 1 });
		expect(unbounded).toEqual(["abc"]);
	});

	it("stops opening new values once the node budget is spent", () => {
		const output = sanitizeForTelemetry(
			redacting,
			[1, 2, 3],
			process.env,
			undefined,
			{ maxNodes: 2 },
		);

		expect(output).toEqual([1]);
	});
});

describe("card-like numbers", () => {
	it("redacts a number that passes the Luhn check and leaves one that fails it", () => {
		expect(redactString(config, "card 4111 1111 1111 1111 ok")).toMatch(
			/^card \[REDACTED:[a-z-]+:[0-9a-f]{10}\] ok$/,
		);
		expect(redactString(config, "card 1234 5678 9012 3456 ok")).toBe(
			"card 1234 5678 9012 3456 ok",
		);
	});
});

describe("telemetry sanitizer limits that omit the node budget", () => {
	it("still walks object keys under string and depth limits", () => {
		const output = sanitizeForTelemetry(
			config,
			{ label: "abcdef", nested: { inner: "ghijkl" } },
			process.env,
			undefined,
			{ maxStringChars: 3 },
		);

		expect(output).toEqual({ label: "abc", nested: { inner: "ghi" } });
	});
});

/** Redaction output with the placeholder of `reason` written as `<R>`. */
function expectShape(input: string, shape: string, reason = "password") {
	const placeholder = `\\[REDACTED:${reason}:[0-9a-f]{10}\\]`;
	const pattern = new RegExp(
		`^${shape
			.split("<R>")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(placeholder)}$`,
	);
	expect(redactString(config, input)).toMatch(pattern);
}

describe("serialized secret assignments that touch the edges of the text", () => {
	it.each(["", ",", "}", "]", ":"])(
		"redacts an escaped value whose closing quote is followed by %j or the end of the text",
		(after) => {
			expectShape(
				`\\"password\\":\\"hunter2hunter2\\"${after}`,
				`\\"password\\":\\"<R>\\"${after}`,
			);
		},
	);

	it("redacts a bare number after an escaped key that opens the text", () => {
		expectShape(
			'\\"secret\\":-12.5e3"}}',
			'\\"secret\\":\\"<R>\\""}}',
			"secret",
		);
	});

	it("redacts a value that an escaped closing quote ends at the end of the text", () => {
		expectShape(
			`[\\"x-api-key' : \\"'\\"`,
			`[\\"x-api-key' : \\"<R>\\"`,
			"x-api-key",
		);
	});

	it("redacts an unquoted escaped value followed by a structural character", () => {
		expectShape('password=\\"\\\\x\\"]}', 'password=\\"<R>\\"]}');
	});

	it("keeps a finished marker that is followed by an escaped quote and whitespace", () => {
		const input = 'password=[REDACTED:password:abcdef1234]\\"\\n ';

		expect(redactString(config, input)).toBe(input);
		expect(scanForSecrets(config, input)).toEqual([]);
	});

	it.each([
		'"token":"[REDACTED:password:abcdef1234]\\"}',
		'token="}tt\\\nr":b,np\\',
	])(
		"omits the whole text when the extent of a value cannot be proven: %j",
		(input) => {
			expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
			expect(
				scanForSecrets(config, input).map((finding) => finding.reason),
			).toEqual(["suspicious-text"]);
		},
	);
});

describe("unquoted values and their delimiters", () => {
	it.each(['"', "'", "`", ",", "}", "]"])(
		"ends an unquoted value at %j and keeps the text after it",
		(delimiter) => {
			expectShape(
				`password=hunter2hunter2${delimiter}tail`,
				`password=<R>${delimiter}tail`,
			);
		},
	);

	it("redacts a six-character value and leaves a five-character one", () => {
		expectShape("password=abcdef", "password=<R>");
		expect(redactString(config, "password=abcde")).toBe("password=abcde");
	});

	it("redacts a short value only when twelve characters of its line follow", () => {
		expect(redactString(config, "password=abcd efgh i")).toBe(
			"password=abcd efgh i",
		);
		expectShape("password=abcd efgh ij", "password=<R>");
	});

	it("finds a key after a backslash run that opens no quote", () => {
		expectShape("dir\\\\token=abcdefghijkl", "dir\\\\token=<R>", "token");
		expectShape(
			"\\\\x-api-key : 12345678901",
			"\\\\x-api-key : <R>",
			"x-api-key",
		);
		expectShape(
			"\\\\x-api-key : 12345678901\\",
			"\\\\x-api-key : <R>",
			"x-api-key",
		);
	});
});

describe("number-like values of sensitive keys", () => {
	it.each(["0", "1", "5", "9", "-"])(
		"omits the whole text when a value starting with %s has no provable number end",
		(first) => {
			const input = `{"password":${first}x}`;

			expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
			expect(
				scanForSecrets(config, input).map((finding) => finding.reason),
			).toEqual(["suspicious-text"]);
		},
	);
});

describe("exact secrets of extreme length and overlapping secrets", () => {
	const MAX_EXACT_SECRET_LENGTH = 20_000;
	const withSecrets = (...redactionAdditionalSecrets: string[]) => ({
		...config,
		redactionAdditionalSecrets,
	});

	it("redacts a configured secret of exactly the maximum length and ignores a longer one", () => {
		// The `!` keeps the text from also matching the long-blob pattern.
		const longest = `s${"x!".repeat((MAX_EXACT_SECRET_LENGTH - 2) / 2)}x`;
		const tooLong = `t${"y!".repeat(MAX_EXACT_SECRET_LENGTH / 2)}`;
		expect(longest).toHaveLength(MAX_EXACT_SECRET_LENGTH);
		expect(tooLong).toHaveLength(MAX_EXACT_SECRET_LENGTH + 1);

		const output = redactString(
			withSecrets(longest, tooLong),
			`a ${longest} b ${tooLong} c`,
		);

		expect(output).toContain("[REDACTED:configured-secret:");
		expect(output).not.toContain(longest);
		expect(output).toContain(tooLong);
	});

	it("replaces the longest of overlapping configured secrets first, whatever their order", () => {
		const shortSecret = "overlapping-secret-1234";
		const longSecret = `${shortSecret}-with-a-private-tail`;

		for (const order of [
			[longSecret, shortSecret],
			[shortSecret, longSecret],
		]) {
			const output = redactString(withSecrets(...order), `x ${longSecret} y`);

			expect(output).not.toContain("private-tail");
			expect(output).not.toContain(shortSecret);
		}
	});
});

describe("blob placeholders", () => {
	it.each([
		["a long base64 blob", "A".repeat(140), "long-base64-blob"],
		["a long hex blob", "a".repeat(100), "long-hex-blob"],
		["a data URL", `data:image/png;base64,${"B".repeat(60)}`, "data-url"],
	])(
		"records the length of %s next to its placeholder",
		(_name, blob, reason) => {
			const output = redactString(config, `before ${blob} after`);

			expect(output).toMatch(
				new RegExp(
					`^before \\[REDACTED:${reason}:[0-9a-f]{10}\\]\\(${blob.length} chars\\) after$`,
				),
			);
		},
	);
});

describe("telemetry sanitizer budgets at their exact limits", () => {
	const limited = (value: unknown, limits: Record<string, number>) =>
		sanitizeForTelemetry(config, value, process.env, undefined, limits);

	it("keeps exactly the configured number of array items", () => {
		expect(limited([1, 2, 3, 4], { maxArrayItems: 2 })).toEqual([1, 2]);
		expect(limited([1, 2, 3], { maxArrayItems: 3 })).toEqual([1, 2, 3]);
	});

	it("counts each array level toward the depth budget", () => {
		expect(limited([[[1]]], { maxDepth: 2 })).toEqual([["[TRUNCATED:depth]"]]);
	});

	it("counts the fields of an error toward the depth budget", () => {
		const nested = () => ({ a: { b: 1 } });
		const error = Object.assign(new Error("m"), {
			name: nested(),
			message: nested(),
			stack: nested(),
		});

		expect(limited(error, { maxDepth: 2 })).toEqual({
			name: { a: "[TRUNCATED:depth]" },
			message: { a: "[TRUNCATED:depth]" },
			stack: { a: "[TRUNCATED:depth]" },
		});
	});

	it("drops a sensitive key that comes after the node budget is spent", () => {
		expect(
			limited({ a: 1, password: "hunter2hunter2" }, { maxNodes: 2 }),
		).toEqual({ a: 1 });
	});
});

describe("several secret assignments in one text", () => {
	it.each([
		[
			"plain JSON",
			'{"password":"hunter2hunter2","token":"abcdefghijkl"}',
			'{"password":"<R>","token":"<T>"}',
		],
		[
			"JSON serialized once more",
			'{\\"password\\":\\"hunter2hunter2\\",\\"token\\":\\"abcdefghijkl\\"}',
			'{\\"password\\":\\"<R>\\",\\"token\\":\\"<T>\\"}',
		],
		[
			"JSON serialized twice",
			'{\\\\"password\\\\":\\\\"hunter2hunter2\\\\",\\\\"token\\\\":\\\\"abcdefghijkl\\\\"}',
			'{\\\\"password\\\\":\\\\"<R>\\\\",\\\\"token\\\\":\\\\"<T>\\\\"}',
		],
		[
			"single-quoted pairs",
			"{'password':'hunter2hunter2','token':'abcdefghijkl'}",
			"{'password':'<R>','token':'<T>'}",
		],
		[
			"separated by a space",
			'"password":"hunter2hunter2" "token":"abcdefghijkl"',
			'"password":"<R>" "token":"<T>"',
		],
		[
			"pairs that share a quote",
			'"password":"hunter2hunter2"token":"abcdefghijkl"',
			'"password":"<R>"token":"<T>"',
		],
		[
			"single-quoted pairs that share a quote",
			"'password':'hunter2hunter2'token':'abcdefghijkl'",
			"'password':'<R>'token':'<T>'",
		],
		[
			"serialized pairs that share a quote",
			'\\"password\\":\\"hunter2hunter2\\",token\\":\\"abcdefghijkl\\"',
			'\\"password\\":\\"<R>\\",token\\":\\"<T>\\"',
		],
		[
			"a quoted pair then an unquoted pair",
			'"password":"hunter2hunter2" token=abcdefghijkl',
			'"password":"<R>" token=<T>',
		],
		[
			"a single-quoted pair then an unquoted pair",
			"'password':'hunter2hunter2' token=abcdefghijkl",
			"'password':'<R>' token=<T>",
		],
		[
			"a serialized pair then an unquoted pair",
			'\\"password\\":\\"hunter2hunter2\\",token=abcdefghijkl',
			'\\"password\\":\\"<R>\\",token=<T>',
		],
		[
			"an empty value then an unquoted pair",
			'"password":"" token=abcdefghijkl',
			'"password":"" token=<T>',
		],
		[
			"a marker value then an unquoted pair",
			'"password":"[REDACTED:password:abcdef1234]" token=abcdefghijkl',
			'"password":"[REDACTED:password:abcdef1234]" token=<T>',
		],
		[
			"a contraction before an unquoted pair",
			"it's fine password=abcdefghijkl",
			"it's fine password=<R>",
		],
		[
			"quoted prose before an unquoted pair",
			'say "hi" then password=abcdefghijkl',
			'say "hi" then password=<R>',
		],
		[
			"a JSON object before an unquoted pair",
			'{"a":"b"} password=abcdefghijkl',
			'{"a":"b"} password=<R>',
		],
		[
			"a non-sensitive pair before an unquoted pair",
			'"name":"bob" token=abcdefghijkl',
			'"name":"bob" token=<T>',
		],
		[
			"an assignment inside a JSON string value",
			'"note":"set password=abcdefghijkl now"',
			'"note":"set password=<R> now"',
		],
		[
			"a shared-quote pair with a non-string value, then an unquoted pair",
			'"password":"hunter2hunter2"token":true token=abcdefghijkl',
			// `true` before a word is not a JSON literal, so the line is the value.
			'"password":"<R>"token":<T>',
		],
		[
			"a shared quote that opens a key made of prose",
			'"password":"a" x token=abcdefghijkl":"b"',
			'"password":"<R>" x token=<T>":"b"',
		],
		[
			"an assignment inside a sensitive key",
			'"secret token=abcdefghijkl":"b"',
			'"secret token=<T>":"<A>"',
		],
		[
			"an assignment inside a sensitive key whose value is not a string",
			'"secret token=abcdefghijkl": true',
			'"secret token=<T>": true',
		],
		[
			"an assignment inside a serialized sensitive key",
			'{\\"secret token=abcdefghijkl\\":\\"b\\"}',
			'{\\"secret token=<T>\\":\\"<A>\\"}',
		],
		[
			"a JSON object then a quoted pair",
			'{"a":"b"} password="hunter2hunter2"',
			'{"a":"b"} password="<R>"',
		],
		[
			"an assignment inside a string value of serialized JSON",
			'{\\"note\\":\\"password: hunter2hunter2\\"}',
			'{\\"note\\":\\"password: <R>\\"}',
		],
	])("redacts every assignment in %s", (_name, input, shape) => {
		const redacted = redactString(config, input);
		expectMasked(input, shape);
		// The export residual scanner shares this parser: it must report each
		// placeholder's secret before redaction and nothing after it.
		const reasons = scanForSecrets(config, input).map(
			(finding) => finding.reason,
		);
		if (shape.includes("<R>")) expect(reasons).toContain("password");
		if (shape.includes("<T>")) expect(reasons).toContain("token");
		expect(scanForSecrets(config, redacted)).toEqual([]);
	});

	it("omits the text when an assignment inside a key has no provable extent", () => {
		const input = '"secret token=[REDACTED:x":"b"';

		expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
		expect(
			scanForSecrets(config, input).map((finding) => finding.reason),
		).toContain("suspicious-text");
	});

	it.each([
		["a colon", "Enter your password:"],
		["a colon and a blank", "Enter your password: "],
		["an equals sign", "set token="],
		["a colon and a newline", "Enter your password:\n"],
		["a colon and a tab", "Enter your password:\t"],
		["an equals sign and a line break", "set token=\r\n"],
	])(
		"keeps JSON whose string ends with an assignment that has no value, %s",
		(_name, note) => {
			// The quote after the separator closes the string; it does not open a
			// quoted value that would swallow the structure after it.
			for (const document of [
				{ msg: note },
				{ msg: note, next: "x", count: 1 },
				[note, "x"],
				[[note], 1],
			]) {
				let input = JSON.stringify(document);
				for (let depth = 0; depth < 4; depth += 1) {
					expect(redactString(config, input)).toBe(input);
					expect(scanForSecrets(config, input)).toEqual([]);
					input = JSON.stringify(input);
				}
			}
		},
	);

	it("keeps a JSON key that ends with an assignment that has no value", () => {
		// `public key` is not sensitive, so the key is text whose last word is
		// an assignment; the quote after it closes the key.
		let input = JSON.stringify({ "public key=": 1 });
		for (let depth = 0; depth < 4; depth += 1) {
			expect(redactString(config, input)).toBe(input);
			expect(scanForSecrets(config, input)).toEqual([]);
			input = JSON.stringify(input);
		}
	});

	it.each([
		["after an apostrophe", `it's fine password=",hunter2hunter2"`],
		[
			"after an apostrophe and a line break",
			`it's fine password=\n ",hunter2hunter2"`,
		],
		["in a quoted note", `"note password=",hunter2hunter2"`],
		["after an encoded newline", `"note password=\\n"]hunter2hunter2"`],
		[
			"after a quoted word, with a digit after the comma",
			`say "hi" then password=\n ",123456hunter2hunter2"`,
		],
		[
			"after a quoted word, with a literal after the comma",
			`say "hi" then password=",true hunter2hunter2"`,
		],
		[
			"after a quoted word, never closed",
			`say "hi" then password=\n ",hunter2hunter2`,
		],
		[
			"after a quoted word, glued to a word",
			`say "hi" then password=\n ",hunter2hunter2"tail`,
		],
		[
			"after a quoted word, with a quote of the other kind inside",
			`say "hi" then password=\n ",1234'hunter2hunter2"`,
		],
		[
			"after a quoted word, with a line break and a quote inside",
			`say "hi" then password=\n ",1234\n'hunter2hunter2"`,
		],
		[
			"after a single-quoted word, with an escaped quote inside",
			`say 'hi' then password=',1234\\'hunter2hunter2'`,
		],
		[
			"after a quoted word, with an escaped quote inside",
			`say "hi" then password=\n ",1234\\"hunter2hunter2"`,
		],
	])(
		"does not leak a quoted value that starts with structure, %s",
		(_name, input) => {
			// The quote can open this value or close the text before the
			// assignment. A quote of another kind opens the value; when both
			// readings fit, the whole text is omitted.
			const redacted = redactString(config, input);

			expect(redacted).not.toContain("hunter2hunter2");
			expect(scanForSecrets(config, input)).not.toEqual([]);
			expect(scanForSecrets(config, redacted)).toEqual([]);
			// The same text inside a JSON string, at several serialization depths.
			let document = JSON.stringify({ msg: input });
			for (let depth = 0; depth < 4; depth += 1) {
				expect(redactString(config, document)).not.toContain("hunter2hunter2");
				document = JSON.stringify(document);
			}
		},
	);

	it.each([
		[
			"a string ending in a backslash",
			JSON.stringify({ msg: "Enter password: \\", next: "safe" }),
		],
		[
			"several strings ending in a backslash",
			JSON.stringify([
				{ msg: "Enter password: \\", safe: 1 },
				{ msg: "Enter password: \\", safe: 2 },
			]),
		],
		["JSON Lines", '{"msg":"Enter password:"}\n{"next":"safe"}'],
		["fenced JSON", '```json\n{"msg":"Enter password:"}\n```'],
		["a Python list with None", "['Enter password:', None]"],
		["a Python list with True", "['Enter password:', True]"],
	])("keeps %s around a string that ends with an assignment", (_name, text) => {
		let input = text;
		for (let depth = 0; depth < 4; depth += 1) {
			expect(redactString(config, input)).toBe(input);
			expect(scanForSecrets(config, input)).toEqual([]);
			input = JSON.stringify(input);
		}
	});

	it("omits JSON followed by prose when its last string ends with an assignment", () => {
		// Known limitation: locally this reads like `password="} was printed`,
		// an unterminated value, so the extent is unprovable.
		expect(redactString(config, '{"msg":"Enter password:"} was printed')).toBe(
			"[REDACTED:suspicious-text]",
		);
	});

	it("keeps JSON around a single-quoted value that holds an encoded escaped quote", () => {
		// JSON doubles the backslash before the apostrophe but not the opening
		// apostrophe, so the even run marks content, not the value's close.
		const row = "say 'hi' then password=',1234\\'hunter2hunter2'";
		const input = JSON.stringify({ note: row, safe: 1 });

		const redacted = redactString(config, input);

		expect(redacted).not.toContain("hunter2hunter2");
		expect(JSON.parse(redacted)).toEqual({
			note: expect.stringMatching(
				/^say 'hi' then password='\[REDACTED:password:[0-9a-f]{10}\]'$/,
			),
			safe: 1,
		});
	});

	it("does not let a secret inside a key name the placeholder of its value", () => {
		const input = '{"password=hunter2hunter2":"val"}';

		expect(redactString(config, input)).not.toContain("hunter2hunter2");
		expect(
			scanForSecrets(config, input).map((finding) => finding.reason),
		).not.toContainEqual(expect.stringContaining("hunter2hunter2"));
	});

	it("omits serialized pairs that share a quote without a delimiter", () => {
		// At one serialization depth the shared quote has the same backslash
		// run as a real close but no structural continuation, so the first
		// value's extent is unprovable.
		const input = JSON.stringify(
			'"password":"hunter2hunter2"token":"abcdefghijkl"',
		);

		expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
	});

	it.each([
		["request\\key", "turn:0:request:0"],
		["public\\key", "public-correlation-value"],
		["total\\token", 12345],
	])(
		"keeps the JSON key %j, whose escaped backslash precedes a sensitive word",
		(key, value) => {
			// The decoded key normalizes to an exempt name, so the value is kept.
			const input = JSON.stringify({ [key]: value });

			expect(redactString(config, input)).toBe(input);
			expect(scanForSecrets(config, input)).toEqual([]);
		},
	);

	it("redacts a long chain of pairs that share quotes", () => {
		const input = `"password":"hunter2hunter2"${'token":"abcdefghijkl"'.repeat(2000)}`;

		const redacted = redactString(config, input);
		expect(redacted).not.toContain("abcdefghijkl");
		expect(scanForSecrets(config, input)).toContainEqual({
			reason: "token",
			count: 2000,
		});
		expect(scanForSecrets(config, redacted)).toEqual([]);
	});

	it.each([0, 1, 2, 3])(
		"keeps JSON decodable when strings hold assignments, serialized %i more times",
		(depth) => {
			// Each string value ends at its closing quote, whose escape run must
			// stay outside the redacted value at every serialization depth.
			const document = {
				note: "set password: hunter2hunter2",
				prose: "password: ab cd ef gh ij kl",
				short: "pin=1234",
				keep: "unrelated text",
				count: 1,
			};
			let input = JSON.stringify(document);
			for (let layer = 0; layer < depth; layer += 1) {
				input = JSON.stringify(input);
			}

			let output = redactString(config, input);
			for (let layer = 0; layer < depth; layer += 1) {
				output = JSON.parse(output) as string;
			}

			expect(JSON.parse(output)).toEqual({
				note: expect.stringMatching(
					/^set password: \[REDACTED:password:[0-9a-f]{10}\]$/,
				),
				prose: expect.stringMatching(
					/^password: \[REDACTED:password:[0-9a-f]{10}\]$/,
				),
				short: expect.stringMatching(/^pin=\[REDACTED:pin\]$/),
				keep: "unrelated text",
				count: 1,
			});
			expect(scanForSecrets(config, input).map((f) => f.reason)).toEqual(
				expect.arrayContaining(["password", "pin"]),
			);
			expect(scanForSecrets(config, redactString(config, input))).toEqual([]);
		},
	);

	const trailingBackslash = { password: "a\\", note: "keep me", count: 123 };
	const trailingBackslashShape = {
		password: "<R>",
		note: "keep me",
		count: 123,
	};
	it.each([
		[
			"serialized once more",
			JSON.stringify(JSON.stringify(trailingBackslash)),
			JSON.stringify(JSON.stringify(trailingBackslashShape)),
		],
		[
			"serialized twice more",
			JSON.stringify(JSON.stringify(JSON.stringify(trailingBackslash))),
			JSON.stringify(JSON.stringify(JSON.stringify(trailingBackslashShape))),
		],
		[
			"embedded in a log line",
			JSON.stringify({
				event: "tool",
				body: JSON.stringify(trailingBackslash),
				safe: 456,
			}),
			JSON.stringify({
				event: "tool",
				body: JSON.stringify(trailingBackslashShape),
				safe: 456,
			}),
		],
	])(
		"keeps the fields after a value that ends with a backslash, %s",
		(_name, input, shape) => {
			// Trailing content backslashes lengthen the real close's run; it
			// still closes the value at that serialization depth.
			expectMasked(input, shape);
			expect(scanForSecrets(config, redactString(config, input))).toEqual([]);
		},
	);
});

describe("where a quoted value or a candidate string ends", () => {
	it("keeps the text around an escaped value that holds an escaped quote", () => {
		// Serialized once, the value `a\"b` has a three-backslash run before its
		// inner quote. Only a run of the opening quote's length (plus pairs of
		// content backslashes) closes the value, so the inner quote cannot end it.
		expectShape(
			'{\\"password\\":\\"a\\\\\\"b\\"}',
			'{\\"password\\":\\"<R>\\"}',
		);
	});

	it("redacts a value that ends with a backslash in plain JSON", () => {
		// The encoded content backslash pair leaves the closing quote
		// unescaped, so it closes the value and the JSON keeps its structure.
		const input = JSON.stringify({
			password: "SuperSecret9\\",
			note: "keep me",
		});

		const redacted = redactString(config, input);

		expect(JSON.parse(redacted)).toEqual({
			password: expect.stringMatching(/^\[REDACTED:password:[0-9a-f]{10}\]$/),
			note: "keep me",
		});
		expect(scanForSecrets(config, redacted)).toEqual([]);
	});

	it.each([
		["a space", "token=abcdefghijkl\\ next", "token=<T> next"],
		["a closing brace", "token=abcdefghijkl\\}next", "token=<T>}next"],
	])(
		"keeps a backslash before %s inside an unquoted value",
		(_name, input, shape) => {
			// Only a backslash run before a quote escapes it for an enclosing
			// string and stays outside the value. Before any other stop character
			// it is value text, and a secret may end with a backslash.
			expectMasked(input, shape);
		},
	);

	it.each([
		["a lone letter n", '{"msg":"Enter password:"} n'],
		[
			"a backslash and a letter that is no escape",
			'{"msg":"Enter password:"} \\x',
		],
	])(
		"omits the whole text when %s follows a string that ends with a key",
		(_name, input) => {
			// Such a stretch holds a word, so the quote after `password:` may open
			// a value whose extent cannot be proven.
			expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
		},
	);

	it.each([
		["a quote of the other kind after an open candidate", `"password: '}`],
		["an opening quote at the end of the text", 'password="'],
		["a single opening quote before a closing brace", "password='}"],
	])("omits the whole text for an unterminated value: %s", (_name, input) => {
		expect(redactString(config, input)).toBe("[REDACTED:suspicious-text]");
	});

	it("names the value after the whole key when a backslash run ends the key", () => {
		expectShape(
			'"user password\\: "secretvalue-123" tail',
			'"user password\\: "<R>" tail',
			"user-password",
		);
	});

	it("names the value after the word before the separator when whitespace follows the run", () => {
		// The run is not directly followed by the colon, so the quoted text is
		// no key; the unquoted word `password` is.
		expectShape(
			'"user password\\ : "secretvalue-123" tail',
			'"user password\\ : "<R>" tail',
		);
	});
});
