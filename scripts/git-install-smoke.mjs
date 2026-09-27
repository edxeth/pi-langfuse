// Smoke test for the Pi Git install contract (audit pi-langfuse-0361039,
// finding 17).
//
// Pi installs Git packages by cloning the repository and running
// `npm install --omit=dev` inside the clone. This script proves that a clean
// checkout:
//   1. installs successfully with lifecycle scripts enabled and no dev
//      dependencies (the `prepare` script must tolerate the missing husky
//      binary used only in development checkouts, but must propagate real
//      husky failures),
//   2. exposes a loadable Pi extension entrypoint (`pi.extensions` entries
//      must exist in the checkout; compiled `dist/` is Git-ignored),
//   3. loads `src/index.ts` through the installed Pi extension loader (jiti)
//      and registers the documented commands,
//   4. keeps the development hook setup intact when husky is available.
//
// With registry access, stage 1 performs the real install in the clone. On
// hosts without network or cache coverage it falls back to the offline
// contract fixture (dependency ranges stripped) and links the installed
// runtime dependencies into the checkout for the load. Both modes run fully
// offline-safe: the load never touches user settings or credentials.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_COMMANDS = [
	"langfuse-init",
	"langfuse:export",
	"langfuse:toggle",
	"langfuse-status",
	"langfuse-test",
	"langfuse-privacy",
];
const NETWORK_FAILURE_PATTERN =
	/(ENOTCACHED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPROTO|network request failed|getaddrinfo)/i;
const NPM = process.env.npm_execpath?.endsWith(".js")
	? process.execPath
	: "npm";
const NPM_PREFIX_ARGS = process.env.npm_execpath?.endsWith(".js")
	? [process.env.npm_execpath]
	: [];

function fail(message) {
	throw new Error(`Git install smoke failed: ${message}`);
}

// npm run/exec inject ancestor node_modules/.bin directories into PATH; strip
// them so fixtures see a production-like environment where the dev-only
// husky binary cannot resolve. GIT_DIR/GIT_WORK_TREE are stripped because a
// hook can inherit them from a linked-worktree commit, which would redirect
// the clone and any child git call into this repository.
function sanitizedEnvironment() {
	const sanitizedPath = (process.env.PATH ?? "")
		.split(":")
		.filter((segment) => !segment.includes("node_modules"))
		.join(":");
	const environment = { ...process.env, PATH: sanitizedPath };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
		delete environment[key];
	}
	return environment;
}

function runNpm(args, cwd) {
	return spawnSync(NPM, [...NPM_PREFIX_ARGS, ...args], {
		cwd,
		encoding: "utf8",
		env: sanitizedEnvironment(),
	});
}

