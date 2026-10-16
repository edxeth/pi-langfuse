import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageVersion } from "./package-version.js";

let root = "";

function layout(manifest: unknown, moduleDirectory: string) {
	root = mkdtempSync(join(homedir(), "package-version-"));
	writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
	mkdirSync(join(root, moduleDirectory), { recursive: true });
	return pathToFileURL(join(root, moduleDirectory, "langfuse-client.js"));
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("readPackageVersion", () => {
	it("reads this package's own version from the source layout", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
		) as { version: string };
		expect(readPackageVersion()).toBe(manifest.version);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it.each([
		["source", "src"],
		["compiled", "dist"],
	])("finds the manifest one level above a %s module", (_name, directory) => {
		const url = layout({ name: "pi-langfuse", version: "9.8.7" }, directory);
		expect(readPackageVersion(url)).toBe("9.8.7");
	});

	it("refuses another package's manifest and a missing version", () => {
		expect(() =>
			readPackageVersion(layout({ name: "other", version: "1.0.0" }, "dist")),
		).toThrow(/not the pi-langfuse package manifest/);
		expect(() =>
			readPackageVersion(layout({ name: "pi-langfuse" }, "dist")),
		).toThrow(/no package version/);
		expect(() =>
			readPackageVersion(layout({ name: "pi-langfuse", version: "" }, "dist")),
		).toThrow(/no package version/);
	});
});
