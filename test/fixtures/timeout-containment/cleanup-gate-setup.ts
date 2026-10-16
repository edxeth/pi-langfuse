import { afterAll } from "vitest";

/**
 * Child-run setup file that holds the Vitest worker open until late work has
 * run after every other `afterAll` hook.
 *
 * It must be the FIRST entry in `setupFiles`: with the default `stack` hook
 * order, the hook registered first runs last, so it opens the gate only after
 * the boundary under test (`test/setup.ts` or the legacy copy) has finished
 * its own cleanup. A fixture test that times out while awaiting the gate
 * therefore resumes strictly after setup cleanup, with no wall-clock race.
 */
export const containmentState = {
	gate: undefined as unknown as Promise<void>,
	/** Pushed by fixture tests: the work that resumes once the gate opens. */
	lateWork: [] as Array<Promise<unknown>>,
};

let openGate: () => void = () => {};
containmentState.gate = new Promise<void>((resolve) => {
	openGate = resolve;
});
(globalThis as Record<symbol, unknown>)[
	Symbol.for("pi-langfuse.containment.state")
] = containmentState;

afterAll(async () => {
	openGate();
	await Promise.all(containmentState.lateWork);
}, 30_000);
