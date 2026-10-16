import { afterEach, describe, expect, it } from "vitest";
import { startLangfuseRecorder } from "../test/pi-runtime/recorder.js";
import type { Config } from "./config.js";
import {
	flushClient,
	getRuntime,
	setRuntimeTimeoutsForTest,
	shutdownClient,
} from "./langfuse-client.js";
import { readPackageVersion } from "./package-version.js";

const HOME = "/home/pseudo-user";
const SALT = "c".repeat(64);
const ENCODED_HOME = "home-pseudo-user";

const baseConfig: Omit<Config, "host"> = {
	enabled: true,
	publicKey: "pk-local-identity",
	secretKey: "sk-local-identity",
	userId: "pseudo-user",
	defaultTags: [],
	release: `${HOME}/release-1`,
	environment: `env-${HOME}`,
	traceInputMaxChars: 2000,
	traceOutputMaxChars: 2000,
	toolArgsMaxChars: 500,
	toolOutputMaxChars: 2000,
	captureToolProgress: true,
	captureMessageUpdates: false,
	skipUnpersistedSessions: false,
	captureProviderPayload: false,
	providerPayloadMaxChars: 50_000,
	redactionEnabled: true,
	redactionAdditionalSecrets: [],
	rawTraceEnabled: false,
	rawTraceDir: "/tmp/raw",
	rawTraceProviderRequestMode: "summary",
	localAutostart: false,
	localAutostartDir: "/tmp/langfuse",
	localAutostartHealthUrl: "http://127.0.0.1/api/public/health",
	localAutostartTimeoutMs: 200,
};

const pseudonymousIdentity = {
	identityMode: "pseudonymous" as const,
	identitySalt: SALT,
	identityHome: HOME,
};

type OtlpBody = {
	resourceSpans?: Array<{
		resource?: { attributes?: Array<{ key: string; value?: unknown }> };
		scopeSpans?: Array<{
			spans?: Array<{
				name: string;
				attributes?: Array<{ key: string; value?: { stringValue?: string } }>;
			}>;
		}>;
	}>;
};

/** Send one representative prompt through the real runtime and recorder. */
async function exportRepresentativeTrace(
	overrides: Partial<Config>,
): Promise<{ bodies: OtlpBody[]; text: string }> {
	const restore = setRuntimeTimeoutsForTest({
		exportMs: 2_000,
		scoreMs: 2_000,
	});
	const recorder = await startLangfuseRecorder("identity-runtime");
	try {
		const runtime = await getRuntime({
			...baseConfig,
			...overrides,
			host: recorder.url,
		});
		const sessionFile = `${HOME}/.pi/agent/sessions/--${ENCODED_HOME}-projects-app--/s.jsonl`;
		const trace = runtime.trace({
			name: "agent.prompt",
			userId: "pseudo-user",
			sessionId: "session-1",
			tags: ["pi", "project:secret-checkout"],
			input: `read ${HOME}/notes.md`,
			metadata: {
				cwd: `${HOME}/projects/app`,
				sessionFile,
				sessionRoot: `${HOME}/.pi/agent/sessions`,
				previousSessionFile: sessionFile,
				repo_identity: "acme/secret-repo",
				repo_owner: "acme",
				repo_name: "secret-repo",
				git_remote_path: "acme/secret-repo",
				repo_root_name: "secret-checkout",
			},
		});
		const turn = runtime.span({
			name: "agent.turn",
			traceId: trace.id,
			metadata: { turnIndex: 0, note: `turn in ${HOME}/projects/app` },
		});
		const generation = runtime.generation({
			name: "llm-response",
			traceId: trace.id,
			parentObservationId: turn.id,
			input: [{ role: "user", content: `open ${HOME}/a.txt` }],
		});
		generation.end({ output: { text: `wrote ${HOME}/a.txt`, tool_calls: [] } });
		turn.end({ output: { text: "done" } });
		runtime.score({
			name: "tool_call_count",
			value: 1,
			traceId: trace.id,
			comment: `scored under ${HOME}/projects/app`,
		});
		trace.update({
			output: `finished in ${HOME}/projects/app`,
			metadata: { errorMessage: `ENOENT ${HOME}/missing` },
		});
		runtime.span({ name: "agent.prompt", traceId: trace.id }).end();
		await flushClient();
		await shutdownClient();

		const bodies = recorder
			.acceptedPosts()
			.map((record) => record.body as OtlpBody);
		const text = JSON.stringify({
			posts: bodies,
			scores: recorder.scores.map((score) => score.body),
		});
		return { bodies, text };
	} finally {
		await shutdownClient();
		restore();
		await recorder.close();
	}
}

function resourceAttributes(bodies: OtlpBody[]) {
	return bodies.flatMap((body) =>
		(body.resourceSpans ?? []).map((resource) =>
			Object.fromEntries(
				(resource.resource?.attributes ?? []).map((attribute) => [
					attribute.key,
					(attribute.value as { stringValue?: string } | undefined)
						?.stringValue,
				]),
			),
		),
	);
}

function spanAttributeValues(bodies: OtlpBody[], key: string) {
	return bodies.flatMap((body) =>
		(body.resourceSpans ?? []).flatMap((resource) =>
			(resource.scopeSpans ?? []).flatMap((scope) =>
				(scope.spans ?? []).flatMap((span) =>
					(span.attributes ?? [])
						.filter((attribute) => attribute.key === key)
						.map((attribute) => attribute.value?.stringValue),
				),
			),
		),
	);
}

