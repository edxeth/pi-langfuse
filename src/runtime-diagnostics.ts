/** A historical telemetry failure, available to /langfuse-status. */
export interface RuntimeError {
	message: string;
	timestamp: string;
}

let lastRuntimeError: RuntimeError | undefined;
const listeners = new Set<(error: RuntimeError) => void>();

/** Record an error without writing into Pi's terminal renderer. */
export function recordRuntimeError(error: unknown, cause?: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const detail = cause instanceof Error ? cause.message : cause;
	lastRuntimeError = {
		message: detail === undefined ? message : `${message}: ${String(detail)}`,
		timestamp: new Date().toISOString(),
	};
	for (const listener of listeners) {
		try {
			listener(lastRuntimeError);
		} catch {
			// A disposed UI must not interrupt telemetry or the agent's work.
		}
	}
}

/** Return the most recent failure; success does not erase error history. */
export function getLastRuntimeError(): RuntimeError | undefined {
	return lastRuntimeError;
}

/** Subscribe a Pi UI for its session lifetime; the return value detaches it. */
export function subscribeRuntimeErrors(
	listener: (error: RuntimeError) => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
