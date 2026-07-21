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
import { fileURLToPath } from "node:url";

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
	execFileSync(
		process.execPath,
		[join(fixtureDirectory, "load-entrypoint.mjs")],
		{
			cwd: fixtureDirectory,
			stdio: "inherit",
		},
	);
	console.log("Package smoke passed: installed tarball loaded dist/index.js.");
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