afterEach(async () => {
	await shutdownClient();
});

describe("identity pseudonymization on the real export path", () => {
	it("keeps home paths, user, repository, and tags out of OTLP spans, resources, and scores", async () => {
		const { bodies, text } = await exportRepresentativeTrace({
			...pseudonymousIdentity,
		});

		expect(bodies.length).toBeGreaterThan(0);
		for (const leaked of [
			HOME,
			ENCODED_HOME,
			"pseudo-user",
			"acme",
			"secret-repo",
			"secret-checkout",
			SALT,
		]) {
			expect(text, `leaked ${leaked}`).not.toContain(leaked);
		}
		// Processor-stamped release and environment bypass body shaping.
		expect(new Set(spanAttributeValues(bodies, "langfuse.release"))).toEqual(
			new Set(["~/release-1"]),
		);
		expect(
			new Set(spanAttributeValues(bodies, "langfuse.environment")),
		).toEqual(new Set(["env-~"]));
		const userIds = new Set(spanAttributeValues(bodies, "user.id"));
		expect([...userIds]).toHaveLength(1);
		expect([...userIds][0]).toMatch(/^pseudonym-user-[0-9a-f]{24}$/);
		expect(text).toContain("~/projects/app");
		expect(text).toContain("--~-projects-app--");
		expect(text).toMatch(/project:pseudonym-project-[0-9a-f]{24}/);
		expect(text).toContain("scored under ~/projects/app");
	});

	it("still protects identity when secret redaction is disabled", async () => {
		const { text } = await exportRepresentativeTrace({
			...pseudonymousIdentity,
			redactionEnabled: false,
		});

		for (const leaked of [
			HOME,
			"pseudo-user",
			"acme",
			"secret-checkout",
			SALT,
		]) {
			expect(text, `leaked ${leaked}`).not.toContain(leaked);
		}
		expect(text).toContain("~/projects/app");
	});

	it("keeps repository identity readable only with identityKeepRepo", async () => {
		const { text } = await exportRepresentativeTrace({
			...pseudonymousIdentity,
			identityKeepRepo: true,
		});

		expect(text).toContain("acme/secret-repo");
		expect(text).toContain("project:secret-checkout");
		expect(text).not.toContain(HOME);
		expect(text).not.toContain("pseudo-user");
	});

	it("normalizes ambient release and environment variables when none is configured", async () => {
		const ambient = {
			LANGFUSE_RELEASE: `${HOME}/release-env`,
			LANGFUSE_TRACING_ENVIRONMENT: `env-${HOME}`,
		};
		Object.assign(process.env, ambient);
		try {
			const withAmbient = await exportRepresentativeTrace({
				...pseudonymousIdentity,
				release: "",
				environment: "",
			});
			for (const key of Object.keys(ambient)) delete process.env[key];
			const withoutAmbient = await exportRepresentativeTrace({
				...pseudonymousIdentity,
				release: "",
				environment: "",
			});

			expect(withAmbient.text).not.toContain(HOME);
			expect(
				new Set(spanAttributeValues(withAmbient.bodies, "langfuse.release")),
			).toEqual(new Set(["~/release-env"]));
			expect(
				new Set(
					spanAttributeValues(withAmbient.bodies, "langfuse.environment"),
				),
			).toEqual(new Set(["env-~"]));
			expect(
				spanAttributeValues(withoutAmbient.bodies, "langfuse.release"),
			).toEqual([]);
		} finally {
			for (const key of Object.keys(ambient)) delete process.env[key];
		}
	});

	it("leaves raw mode output unchanged while naming the service", async () => {
		const { bodies, text } = await exportRepresentativeTrace({
			identityMode: "raw",
		});

		expect(text).toContain(`${HOME}/projects/app`);
		expect(text).toContain("acme/secret-repo");
		expect(text).toContain("project:secret-checkout");
		expect(text).toContain("pseudo-user");
		expect(new Set(spanAttributeValues(bodies, "langfuse.release"))).toEqual(
			new Set([`${HOME}/release-1`]),
		);
		expect(
			new Set(spanAttributeValues(bodies, "langfuse.environment")),
		).toEqual(new Set([`env-${HOME}`]));
	});

	it.each([
		["raw", {}],
		["pseudonymous", pseudonymousIdentity],
	])(
		"always reports the package service resource in %s mode",
		async (_mode, identity) => {
			const { bodies } = await exportRepresentativeTrace(identity);

			const resources = resourceAttributes(bodies);
			expect(resources.length).toBeGreaterThan(0);
			for (const attributes of resources) {
				expect(attributes["service.name"]).toBe("pi-langfuse");
				expect(attributes["service.version"]).toBe(readPackageVersion());
				// The SDK default embeds the Node binary path.
				expect(JSON.stringify(attributes)).not.toContain("unknown_service");
				expect(JSON.stringify(attributes)).not.toContain(process.argv0);
				expect(JSON.stringify(attributes)).not.toContain(process.execPath);
				// The SDK's own resource attributes are kept.
				expect(attributes["telemetry.sdk.language"]).toBe("nodejs");
			}
		},
	);
});