function runGit(args, cwd) {
	return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function assertProductionInstallResult(
	installResult,
	installOutput,
	nodeModules,
) {
	if (installResult.status !== 0) {
		fail(
			`npm install --omit=dev failed in a clean checkout (exit ${installResult.status}):\n${installResult.stderr}`,
		);
	}
	if (!installOutput.includes("prepare")) {
		fail(
			"npm install output does not show the prepare script running; the production install contract was not exercised",
		);
	}
	if (existsSync(join(nodeModules, "husky"))) {
		fail("production install unexpectedly contains the dev-only husky package");
	}
	if (existsSync(join(nodeModules, ".bin", "husky"))) {
		fail("production install unexpectedly contains the husky binary");
	}
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-langfuse-git-smoke-"));
const cloneDirectory = join(temporaryRoot, "checkout");
const installFixtureDirectory = join(temporaryRoot, "install-contract");
const isolatedAgentDir = join(temporaryRoot, "agent-dir");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedLangfuseEnv = [];
let installMode;

try {
	const cloneResult = runGit(
		["clone", "--no-hardlinks", "--quiet", projectRoot, cloneDirectory],
		temporaryRoot,
	);
	if (cloneResult.status !== 0) {
		fail(`git clone failed: ${cloneResult.stderr}`);
	}
	if (existsSync(join(cloneDirectory, "dist"))) {
		fail("clean checkout contains a compiled dist/ directory");
	}

	const packageJson = JSON.parse(
		readFileSync(join(cloneDirectory, "package.json"), "utf8"),
	);

	const manifestEntries = packageJson.pi?.extensions;
	if (!Array.isArray(manifestEntries) || manifestEntries.length === 0) {
		fail("package.json does not declare any pi.extensions entries");
	}
	const missingEntries = manifestEntries.filter(
		(entry) => !existsSync(join(cloneDirectory, entry)),
	);
	if (missingEntries.length > 0) {
		fail(
			`pi.extensions entries missing from a clean checkout: ${missingEntries.join(", ")}`,
		);
	}
	const nonModuleEntries = manifestEntries.filter(
		(entry) => !entry.endsWith(".ts") && !entry.endsWith(".js"),
	);
	if (nonModuleEntries.length > 0) {
		fail(
			`pi.extensions entries must be .ts or .js files: ${nonModuleEntries.join(", ")}`,
		);
	}

	const piPackageEntry = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	const loaderPath = join(
		dirname(piPackageEntry),
		"core",
		"extensions",
		"loader.js",
	);
	if (!existsSync(loaderPath)) {
		fail(`installed Pi does not expose the extension loader at ${loaderPath}`);
	}

	// Stage 1: the real production install in the clone when the registry (or
	// cache) can resolve the dependency tree.
	const cloneNodeModules = join(cloneDirectory, "node_modules");
	const registryInstall = runNpm(
		["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
		cloneDirectory,
	);
	const registryOutput = `${registryInstall.stdout}\n${registryInstall.stderr}`;
	if (registryInstall.status === 0) {
		installMode = "registry";
		assertProductionInstallResult(
			registryInstall,
			registryOutput,
			cloneNodeModules,
		);
	} else if (NETWORK_FAILURE_PATTERN.test(registryOutput)) {
		// Stage 1 fallback: offline contract fixture. The manifest under test
		// keeps the committed scripts (including `prepare`) verbatim; only
		// dependency ranges are stripped because offline hosts cannot resolve
		// them.
		installMode = "offline-contract";
		const installManifest = { ...packageJson };
		for (const field of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"peerDependenciesMeta",
		]) {
			delete installManifest[field];
		}
		mkdirSync(installFixtureDirectory, { recursive: true });
		writeFileSync(
			join(installFixtureDirectory, "package.json"),
			`${JSON.stringify(installManifest, null, "\t")}\n`,
		);
		const offlineInstall = runNpm(
			[
				"install",
				"--omit=dev",
				"--offline",
				"--no-audit",
				"--no-fund",
				"--loglevel=error",
			],
			installFixtureDirectory,
		);
		assertProductionInstallResult(
			offlineInstall,
			`${offlineInstall.stdout}\n${offlineInstall.stderr}`,
			join(installFixtureDirectory, "node_modules"),
		);

		// Provide the runtime dependencies from the installed tree so the
		// sources can load without network access.
		const hostNodeModules = realpathSync(join(projectRoot, "node_modules"));
		mkdirSync(cloneNodeModules, { recursive: true });
		for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
			const hostedDependency = join(hostNodeModules, dependency);
			if (!existsSync(hostedDependency)) {
				fail(`installed dependency tree is missing ${dependency}`);
			}
			const linkPath = join(cloneNodeModules, dependency);
			mkdirSync(dirname(linkPath), { recursive: true });
			symlinkSync(hostedDependency, linkPath, "dir");
		}
	} else {
		fail(
			`npm install --omit=dev in the clone failed with a non-network error (exit ${registryInstall.status}):\n${registryInstall.stderr}`,
		);
	}

	// Stage 2: load the checkout's entrypoint through the installed Pi loader
	// with configuration and credentials isolated.
	mkdirSync(isolatedAgentDir, { recursive: true });
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
			manifestEntries.map((entry) => join(cloneDirectory, entry)),
			cloneDirectory,
		);
		if (errors.length > 0) {
			fail(
				`Pi extension loader reported errors: ${errors.map((e) => e.error).join("; ")}`,
			);
		}
		if (extensions.length !== manifestEntries.length) {
			fail(
				`expected ${manifestEntries.length} loaded extension, got ${extensions.length}`,
			);
		}
		const loadedCommands = [...extensions[0].commands.keys()];
		for (const expectedCommand of EXPECTED_COMMANDS) {
			if (!loadedCommands.includes(expectedCommand)) {
				fail(
					`loaded extension did not register command ${expectedCommand} (registered: ${loadedCommands.join(", ")})`,
				);
			}
		}
		if (extensions[0].handlers.size === 0) {
			fail("loaded extension did not register any event handlers");
		}

		// Stage 3: development checkouts keep the husky hook setup. Restores
		// are unnecessary because the clone and its hook files are temporary.
		const huskyBin = join(
			realpathSync(join(projectRoot, "node_modules")),
			"husky",
			"bin.js",
		);
		if (!existsSync(huskyBin)) {
			fail("development tree is missing the husky binary needed for stage 3");
		}
		const huskyResult = spawnSync(process.execPath, [huskyBin], {
			cwd: cloneDirectory,
			encoding: "utf8",
		});
		if (huskyResult.status !== 0) {
			fail(
				`husky setup failed in a development checkout: ${huskyResult.stderr}`,
			);
		}
		const hooksPathResult = runGit(
			["config", "core.hooksPath"],
			cloneDirectory,
		);
		if (hooksPathResult.stdout.trim() !== ".husky/_") {
			fail(
				`development checkout did not configure core.hooksPath (got: ${hooksPathResult.stdout.trim() || "unset"})`,
			);
		}

		console.log(
			`Git install smoke passed (${installMode} mode): clean checkout installs with scripts and no dev ` +
				`dependencies, Pi loaded ${manifestEntries.join(", ")} registering ` +
				`${loadedCommands.length} commands, development hook setup intact.`,
		);
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
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
