import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type IdentityConfig,
	identityTransformFor,
	parseIdentityMode,
	parseStrictBoolean,
} from "./identity.js";
import {
	type PayloadPolicyConfig,
	shapeLangfuseObservationBody,
	shapeLangfuseTraceBody,
	shapeRawTraceRecord,
} from "./payload-policy.js";
import {
	redactString,
	sanitizeForTelemetry,
	scanForSecrets,
} from "./redaction.js";

const HOME = "/home/pseudo-user";
const SALT_A = "a".repeat(64);
const SALT_B = "b".repeat(64);
const ENCODED_HOME = "home-pseudo-user";

function pseudonymous(
	overrides: Partial<PayloadPolicyConfig> = {},
): PayloadPolicyConfig {
	return {
		redactionEnabled: true,
		identityMode: "pseudonymous",
		identitySalt: SALT_A,
		identityHome: HOME,
		...overrides,
	};
}

function serialized(value: unknown) {
	return JSON.stringify(value);
}

function countOf(text: string, needle: string) {
	return text.split(needle).length - 1;
}

const HOME_OCCURRENCES = 1001;

/** A nested payload with exactly 1001 occurrences of the home directory. */
function homeFixture() {
	const make = (index: number): [unknown, number] => {
		switch (index % 7) {
			case 0:
				return [`${HOME}/projects/app/src/file-${index}.ts`, 1];
			case 1:
				return [{ path: `${HOME}/notes/${index}.md`, nested: [HOME] }, 2];
			case 2:
				return [`see "${HOME}/a.log", then ${HOME}/b.log.`, 2];
			case 3:
				// A serialized fragment inside plain text.
				return [
					JSON.stringify({ file: `${HOME}/serialized/${index}.json` }),
					1,
				];
			case 4:
				// Object keys are emitted strings too.
				return [{ [`${HOME}/key-${index}`]: 1 }, 1];
			case 5:
				return [`file://${HOME}/url/${index}`, 1];
			default:
				return [[[HOME], `at ${HOME}/stack/${index}.js:1:2`], 2];
		}
	};
	const items: unknown[] = [];
	let count = 0;
	for (let index = 0; count < HOME_OCCURRENCES; index += 1) {
		const [item, occurrences] = make(index);
		if (count + occurrences > HOME_OCCURRENCES) {
			items.push(`${HOME}/tail-${index}`);
			count += 1;
		} else {
			items.push(item);
			count += occurrences;
		}
	}
	return { messages: [{ role: "tool", content: items }] };
}

