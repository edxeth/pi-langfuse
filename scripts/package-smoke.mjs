import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-langfuse-package-smoke-"));
const packDirectory = join(temporaryRoot, "pack");
const fixtureDirectory = join(temporaryRoot, "fixture");

function runNpm(args, cwd) {
	const npmPath = process.env.npm_execpath;
	const command = npmPath?.endsWith(".js")
		? process.execPath
		: (npmPath ?? "npm");
	const commandArgs = npmPath?.endsWith(".js") ? [npmPath, ...args] : args;
	execFileSync(command, commandArgs, {
		cwd,
		stdio: "inherit",
	});
}

try {
	const packageJson = JSON.parse(
		readFileSync(join(projectRoot, "package.json"), "utf8"),
	);
	if (packageJson.main !== "dist/index.js") {
		throw new Error(
			`package main must remain dist/index.js, got ${packageJson.main}`,
		);
	}

	mkdirSync(packDirectory, { recursive: true });
	mkdirSync(fixtureDirectory, { recursive: true });
	runNpm(["pack", "--pack-destination", packDirectory], projectRoot);

	const tarball = readdirSync(packDirectory).find((name) =>
		name.endsWith(".tgz"),
	);
	if (!tarball) throw new Error("npm pack did not create a tarball");

	writeFileSync(
		join(fixtureDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "pi-langfuse-package-fixture",
				version: "1.0.0",
				private: true,
				type: "module",
				dependencies: {
					"pi-langfuse": `file:${join(packDirectory, tarball)}`,
				},
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(fixtureDirectory, "load-entrypoint.mjs"),
		`import registerExtension from "pi-langfuse";

const commands = [];
const pi = {
	events: {
		on() {},
		emit(name, probe) {
			if (name === "extension:settings:get") probe.values = {};
		},
	},
	on() {},
	registerCommand(name) {
		commands.push(name);
	},
};

if (typeof registerExtension !== "function") {
	throw new Error("compiled package entrypoint did not export a function");
}
await registerExtension(pi);
if (!commands.includes("langfuse-status")) {
	throw new Error("installed package did not register its commands");
}
`,
	);

	runNpm(["install", "--package-lock=false", "--omit=peer"], fixtureDirectory);
	const installedPackageDirectory = join(
		fixtureDirectory,
		"node_modules",
		"pi-langfuse",
	);
	for (const documentationPath of [
		"docs/architecture.md",
		"docs/extension-settings-best-practices.md",
		"docs/migration.md",
		"docs/privacy.md",
		"docs/self-hosting.md",
		"docs/troubleshooting.md",
	]) {
		if (!existsSync(join(installedPackageDirectory, documentationPath))) {
			throw new Error(`installed package is missing ${documentationPath}`);
		}
	}
	const installedManifestEntries = packageJson.pi?.extensions;
	if (
		!Array.isArray(installedManifestEntries) ||
		installedManifestEntries.length === 0
	) {
		throw new Error(
			"published package.json must declare pi.extensions entries",
		);
	}
	for (const entry of installedManifestEntries) {
		if (!existsSync(join(installedPackageDirectory, entry))) {
			throw new Error(
				`installed package is missing its Pi extension entrypoint ${entry}`,
			);
		}
	}
	if (!existsSync(join(installedPackageDirectory, "src", "index.ts"))) {
		throw new Error("installed package is missing src/index.ts");
	}
	execFileSync(
		process.execPath,
		[join(fixtureDirectory, "load-entrypoint.mjs")],
		{
			cwd: fixtureDirectory,
			stdio: "inherit",
		},
	);

	// Pi loads installed packages through the declared pi.extensions manifest,
	// not through main. Load the installed tarball's manifest entrypoint the
	// same way Pi's extension loader (jiti) would, with configuration and
	// credentials isolated so the load cannot touch user settings.
	const loaderPath = join(
		dirname(
			fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
		),
		"core",
		"extensions",
		"loader.js",
	);
	if (!existsSync(loaderPath)) {
		throw new Error(
			`installed Pi does not expose the extension loader at ${loaderPath}`,
		);
	}
	const isolatedAgentDir = join(temporaryRoot, "agent-dir");
	mkdirSync(isolatedAgentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const savedLangfuseEnv = [];
	process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("LANGFUSE_")) {
			savedLangfuseEnv.push([key, process.env[key]]);
			delete process.env[key];
		}
	}
	try {
		const { loadExtensions } = await import(pathToFileURL(loaderPath));
		const { extensions, errors } = await loadExtensions(
			installedManifestEntries.map((entry) =>
				join(installedPackageDirectory, entry),
			),
			fixtureDirectory,
		);
		if (errors.length > 0) {
			throw new Error(
				`Pi extension loader reported errors for the installed manifest entrypoint: ${errors.map((e) => e.error).join("; ")}`,
			);
		}
		if (extensions.length !== installedManifestEntries.length) {
			throw new Error(
				`expected ${installedManifestEntries.length} loaded extension from the manifest, got ${extensions.length}`,
			);
		}
		const loadedCommands = [...extensions[0].commands.keys()];
		for (const expectedCommand of [
			"langfuse-init",
			"langfuse:export",
			"langfuse:toggle",
			"langfuse-status",
			"langfuse-test",
			"langfuse-privacy",
		]) {
			if (!loadedCommands.includes(expectedCommand)) {
				throw new Error(
					`installed manifest entrypoint did not register ${expectedCommand} (registered: ${loadedCommands.join(", ")})`,
				);
			}
		}
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		for (const [key, value] of savedLangfuseEnv) {
			process.env[key] = value;
		}
	}
	console.log(
		"Package smoke passed: installed tarball loaded dist/index.js and its pi.extensions entrypoint through the Pi loader.",
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
