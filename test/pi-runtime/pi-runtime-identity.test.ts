import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	getLastRuntimeError,
	setRuntimeTimeoutsForTest,
} from "../../src/langfuse-client.js";
import { readPackageVersion } from "../../src/package-version.js";
import { drainRawTraceQueue } from "../../src/raw-trace.js";
import {
	captureSessionEvents,
	createRuntimeCase,
	type PiAiModule,
	type RuntimeCase,
	readRawTraceRecords,
} from "./isolated-pi.js";
import {
	type PiMessagesServer,
	startPiMessagesServer,
	textAnswerEvents,
	usageOf,
} from "./provider-server.js";

/**
 * Identity pseudonymization through a genuine Pi SDK session: the real
 * extension, a local scripted provider, and a local Langfuse recorder. All
 * state lives in per-case temp directories with synthetic credentials.
 */

const UNLIMITED_PAYLOAD = {
	"payload-max-string-chars": "unlimited",
	"payload-max-tool-chars": "unlimited",
	"payload-max-depth": "unlimited",
	"payload-max-array-items": "unlimited",
	"payload-max-object-keys": "unlimited",
	"payload-max-nodes": "unlimited",
} as const;

let activeCase: RuntimeCase | undefined;
let restoreTimeouts: (() => void) | undefined;
const activeProviderServers: PiMessagesServer[] = [];

afterEach(async () => {
	restoreTimeouts?.();
	restoreTimeouts = undefined;
	const current = activeCase;
	activeCase = undefined;
	if (current) await current.teardown();
	for (const server of activeProviderServers.splice(0)) {
		await server.close();
	}
});

function acceptedBodies(recorder: RuntimeCase["recorder"]) {
	return recorder.acceptedPosts().map((record) => record.body);
}