describe("identity pseudonymization output boundary", () => {
	it("removes every home-prefix occurrence from a nested 1001-occurrence fixture", () => {
		const input = homeFixture();
		expect(countOf(serialized(input), HOME)).toBe(HOME_OCCURRENCES);

		const output = sanitizeForTelemetry(pseudonymous(), input);

		expect(countOf(serialized(output), HOME)).toBe(0);
		expect(serialized(output)).toContain("~/projects/app/src/file-0.ts");
		expect(serialized(output)).toContain("~/notes/1.md");
		expect(serialized(output)).toContain('see \\"~/a.log\\", then ~/b.log.');
		expect(serialized(output)).toContain("~/serialized/3.json");
		expect(serialized(output)).toContain('"~/key-4":1');
		expect(serialized(output)).toContain("file://~/url/5");
	});

	it("normalizes errors, plain text, and the same output with redaction disabled", () => {
		const error = new Error(`ENOENT: no such file ${HOME}/missing.txt`);
		for (const redactionEnabled of [true, false]) {
			const output = sanitizeForTelemetry(pseudonymous({ redactionEnabled }), {
				error,
				text: `cwd is ${HOME}`,
			});
			expect(countOf(serialized(output), HOME)).toBe(0);
			expect(output.text).toBe("cwd is ~");
			expect(output.error.message).toBe("ENOENT: no such file ~/missing.txt");
			expect(output.error.stack).not.toContain(HOME);
		}
		expect(redactString(pseudonymous(), `open ${HOME}/x`)).toBe("open ~/x");
		expect(
			redactString(pseudonymous({ redactionEnabled: false }), `open ${HOME}/x`),
		).toBe("open ~/x");
	});

	it("changes only text at a directory boundary", () => {
		const output = sanitizeForTelemetry(pseudonymous(), [
			`${HOME}2/other`,
			`${HOME}-backup/other`,
			`${HOME}.bak/other`,
			`/srv${HOME}/other`,
			`./${HOME.slice(1)}/relative`,
			`~${HOME}/tilde-relative`,
			`${HOME}/`,
			HOME,
			`${HOME}.`,
			`-I${HOME}/include`,
			`env-${HOME}`,
		]);
		expect(output).toEqual([
			`${HOME}2/other`,
			`${HOME}-backup/other`,
			`${HOME}.bak/other`,
			`/srv${HOME}/other`,
			`./${HOME.slice(1)}/relative`,
			`~${HOME}/tilde-relative`,
			"~/",
			"~",
			"~.",
			"-I~/include",
			"env-~",
		]);
	});

	it("replaces the home directory inside Pi's encoded session folder names", () => {
		const sessionFile = `${HOME}/.pi/agent/sessions/--${ENCODED_HOME}-projects-app--/2026-10-14T00-00-00-000Z_abc.jsonl`;
		const output = sanitizeForTelemetry(pseudonymous(), {
			sessionFile,
			sessionRoot: `${HOME}/.pi/agent/sessions`,
			previousSessionFile: `/tmp/other/sessions/--${ENCODED_HOME}--/old.jsonl`,
			metadata: { raw: `--${ENCODED_HOME}x-keep--` },
		});
		expect(output.sessionFile).toBe(
			"~/.pi/agent/sessions/--~-projects-app--/2026-10-14T00-00-00-000Z_abc.jsonl",
		);
		expect(output.sessionRoot).toBe("~/.pi/agent/sessions");
		expect(output.previousSessionFile).toBe(
			"/tmp/other/sessions/--~--/old.jsonl",
		);
		// A longer name is a different folder and stays as captured.
		expect(output.metadata.raw).toBe(`--${ENCODED_HOME}x-keep--`);
		expect(
			serialized([
				output.sessionFile,
				output.sessionRoot,
				output.previousSessionFile,
			]),
		).not.toContain(ENCODED_HOME);
	});

	it("hashes user and repository identity with a stable salted pseudonym", () => {
		const input = {
			userId: "pseudo-user",
			metadata: {
				repo_identity: "acme/secret-repo",
				repo_owner: "acme",
				repo_name: "secret-repo",
				git_remote_path: "acme/secret-repo",
				repo_root_name: "secret-checkout",
				git_remote_host: "github.com",
				git_branch: "main",
			},
			tags: ["pi", "project:secret-checkout", "provider:faux"],
		};
		const first = sanitizeForTelemetry(pseudonymous(), input);
		const again = sanitizeForTelemetry(pseudonymous(), input);
		const other = sanitizeForTelemetry(
			pseudonymous({ identitySalt: SALT_B }),
			input,
		);

		expect(again).toEqual(first);
		expect(first.userId).toMatch(/^pseudonym-user-[0-9a-f]{24}$/);
		expect(first.userId).not.toBe(other.userId);
		for (const key of [
			"repo_identity",
			"repo_owner",
			"repo_name",
			"git_remote_path",
			"repo_root_name",
		]) {
			const value = first.metadata[key as keyof typeof first.metadata];
			expect(value).toMatch(/^pseudonym-[a-z-]+-[0-9a-f]{24}$/);
			expect(value).not.toBe(
				other.metadata[key as keyof typeof other.metadata],
			);
		}
		// Non-identity fields are left as captured.
		expect(first.metadata.git_remote_host).toBe("github.com");
		expect(first.metadata.git_branch).toBe("main");
		expect(first.tags[0]).toBe("pi");
		expect(first.tags[1]).toMatch(/^project:pseudonym-project-[0-9a-f]{24}$/);
		expect(first.tags[2]).toBe("provider:faux");
		const text = serialized(first);
		for (const leaked of [
			"pseudo-user",
			"acme",
			"secret-repo",
			"secret-checkout",
		]) {
			expect(text).not.toContain(leaked);
		}
	});

	it("never hashes an already pseudonymized identity again, including across shaping passes", () => {
		const config = pseudonymous();
		const body = {
			name: "agent.prompt",
			userId: "pseudo-user",
			tags: ["project:secret-checkout"],
			metadata: {
				repo_identity: "acme/secret-repo",
				cwd: `${HOME}/work/secret-checkout`,
			},
		};
		const once = shapeLangfuseTraceBody(config, body);
		const twice = shapeLangfuseTraceBody(config, once);
		const thrice = shapeLangfuseObservationBody(config, "agent.prompt", twice);

		expect(twice).toEqual(once);
		expect(thrice).toEqual(once);
		expect(once.metadata.cwd).toBe("~/work/secret-checkout");
	});

	it("covers source-metadata overrides through the same key rules", () => {
		const output = shapeRawTraceRecord(pseudonymous(), {
			type: "prompt_start",
			timestamp: "2026-10-14T00:00:00.000Z",
			sourceMetadata: {
				metadata_source: "repo-file",
				repo_identity: "override-owner/override-name",
				repo_owner: "override-owner",
				repo_name: "override-name",
				// Not an identity key: an override label stays as written.
				project_slug: "visible-slug",
			},
		}) as { sourceMetadata: Record<string, string> };
		const text = serialized(output);
		expect(text).not.toContain("override-owner");
		expect(text).not.toContain("override-name");
		expect(output.sourceMetadata.repo_identity).toMatch(/^pseudonym-/);
		expect(output.sourceMetadata.project_slug).toBe("visible-slug");
	});

	it("keeps repository identity readable only when identityKeepRepo is true", () => {
		const input = {
			userId: "pseudo-user",
			metadata: {
				repo_identity: "acme/secret-repo",
				repo_root_name: "secret-checkout",
				cwd: `${HOME}/secret-checkout`,
			},
			tags: ["project:secret-checkout"],
		};
		const kept = sanitizeForTelemetry(
			pseudonymous({ identityKeepRepo: true }),
			input,
		);
		expect(kept.metadata.repo_identity).toBe("acme/secret-repo");
		expect(kept.metadata.repo_root_name).toBe("secret-checkout");
		expect(kept.tags).toEqual(["project:secret-checkout"]);
		// User and home protection do not depend on keeping the repository.
		expect(kept.userId).toMatch(/^pseudonym-user-/);
		expect(kept.metadata.cwd).toBe("~/secret-checkout");

		for (const identityKeepRepo of [false, undefined]) {
			const hashed = sanitizeForTelemetry(
				pseudonymous({ identityKeepRepo }),
				input,
			);
			expect(hashed.metadata.repo_identity).toMatch(/^pseudonym-/);
			expect(hashed.tags[0]).toMatch(/^project:pseudonym-/);
		}
	});

	it("keeps the salt out of output by key and by literal even with redaction disabled", () => {
		for (const redactionEnabled of [true, false]) {
			const output = sanitizeForTelemetry(pseudonymous({ redactionEnabled }), {
				identitySalt: SALT_A,
				note: `salt ${SALT_A} was read`,
				nested: { identity_salt: SALT_A },
			});
			expect(serialized(output)).not.toContain(SALT_A);
		}
		// Raw mode never loads the salt, but a config dump still redacts the key.
		const dumped = sanitizeForTelemetry(
			{ redactionEnabled: true },
			{ identitySalt: SALT_A },
		);
		expect(serialized(dumped)).not.toContain(SALT_A);
	});

	it("fails closed instead of emitting raw identity when the salt is unavailable", () => {
		for (const identitySalt of [undefined, "", "short", "G".repeat(64)]) {
			const config = pseudonymous({ identitySalt });
			expect(() => sanitizeForTelemetry(config, { userId: "x" })).toThrow(
				/identity salt/,
			);
			expect(() => redactString(config, "text")).toThrow(/identity salt/);
			expect(() => identityTransformFor(config as IdentityConfig)).toThrow(
				/no valid identity salt/,
			);
		}
	});
});

