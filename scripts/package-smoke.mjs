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

// Runtime isolation: the packaged code must never see user config or
// credentials. Package acquisition (npm) keeps the ambient environment; every
// load of the installed code uses this owned, synthetic one.
const isolationRoot = join(temporaryRoot, "runtime");
const isolatedHome = join(isolationRoot, "home");
const isolatedAgentDir = join(isolationRoot, "agent");
const isolatedSessionDir = join(isolationRoot, "sessions");
const isolatedRawTraceDir = join(isolationRoot, "raw-traces");
const syntheticLoopbackHost = "http://127.0.0.1:9";
const isolatedOverrides = {
	HOME: isolatedHome,
	USERPROFILE: isolatedHome,
	PI_CODING_AGENT_DIR: isolatedAgentDir,
	PI_CODING_AGENT_SESSION_DIR: isolatedSessionDir,
	PI_LANGFUSE_CONFIG: join(isolationRoot, "pi-langfuse.json"),
	PI_LANGFUSE_RAW_TRACE_DIR: isolatedRawTraceDir,
	PI_LANGFUSE_RAW_TRACE: "0",
	PI_LANGFUSE_AUTOSTART: "0",
	PI_LANGFUSE_IDENTITY: "raw",
	LANGFUSE_PUBLIC_KEY: "pk-lf-smoke-isolation",
	LANGFUSE_SECRET_KEY: "sk-lf-smoke-isolation",
	LANGFUSE_BASE_URL: syntheticLoopbackHost,
};

function isScrubbedKey(key) {
	return (
		key.startsWith("LANGFUSE_") ||
		key.startsWith("PI_LANGFUSE_") ||
		key === "PI_CODING_AGENT_DIR" ||
		key === "PI_CODING_AGENT_SESSION_DIR" ||
		key === "PI_PACKAGE_DIR"
	);
}

/** Ambient environment minus every Langfuse/Pi path key, plus the pins. */
function isolatedRuntimeEnvironment() {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !isScrubbedKey(key)),
		),
		...isolatedOverrides,
	};
}

function assertIsolated(environment, label) {
	for (const [key, expected] of Object.entries(isolatedOverrides)) {
		if (environment[key] !== expected) {
			throw new Error(`${label}: runtime isolation did not pin ${key}`);
		}
	}
	for (const key of Object.keys(environment)) {
		if (isScrubbedKey(key) && !(key in isolatedOverrides)) {
			throw new Error(`${label}: unexpected ${key} in the isolated runtime`);
		}
	}
}

try {
	for (const directory of [
		isolatedHome,
		isolatedAgentDir,
		isolatedSessionDir,
		isolatedRawTraceDir,
	]) {
		mkdirSync(directory, { recursive: true });
	}
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
		`import { readFileSync } from "node:fs";
import registerExtension from "pi-langfuse";
import { readPackageVersion } from "pi-langfuse/dist/package-version.js";

// The OpenTelemetry resource reports this version, so the compiled layout
// must resolve the installed package's own manifest.
const installedManifest = JSON.parse(
	readFileSync(new URL("./node_modules/pi-langfuse/package.json", import.meta.url), "utf8"),
);
if (readPackageVersion() !== installedManifest.version) {
	throw new Error("compiled package did not resolve its own version");
}

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
	if (existsSync(join(installedPackageDirectory, "docs", "plans"))) {
		throw new Error("installed package must not contain local working plans");
	}
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
	const compiledLoadEnvironment = isolatedRuntimeEnvironment();
	assertIsolated(compiledLoadEnvironment, "compiled entrypoint load");
	execFileSync(
		process.execPath,
		[join(fixtureDirectory, "load-entrypoint.mjs")],
		{
			cwd: fixtureDirectory,
			env: compiledLoadEnvironment,
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
	// Pin the in-process environment too, and restore every touched key.
	const savedEnvironment = new Map();
	for (const key of Object.keys(process.env)) {
		if (isScrubbedKey(key) || key in isolatedOverrides) {
			savedEnvironment.set(key, process.env[key]);
			delete process.env[key];
		}
	}
	for (const key of Object.keys(isolatedOverrides)) {
		if (!savedEnvironment.has(key)) savedEnvironment.set(key, undefined);
	}
	Object.assign(process.env, isolatedOverrides);
	try {
		assertIsolated(process.env, "Pi loader");
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
			"langfuse-score",
			"langfuse-privacy",
		]) {
			if (!loadedCommands.includes(expectedCommand)) {
				throw new Error(
					`installed manifest entrypoint did not register ${expectedCommand} (registered: ${loadedCommands.join(", ")})`,
				);
			}
		}
	} finally {
		for (const key of Object.keys(isolatedOverrides)) delete process.env[key];
		for (const [key, value] of savedEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	console.log(
		"Package smoke passed: installed tarball loaded dist/index.js and its pi.extensions entrypoint through the Pi loader.",
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
