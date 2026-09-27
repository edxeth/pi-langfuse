// Sets up Git hooks via husky in development checkouts only.
//
// husky is a devDependency, so production installs (npm install --omit=dev,
// including Pi Git installs that run this script through `prepare`) must skip
// quietly. Every other failure - permissions, a broken husky install, husky
// exiting nonzero - must propagate so hook setup problems are not swallowed.
// This wrapper exists because `husky || <fallback>` cannot distinguish
// command-not-found from a real husky failure.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let huskyBin;
try {
	// husky's exports map only exposes "./index.js"; its bin.js sits beside it.
	huskyBin = join(dirname(require.resolve("husky")), "bin.js");
} catch {
	// husky is not installed; hook setup is development-only.
	process.exit(0);
}

const result = spawnSync(process.execPath, [huskyBin], {
	stdio: "inherit",
	env: (() => {
		// Hooks can inherit GIT_DIR from a linked-worktree commit; husky must
		// always operate on the repository containing this checkout.
		const environment = { ...process.env };
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
			delete environment[key];
		}
		return environment;
	})(),
});
if (result.error) {
	console.error(
		`prepare: husky could not be executed: ${result.error.message}`,
	);
	process.exit(1);
}
process.exit(result.status ?? 1);