describe("identity with exact secret literals that contain the home path", () => {
	const CONFIGURED = `${HOME}/credential_opaque_12345`;
	const FROM_ENV = `${HOME}/environment_opaque_67890`;
	const ENV_KEY = "PI_LANGFUSE_TEST_HOME_API_TOKEN";
	const config = (overrides: Partial<PayloadPolicyConfig> = {}) =>
		pseudonymous({ redactionAdditionalSecrets: [CONFIGURED], ...overrides });

	function withEnvSecret<T>(run: () => T): T {
		const previous = process.env[ENV_KEY];
		process.env[ENV_KEY] = FROM_ENV;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env[ENV_KEY];
			else process.env[ENV_KEY] = previous;
		}
	}

	function expectNoSecretBytes(output: unknown) {
		const text = serialized(output);
		for (const fragment of [
			"credential_opaque_12345",
			"environment_opaque_67890",
		]) {
			expect(text).not.toContain(fragment);
		}
		expect(text).not.toContain(HOME);
	}

	it("redacts configured and environment literals in the shared string boundary", () => {
		const env = { [ENV_KEY]: FROM_ENV };
		const output = redactString(
			config(),
			`a ${CONFIGURED} b ${FROM_ENV} c ${HOME}/plain.txt`,
			env,
		);
		expectNoSecretBytes(output);
		expect(output).toContain("[REDACTED:configured-secret:");
		expect(output).toContain(
			`[REDACTED:${ENV_KEY.toLowerCase().replaceAll("_", "-")}:`,
		);
		// Ordinary paths are still normalized after the literals are removed.
		expect(output).toContain(" c ~/plain.txt");
	});

	it("redacts the same literals in strings nested in structured payloads", () => {
		const env = { [ENV_KEY]: FROM_ENV };
		const output = sanitizeForTelemetry(
			config(),
			{ content: CONFIGURED, nested: [{ text: `x ${FROM_ENV}` }] },
			env,
		);
		expectNoSecretBytes(output);
		expect(output.content).toMatch(/^\[REDACTED:configured-secret:/);
	});

	it("redacts the literals at the Langfuse body and raw-trace output boundaries", () => {
		withEnvSecret(() => {
			const policy = config({ capturePolicy: "full-debug" });
			expectNoSecretBytes(
				shapeLangfuseObservationBody(policy, "agent.turn", {
					input: [{ role: "user", content: `${CONFIGURED} ${FROM_ENV}` }],
				}),
			);
			expectNoSecretBytes(
				shapeRawTraceRecord(policy, {
					type: "prompt_start",
					prompt: `${CONFIGURED} ${FROM_ENV}`,
				}),
			);
		});
	});

	it("still removes the identity salt and the home path when redaction is disabled", () => {
		const output = sanitizeForTelemetry(
			config({ redactionEnabled: false }),
			{ note: `${HOME}/x ${SALT_A}` },
			{},
		);
		expect(output.note).toBe("~/x [REDACTED:identity-salt]");
	});

	it("keeps the fixed salt marker when redaction is enabled", () => {
		for (const identitySalt of [
			SALT_A,
			"9f86d081884c7d659a2feaa0c55ad015".repeat(2),
		]) {
			expect(
				redactString(
					config({ identitySalt }),
					`salt ${identitySalt} at ${HOME}/x`,
					{},
				),
			).toBe("salt [REDACTED:identity-salt] at ~/x");
		}
	});

	it("still reports the identity salt when scanning text in pseudonymous mode", () => {
		expect(scanForSecrets(config(), `salt ${SALT_A}`, {})).toEqual([
			{ reason: "identity-salt", count: 1 },
		]);
	});

	it("matches the raw-mode redaction for the same literals", () => {
		const raw = redactString(
			{ redactionEnabled: true, redactionAdditionalSecrets: [CONFIGURED] },
			CONFIGURED,
			{},
		);
		expect(redactString(config(), CONFIGURED, {})).toBe(raw);
	});
});

