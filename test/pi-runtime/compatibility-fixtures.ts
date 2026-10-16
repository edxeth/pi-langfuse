import { type Mock, vi } from "vitest";

/** One recorded fake trace or observation created by the mocked Langfuse stack. */
export interface FakeRecord {
	kind: "trace" | "observation";
	id: string;
	name?: string;
	traceId?: string;
	parentObservationId?: string;
	[key: string]: unknown;
}

/** Everything the mocked Langfuse stack recorded during one test. */
export interface FakeTelemetryState {
	traces: FakeRecord[];
	observations: FakeRecord[];
	scores: Array<Record<string, unknown>>;
	flushes: number;
	shutdowns: number;
	received: Array<{ traceId: string; spanId: string }>;
}

/**
 * The slice of the hoisted telemetry mock that scenario modules read.
 * The driver (`src/compatibility.test.ts`) owns the full hoisted mock and its
 * `vi.mock` registrations; scenarios only inspect recorded state and the
 * client mocks named here.
 */
export interface CompatibilityTelemetry {
	state: FakeTelemetryState;
	LangfuseClient: Mock;
	client: { score: { create: Mock<(body: Record<string, unknown>) => void> } };
}

/**
 * Dependencies the driver injects into every scenario registration function.
 * The driver owns both: the hoisted telemetry mock and the temporary-root
 * list its `afterEach` hook cleans up.
 */
export interface CompatibilityScenarioContext {
	telemetry: CompatibilityTelemetry;
	/** Creates a temporary directory that the driver removes after the test. */
	tempRoot: (prefix: string) => string;
}

/** Handler shape registered through `pi.on` and `pi.events.on`. */
export type EventHandler = (
	event?: unknown,
	ctx?: unknown,
) => Promise<void> | void;
/** The fake Pi API returned by {@link createTestPi}. */
export type TestPi = ReturnType<typeof createTestPi>;

/** Settings-panel registration payload emitted by the extension. */
export type Registration = {
	extension: string;
	nodes: Record<string, { default: unknown }>;
	documentation: string;
};

/**
 * Builds a fake Pi API whose settings probe answers with `settingsValues`.
 * Every registration surface is a `vi.fn` so scenarios can read the calls.
 */
export function createTestPi(settingsValues?: Record<string, unknown>) {
	const pi = {
		events: {
			on: vi.fn(),
			emit: vi.fn((event: string, probe: { values?: unknown }) => {
				if (event === "extension:settings:get" && settingsValues) {
					probe.values = settingsValues;
				}
			}),
		},
		on: vi.fn(),
		registerCommand: vi.fn(),
		model: { id: "fallback-model", provider: "fallback-provider" },
	};
	return pi;
}

/** Returns the handler the extension registered for a Pi event. */
export function eventHandler(pi: TestPi, name: string): EventHandler {
	const call = pi.on.mock.calls.find((item) => item[0] === name);
	if (!call) throw new Error(`event handler not registered: ${name}`);
	return call[1] as EventHandler;
}

/** Returns the listener the extension registered on the settings event bus. */
export function settingsListener(pi: TestPi, name: string): EventHandler {
	const call = pi.events.on.mock.calls.find((item) => item[0] === name);
	if (!call) throw new Error(`settings listener not registered: ${name}`);
	return call[1] as EventHandler;
}

/** Returns the first fake record with `name`; throws when none exists. */
export function latestRecord(records: FakeRecord[], name: string) {
	const record = records.find((item) => item.name === name);
	if (!record) throw new Error(`record not found: ${name}`);
	return record;
}

/** Builds the structured assistant output the extension records. */
export function assistantOutput(text: string, thinking?: string) {
	return {
		text,
		tool_calls: [],
		...(thinking !== undefined ? { thinking } : {}),
	};
}

/** Lists every settings registration the extension emitted. */
export function settingsRegistrations(pi: TestPi): Registration[] {
	return pi.events.emit.mock.calls
		.filter((item) => item[0] === "pi-extension-settings:register")
		.map((item) => item[1] as Registration);
}

/** Returns the first settings registration; throws when none was emitted. */
export function registeredSettings(pi: TestPi): Registration {
	const registration = settingsRegistrations(pi)[0];
	if (!registration) throw new Error("settings registration was not emitted");
	return registration;
}

/** Waits for the settings refresh that follows `previousCount` registrations. */
export async function waitForSettingsRegistration(
	pi: TestPi,
	previousCount: number,
): Promise<Registration> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const registrations = settingsRegistrations(pi);
		if (registrations.length > previousCount) {
			const registration = registrations.at(-1);
			if (registration) return registration;
		}
		await Promise.resolve();
	}
	throw new Error("settings refresh did not re-register settings");
}

/** Returns the first raw-trace record of `type`; throws when none exists. */
export function rawRecord(
	records: Array<Record<string, unknown>>,
	type: string,
) {
	const record = records.find((item) => item.type === type);
	if (!record) throw new Error(`raw record not found: ${type}`);
	return record;
}
