import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const prepareScript = fileURLToPath(
	new URL("../scripts/prepare-husky.mjs", import.meta.url),
);

const temporaryRoots: string[] = [];

afterAll(() => {
	for (const root of temporaryRoots.splice(0)) {
		const stubBin = join(root, "node_modules", "husky", "bin.js");
		if (existsSync(stubBin)) {
			chmodSync(stubBin, 0o644);
		}
		rmSync(root, { recursive: true, force: true });
	}
});

type FixtureMode = "missing" | "succeeds" | "fails" | "unexecutable";

function makeFixture(mode: FixtureMode): string {
	const root = mkdtempSync(join(tmpdir(), "prepare-husky-fixture-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, "scripts"), { recursive: true });
	cpSync(prepareScript, join(root, "scripts", "prepare-husky.mjs"));
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: "prepare-husky-fixture", private: true })}\n`,
	);
	if (mode === "missing") {
		mkdirSync(join(root, "node_modules"), { recursive: true });
		return root;
	}
	const huskyDirectory = join(root, "node_modules", "husky");
	mkdirSync(huskyDirectory, { recursive: true });
	writeFileSync(
		join(huskyDirectory, "package.json"),
		`${JSON.stringify({
			name: "husky",
			type: "module",
			exports: "./index.js",
			bin: { husky: "bin.js" },
		})}\n`,
	);
	writeFileSync(join(huskyDirectory, "index.js"), "");
	const stubExitCode = mode === "fails" ? 3 : 0;
	writeFileSync(
		join(huskyDirectory, "bin.js"),
		[
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(join(root, "husky-ran"))}, "");`,
			`process.exit(${stubExitCode});`,
			"",
		].join("\n"),
	);
	if (mode === "unexecutable") {
		chmodSync(join(huskyDirectory, "bin.js"), 0o000);
	}
	return root;
}

function runPrepare(root: string) {
	return spawnSync(
		process.execPath,
		[join(root, "scripts", "prepare-husky.mjs")],
		{ cwd: root, encoding: "utf8" },
	);
}

describe("prepare-husky", () => {
	it("skips hook setup when husky is not installed (production install)", () => {
		const root = makeFixture("missing");
		const result = runPrepare(root);
		expect(result.status).toBe(0);
		expect(existsSync(join(root, "husky-ran"))).toBe(false);
	});

	it("runs husky when it is installed", () => {
		const root = makeFixture("succeeds");
		const result = runPrepare(root);
		expect(result.status).toBe(0);
		expect(existsSync(join(root, "husky-ran"))).toBe(true);
	});

	it("propagates husky failures instead of swallowing them", () => {
		const root = makeFixture("fails");
		const result = runPrepare(root);
		expect(result.status).toBe(3);
	});

	it("fails when husky cannot be executed (e.g. EACCES)", () => {
		const root = makeFixture("unexecutable");
		const result = runPrepare(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("EACCES");
	});
});