describe("identity raw mode", () => {
	const input = {
		userId: "pseudo-user",
		cwd: `${HOME}/work`,
		metadata: {
			repo_identity: "acme/secret-repo",
			sessionFile: `${HOME}/.pi/agent/sessions/--${ENCODED_HOME}--/a.jsonl`,
			token: "sk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		tags: ["project:secret-checkout"],
	};

	it("produces byte-identical output with and without identity settings", () => {
		const plain: PayloadPolicyConfig = { redactionEnabled: true };
		const configured = [
			{ ...plain, identityMode: "raw" as const },
			{ ...plain, identityMode: "raw" as const, identityKeepRepo: true },
			// Fields that only pseudonymous mode reads are inert in raw mode.
			{
				...plain,
				identityMode: "raw" as const,
				identitySalt: SALT_A,
				identityHome: HOME,
			},
		];
		const expected = serialized([
			sanitizeForTelemetry(plain, input),
			shapeLangfuseTraceBody(plain, { name: "t", ...input }),
			shapeLangfuseObservationBody(plain, "agent.turn", { metadata: input }),
			shapeRawTraceRecord(plain, { type: "prompt_start", ...input }),
			redactString(plain, `open ${HOME}/x`),
		]);
		for (const config of configured) {
			expect(
				serialized([
					sanitizeForTelemetry(config, input),
					shapeLangfuseTraceBody(config, { name: "t", ...input }),
					shapeLangfuseObservationBody(config, "agent.turn", {
						metadata: input,
					}),
					shapeRawTraceRecord(config, { type: "prompt_start", ...input }),
					redactString(config, `open ${HOME}/x`),
				]),
			).toBe(expected);
		}
		expect(expected).toContain(HOME);
		expect(expected).toContain("pseudo-user");
	});

	it("keeps the redaction-disabled fast path returning the same value", () => {
		const config = { redactionEnabled: false, identityMode: "raw" as const };
		expect(sanitizeForTelemetry(config, input)).toBe(input);
		expect(redactString(config, `open ${HOME}/x`)).toBe(`open ${HOME}/x`);
		expect(identityTransformFor(config)).toBeUndefined();
	});
});

describe("identity configuration parsing", () => {
	it("accepts only the documented spellings", () => {
		expect(parseIdentityMode(" Pseudonymous ")).toBe("pseudonymous");
		expect(parseIdentityMode("RAW")).toBe("raw");
		for (const invalid of ["", "anonymous", "pseudonym", true, 1, null]) {
			expect(parseIdentityMode(invalid)).toBeUndefined();
		}
		expect(parseStrictBoolean("Yes")).toBe(true);
		expect(parseStrictBoolean(false)).toBe(false);
		for (const spelling of ["0", "false", " No ", "OFF"]) {
			expect(parseStrictBoolean(spelling)).toBe(false);
		}
		for (const spelling of ["1", "true", "yes", " ON "]) {
			expect(parseStrictBoolean(spelling)).toBe(true);
		}
		for (const invalid of ["", "maybe", "2", 1, null, undefined]) {
			expect(parseStrictBoolean(invalid)).toBeUndefined();
		}
	});
});

describe("identity home directory spellings", () => {
	const WINDOWS_HOME = "C:\\Users\\jdoe";

	it("rewrites the plain, JSON-escaped, and slashed spellings of a Windows home", () => {
		const config = pseudonymous({ identityHome: WINDOWS_HOME });

		expect(
			sanitizeForTelemetry(config, [
				"C:\\Users\\jdoe\\proj",
				"C:\\\\Users\\\\jdoe\\\\proj",
				"C:/Users/jdoe/proj",
			]),
		).toEqual(["~\\proj", "~\\\\proj", "~/proj"]);
	});

	it("rewrites the home inside Pi's encoded session folder name", () => {
		const config = pseudonymous({ identityHome: WINDOWS_HOME });

		expect(redactString(config, "--C--Users-jdoe-proj--")).toBe("--~-proj--");
	});

	it.each(["/", "", "x", "//"])(
		"leaves paths alone when the home %j is too short to name a user, but still hides the salt",
		(home) => {
			const config = pseudonymous({ identityHome: home });

			expect(redactString(config, "open /usr/bin/x and y")).toBe(
				"open /usr/bin/x and y",
			);
			expect(redactString(config, `salt ${SALT_A}`)).toBe(
				"salt [REDACTED:identity-salt]",
			);
		},
	);
});

describe("identity home directory of minimal length", () => {
	it("rewrites a home that is exactly two characters long", () => {
		const config = pseudonymous({ identityHome: "/u" });

		expect(redactString(config, "open /u/proj and /u")).toBe(
			"open ~/proj and ~",
		);
	});
});

describe("identity transform entries", () => {
	const transform = () => {
		const result = identityTransformFor(pseudonymous());
		if (!result) throw new Error("expected a pseudonymous transform");
		return result;
	};

	it("hashes a string or numeric user id and leaves other values alone", () => {
		const entries = transform();
		const asString = entries.entry("user_id", "jdoe");

		expect(asString).toMatch(/^pseudonym-user-[0-9a-f]{24}$/);
		expect(entries.entry("userId", 42)).toMatch(
			/^pseudonym-user-[0-9a-f]{24}$/,
		);
		expect(entries.entry("userId", "jdoe")).toBe(asString);
		const nested = { name: "jdoe" };
		expect(entries.entry("user_id", nested)).toBe(nested);
		expect(entries.entry("user_id", null)).toBeNull();
	});

	it("projects tag lists under a tags key only, and leaves other values there alone", () => {
		const entries = transform();
		const projectTags = ["project:secret-app"];

		const projected = entries.entry("tags", projectTags) as string[];
		expect(projected).toHaveLength(1);
		expect(projected[0]).not.toContain("secret-app");
		expect(entries.entry("labels", projectTags)).toEqual([
			"project:secret-app",
		]);
		expect(entries.entry("tags", "project:secret-app")).toBe(
			"project:secret-app",
		);
	});

	it("rewrites the current user's home when the config names none", () => {
		const config = pseudonymous();
		delete config.identityHome;
		const entries = identityTransformFor(config);

		expect(entries?.string(`${homedir()}/proj`)).toBe("~/proj");
	});
});

describe("identity documentation", () => {
	const read = (path: string) =>
		readFileSync(
			join(fileURLToPath(new URL("..", import.meta.url)), path),
			"utf-8",
		);

	it("describes pseudonymization without claiming anonymity", () => {
		for (const path of ["README.md", "docs/privacy.md"]) {
			const text = read(path);
			expect(text).toMatch(/PI_LANGFUSE_IDENTITY/);
			expect(text).toMatch(/identityKeepRepo/);
			expect(text).toMatch(/not anonymi[sz]ation/i);
			expect(text).not.toMatch(/\b(fully|completely|guarantee[sd]?) anonymi/i);
		}
		const privacy = read("docs/privacy.md");
		expect(privacy).toMatch(/commit/i);
		expect(privacy).toMatch(/service\.name/);
	});
});
