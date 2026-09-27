import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLangfuseInit } from "./local-init.js";

type Notification = { message: string; type?: string };

function createContext(
	notifications: Notification[] = [],
	overrides: Record<string, unknown> = {},
) {
	return {
		hasUI: false,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			input: async () => undefined,
			confirm: async () => false,
			select: async () => undefined,
		},
		...overrides,
	} as never;
}

describe("/langfuse-init", () => {
	let agentDir: string;
	let oldAgentDir: string | undefined;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-langfuse-init-test-"));
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	it("creates a local Docker stack config by default", async () => {
		const notifications: Notification[] = [];

		await runLangfuseInit("--yes --no-start", createContext(notifications));

		const config = JSON.parse(
			await readFile(join(agentDir, "langfuse", "pi-langfuse.json"), "utf-8"),
		);
		expect(config).toMatchObject({
			enabled: true,
			host: "http://localhost:3100",
			localAutostart: true,
		});
		expect(config.publicKey).toMatch(/^pk-lf-local-/);
		expect(config.secretKey).toMatch(/^sk-lf-local-/);
		await expect(
			readFile(join(agentDir, "langfuse", "docker-compose.yml"), "utf-8"),
		).resolves.toContain("langfuse-web");
		expect(notifications.map((n) => n.message).join("\n")).toContain(
			"Local Langfuse initialized",
		);
	});

	it("writes secret-bearing files with owner-only permissions", async () => {
		await runLangfuseInit("--yes --no-start", createContext([]));

		const dir = join(agentDir, "langfuse");
		const configMode = (await stat(join(dir, "pi-langfuse.json"))).mode & 0o777;
		const envMode = (await stat(join(dir, ".env"))).mode & 0o777;
		const composeMode =
			(await stat(join(dir, "docker-compose.yml"))).mode & 0o777;
		const dirMode = (await stat(dir)).mode & 0o777;

		// umask-independent: no access for group or other on secrets or the container dir
		expect(configMode & 0o077).toBe(0);
		expect(envMode & 0o077).toBe(0);
		expect(dirMode & 0o077).toBe(0);
		expect(composeMode & 0o022).toBe(0);
	});

	it("writes remote pi-langfuse.json with owner-only permissions", async () => {
		await runLangfuseInit(
			"--yes --remote --public-key pk-test --secret-key sk-test",
			createContext([]),
		);

		const configMode =
			(await stat(join(agentDir, "langfuse", "pi-langfuse.json"))).mode & 0o777;
		expect(configMode & 0o077).toBe(0);
	});

	function envPassword(dir: string) {
		return readFile(join(dir, ".env"), "utf-8").then((content) =>
			content
				.split("\n")
				.find((line) => line.startsWith("LANGFUSE_INIT_USER_PASSWORD="))
				?.slice("LANGFUSE_INIT_USER_PASSWORD=".length),
		);
	}

	it("generates a unique login password when none is provided", async () => {
		const notifications: Notification[] = [];

		await runLangfuseInit("--yes --no-start", createContext(notifications));
		const first = await envPassword(join(agentDir, "langfuse"));

		expect(first).toBeTruthy();
		expect(first).not.toBe("local-langfuse");
		expect(first?.length).toBeGreaterThanOrEqual(12);
		expect(notifications.map((n) => n.message).join("\n")).toContain(first);

		const secondAgentDir = `${agentDir}-second`;
		process.env.PI_CODING_AGENT_DIR = secondAgentDir;
		try {
			await runLangfuseInit("--yes --no-start", createContext([]));
		} finally {
			process.env.PI_CODING_AGENT_DIR = agentDir;
		}
		const second = await envPassword(join(secondAgentDir, "langfuse"));
		await rm(secondAgentDir, { recursive: true, force: true });
		expect(second).toBeTruthy();
		expect(second).not.toBe(first);
	});

	it("keeps an explicitly provided login password", async () => {
		const notifications: Notification[] = [];

		await runLangfuseInit(
			"--yes --no-start --password correct-horse-battery",
			createContext(notifications),
		);

		await expect(envPassword(join(agentDir, "langfuse"))).resolves.toBe(
			"correct-horse-battery",
		);
		expect(notifications.at(-1)?.message).toContain("correct-horse-battery");
	});

	it("tells the user how to recover the generated password when Compose start fails", async () => {
		const notifications: Notification[] = [];
		const realPath = process.env.PATH;
		// Hidden PATH makes execFile("docker") fail with ENOENT; no real Docker runs.
		process.env.PATH = "";
		try {
			await runLangfuseInit("--yes", createContext(notifications));
		} finally {
			process.env.PATH = realPath;
		}

		const messages = notifications.map((n) => n.message).join("\n");
		expect(notifications.some((n) => n.type === "error")).toBe(true);
		expect(messages).toContain("docker compose up -d");
		expect(messages).toContain("LANGFUSE_INIT_USER_PASSWORD");
		expect(messages).toContain(join(agentDir, "langfuse", ".env"));
		// The generated credentials were still written for later recovery.
		const env = await readFile(join(agentDir, "langfuse", ".env"), "utf-8");
		expect(env).toMatch(/LANGFUSE_INIT_USER_PASSWORD=.+/);
	}, 15000);

	it("lets the interactive wizard choose remote setup", async () => {
		const notifications: Notification[] = [];
		const inputs = ["https://cloud.langfuse.com", "pk-wizard", "sk-wizard"];

		await runLangfuseInit(
			"",
			createContext(notifications, {
				hasUI: true,
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
					select: async () => "Remote / Langfuse Cloud",
					input: async () => inputs.shift(),
					confirm: async () => true,
				},
			}),
		);

		const config = JSON.parse(
			await readFile(join(agentDir, "langfuse", "pi-langfuse.json"), "utf-8"),
		);
		expect(config).toMatchObject({
			publicKey: "pk-wizard",
			secretKey: "sk-wizard",
			host: "https://cloud.langfuse.com",
			localAutostart: false,
		});
		expect(notifications.at(-1)?.message).toContain(
			"Remote Langfuse configured",
		);
	});

	it("configures a remote Langfuse endpoint without creating a local Docker stack", async () => {
		const notifications: Notification[] = [];

		await runLangfuseInit(
			"--yes --remote --host https://cloud.langfuse.com --public-key pk-test --secret-key sk-test",
			createContext(notifications),
		);

		const config = JSON.parse(
			await readFile(join(agentDir, "langfuse", "pi-langfuse.json"), "utf-8"),
		);
		expect(config).toMatchObject({
			enabled: true,
			publicKey: "pk-test",
			secretKey: "sk-test",
			host: "https://cloud.langfuse.com",
			localAutostart: false,
		});
		await expect(
			readFile(join(agentDir, "langfuse", "docker-compose.yml"), "utf-8"),
		).rejects.toThrow();
		expect(notifications.at(-1)?.message).toContain(
			"Remote Langfuse configured",
		);
	});
});