async function waitForCondition(
	what: string,
	condition: () => boolean,
	deadlineMs = 10_000,
) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("identity pseudonymization in a real Pi runtime", () => {
	it("keeps home paths, user id, repository identity, and the salt out of every telemetry output while the provider payload stays untouched", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 1_000 });
		let home = "";
		const toolOutput = () => `listed ${home}/notes/todo.md successfully`;
		const provider = await startPiMessagesServer((call) => {
			if (call === 1) {
				return {
					events: [
						{
							type: "toolcall_start",
							contentIndex: 0,
							id: "call-identity-1",
							toolName: "probe_lookup",
						},
						{
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: {
								type: "toolCall",
								id: "call-identity-1",
								name: "probe_lookup",
								arguments: { path: `${home}/notes/todo.md` },
							},
						},
						{ type: "done", reason: "toolCall", usage: usageOf(5, 2, 0) },
					],
				};
			}
			return {
				events: textAnswerEvents(`done with ${home}/notes`, usageOf(11, 5, 0)),
			};
		});
		activeProviderServers.push(provider);

		const runtimeCase = await createRuntimeCase({
			name: "identity-pseudonymous",
			provider: { kind: "pi-messages", baseUrl: provider.url },
			settings: {
				"capture-policy": "full-debug",
				// Identity protection must not depend on secret redaction.
				"redaction-enabled": false,
				"user-id": "identity-runtime-user",
				...UNLIMITED_PAYLOAD,
			},
			env: {
				PI_LANGFUSE_IDENTITY: "pseudonymous",
				PI_LANGFUSE_RAW_PROVIDER_REQUEST: "full",
			},
			customToolsFactory: (piAi: PiAiModule) => [
				{
					name: "probe_lookup",
					label: "Probe Lookup",
					description: "Returns fixed synthetic content.",
					parameters: piAi.Type.Object({ path: piAi.Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: toolOutput() }],
						details: { kind: "synthetic" },
					}),
				},
			],
		});
		activeCase = runtimeCase;
		home = join(runtimeCase.caseDir, "home");
		const workspace = join(runtimeCase.caseDir, "project", "team", "workspace");
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
		git("init", "-q");
		git(
			"remote",
			"add",
			"origin",
			"https://github.com/acme-secret/private-repo.git",
		);
		writeFileSync(
			join(workspace, ".pi-langfuse.metadata.json"),
			JSON.stringify({
				repo_name: "override-name",
				project_slug: "visible-slug",
			}),
		);

		await runtimeCase.session.prompt("list my notes");
		await runtimeCase.session.waitForIdle();
		runtimeCase.session.dispose();
		drainRawTraceQueue();

		// The provider still receives the real path: only telemetry is rewritten.
		expect(provider.requests).toHaveLength(2);
		expect(JSON.stringify(provider.requests.map((r) => r.body))).toContain(
			`${home}/notes/todo.md`,
		);

		const configPath = join(
			runtimeCase.caseDir,
			"agent",
			"langfuse",
			"pi-langfuse.json",
		);
		const stored = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
			string,
			string
		>;
		expect(Object.keys(stored)).toEqual(["identitySalt"]);
		expect(stored.identitySalt).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(configPath).mode & 0o777).toBe(0o600);

		const otlp = acceptedBodies(runtimeCase.recorder);
		const raw = readRawTraceRecords(runtimeCase.rawTraceDir);
		expect(otlp.length).toBeGreaterThan(0);
		expect(raw.length).toBeGreaterThan(0);
		// Redaction really was off, so identity protection acted alone.
		expect(
			raw.every(
				(record) => JSON.stringify(record.redaction) === '{"applied":false}',
			),
		).toBe(true);
		expect(runtimeCase.recorder.scores.length).toBeGreaterThan(0);

		const surfaces = {
			otlp: JSON.stringify(otlp),
			raw: JSON.stringify(raw),
			scores: JSON.stringify(runtimeCase.recorder.scores.map((s) => s.body)),
		};
		for (const [surface, text] of Object.entries(surfaces)) {
			for (const leaked of [
				home,
				"identity-runtime-user",
				"acme-secret",
				"private-repo",
				"override-name",
				stored.identitySalt,
			]) {
				expect(text, `${surface} leaked ${leaked}`).not.toContain(leaked);
			}
		}
		expect(surfaces.otlp).toContain("~/notes/todo.md");
		expect(surfaces.raw).toContain("~/notes/todo.md");
		expect(surfaces.otlp).toMatch(/pseudonym-user-[0-9a-f]{24}/);
		expect(surfaces.otlp).toMatch(/pseudonym-repo-identity-[0-9a-f]{24}/);
		expect(surfaces.otlp).toMatch(/project:pseudonym-project-[0-9a-f]{24}/);
		// A non-identity override label stays as written.
		expect(surfaces.otlp).toContain("visible-slug");

		for (const body of otlp) {
			const resources = (
				body as {
					resourceSpans: Array<{
						resource: {
							attributes: Array<{
								key: string;
								value: { stringValue: string };
							}>;
						};
					}>;
				}
			).resourceSpans;
			for (const resource of resources) {
				const attributes = Object.fromEntries(
					resource.resource.attributes.map((a) => [a.key, a.value.stringValue]),
				);
				expect(attributes["service.name"]).toBe("pi-langfuse");
				expect(attributes["service.version"]).toBe(readPackageVersion());
			}
		}
		// Real Pi runtime cases use the suite's 30 s budget, like the other
		// pi-runtime files; the 5 s default fails on a loaded host.
	}, 30_000);

	it("stops new telemetry and raw traces after a settings reload turns the identity policy invalid", async () => {
		restoreTimeouts = setRuntimeTimeoutsForTest({ exportMs: 1_000 });
		const provider = await startPiMessagesServer((call) => ({
			events: textAnswerEvents(`answer ${call}`, usageOf(3, 1, 0)),
		}));
		activeProviderServers.push(provider);
		let piApi: ExtensionAPI | undefined;
		const capturePi: InlineExtension = (pi: ExtensionAPI) => {
			piApi = pi;
		};
		const runtimeCase = await createRuntimeCase({
			name: "identity-reload",
			provider: { kind: "pi-messages", baseUrl: provider.url },
			extensionFactories: [capturePi],
			settings: { "capture-policy": "full-debug", ...UNLIMITED_PAYLOAD },
		});
		activeCase = runtimeCase;
		const events = captureSessionEvents(runtimeCase.session);

		await runtimeCase.session.prompt("first prompt, raw identity");
		await runtimeCase.session.waitForIdle();
		await waitForCondition("first prompt export", () =>
			events.some((event) => event.type === "agent_settled"),
		);
		drainRawTraceQueue();
		const rawBefore = readRawTraceRecords(runtimeCase.rawTraceDir).length;
		expect(rawBefore).toBeGreaterThan(0);
		expect(runtimeCase.recorder.acceptedPosts().length).toBeGreaterThan(0);
		const postsBefore = runtimeCase.recorder.acceptedPosts().length;

		// The user edits settings to an invalid identity mode and Pi reloads.
		const settingsPath = join(runtimeCase.caseDir, "agent", "settings.json");
		const document = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			"extensions:settings": { "pi-langfuse": Record<string, unknown> };
		};
		document["extensions:settings"]["pi-langfuse"]["identity-mode"] =
			"anonymous";
		writeFileSync(settingsPath, JSON.stringify(document));
		piApi?.events.emit("extension:settings:changed:pi-langfuse", {});
		await waitForCondition(
			"the identity failure diagnostic",
			() =>
				getLastRuntimeError()?.message.includes(
					"Identity configuration blocks telemetry and raw traces",
				) ?? false,
		);

		await runtimeCase.session.prompt("second prompt after the failed reload");
		await runtimeCase.session.waitForIdle();
		runtimeCase.session.dispose();
		drainRawTraceQueue();

		// The provider still answered; no new trace, span, score, or raw record.
		expect(provider.requests).toHaveLength(2);
		expect(runtimeCase.recorder.acceptedPosts().length).toBe(postsBefore);
		expect(readRawTraceRecords(runtimeCase.rawTraceDir)).toHaveLength(
			rawBefore,
		);
		expect(
			JSON.stringify(readRawTraceRecords(runtimeCase.rawTraceDir)),
		).not.toContain("second prompt after the failed reload");
	}, 30_000);
});
