/**
 * Config for the child Vitest runs in `test/timeout-containment.test.ts`. It
 * has no imports on purpose: it is loaded with a scrubbed environment.
 *
 * `CONTAINMENT_SETUP` selects the bootstrap under test: `real` runs
 * `test/setup.ts`, `legacy` runs the pre-fix restoring bootstrap. The gate
 * file stays first so its `afterAll` hook runs last.
 */
const setup =
	process.env.CONTAINMENT_SETUP === "legacy"
		? "./test/fixtures/timeout-containment/legacy-restoring-setup.ts"
		: "./test/setup.ts";

export default {
	test: {
		globals: true,
		environment: "node",
		setupFiles: [
			"./test/fixtures/timeout-containment/cleanup-gate-setup.ts",
			setup,
		],
		include: ["test/fixtures/timeout-containment/*.child.ts"],
	},
};
