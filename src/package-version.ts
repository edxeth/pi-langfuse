import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "pi-langfuse";

/**
 * Version from this package's own package.json. Source (`src/*.ts`) and
 * compiled (`dist/*.js`) modules both sit one directory below the package
 * root, so one relative lookup serves the repository, the npm tarball, and
 * the git-install layout. `fromUrl` exists so tests can model those layouts.
 */
export function readPackageVersion(
	fromUrl: string | URL = import.meta.url,
): string {
	const path = fileURLToPath(new URL("../package.json", fromUrl));
	// SAFETY: both fields are typed unknown and checked below before use.
	const manifest = JSON.parse(readFileSync(path, "utf-8")) as {
		name?: unknown;
		version?: unknown;
	};
	if (manifest.name !== PACKAGE_NAME) {
		throw new Error(
			`${path} is not the ${PACKAGE_NAME} package manifest; cannot read the service version`,
		);
	}
	if (typeof manifest.version !== "string" || manifest.version === "") {
		throw new Error(`${path} has no package version`);
	}
	return manifest.version;
}
