import { writeFileSync } from "node:fs";
import { join } from "node:path";

type ContainmentState = {
	gate: Promise<void>;
	lateWork: Array<Promise<unknown>>;
};

/** Shared state created by `cleanup-gate-setup.ts` (same worker, one object). */
export function containmentState(): ContainmentState {
	const state = (globalThis as Record<symbol, unknown>)[
		Symbol.for("pi-langfuse.containment.state")
	];
	if (!state) throw new Error("cleanup-gate-setup.ts did not run first");
	return state as ContainmentState;
}

/**
 * What a late callback observed. Credentials appear as labels, never values,
 * so the probe file is safe to keep as evidence.
 */
export type LateProbe = Record<string, unknown>;

export function credentialLabel(value: string | undefined): string {
	if (value === undefined) return "absent";
	if (value.includes("canary")) return "canary";
	if (value.includes("test-isolation")) return "test-isolation";
	if (value.includes("runtime-test")) return "runtime-test";
	return "other";
}

/** Written outside any home or sandbox, into a directory the parent test owns. */
export function writeProbe(name: string, probe: LateProbe) {
	const directory = process.env.CONTAINMENT_PROBE_DIR;
	if (!directory) throw new Error("CONTAINMENT_PROBE_DIR is not set");
	writeFileSync(
		join(directory, `${name}.json`),
		`${JSON.stringify(probe, null, 2)}\n`,
	);
}
