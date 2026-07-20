export interface SessionManagerIdentity {
	getSessionFile?: () => string | undefined;
	getSessionId?: () => string;
}

export interface SessionContextLike {
	sessionManager?: SessionManagerIdentity;
}

export interface SessionState<PromptState> {
	sessionId: string;
	sessionFile: string;
	previousSessionFile: string;
	sessionReason: string;
	model: string;
	provider: string;
	promptState: PromptState | null;
	compactCount: number;
	lease: symbol;
	shutdownPromise?: Promise<void>;
	promptStartPromise?: Promise<void>;
	promptStartSignature?: string;
}

type SessionKey = string | object;

const activeSessionLeases = new Set<symbol>();

function acquireSessionLease() {
	const lease = Symbol("pi-langfuse-session");
	activeSessionLeases.add(lease);
	return lease;
}

function releaseSessionLease(lease: symbol) {
	activeSessionLeases.delete(lease);
}

export function hasActiveSessionLeases() {
	return activeSessionLeases.size > 0;
}

function sessionIdFromFile(sessionFile: string | undefined) {
	if (!sessionFile) return "";
	const filename = sessionFile.split("/").pop() || "";
	return filename.replace(".jsonl", "");
}

function getSessionKey(
	context: SessionContextLike | undefined,
): SessionKey | undefined {
	const manager = context?.sessionManager;
	if (!manager) return undefined;
	const sessionFile = manager.getSessionFile?.();
	if (sessionFile) return `file:${sessionFile}`;
	const sessionId = manager.getSessionId?.();
	if (sessionId) return `id:${sessionId}`;
	return manager as object;
}

function createSessionState<PromptState>(
	context: SessionContextLike,
): SessionState<PromptState> {
	const manager = context.sessionManager;
	const sessionFile = manager?.getSessionFile?.() || "";
	const sessionId = sessionIdFromFile(sessionFile);
	return {
		sessionId,
		sessionFile,
		previousSessionFile: "",
		sessionReason: "startup",
		model: "",
		provider: "",
		promptState: null,
		compactCount: 0,
		lease: acquireSessionLease(),
	};
}

/**
 * Owns mutable telemetry state for each Pi session.
 *
 * Persisted sessions use their session file as the stable key. Unpersisted
 * sessions use the session manager object, so two live sessions cannot fall
 * back to one process-global state. Calls without a context are accepted only
 * when exactly one session is known, which keeps direct test invocations from
 * guessing when multiple sessions are active.
 */
export class SessionStateOwner<PromptState> {
	private readonly states = new Map<SessionKey, SessionState<PromptState>>();

	get(context?: SessionContextLike): SessionState<PromptState> | undefined {
		const key = getSessionKey(context);
		if (key !== undefined) return this.states.get(key);
		return this.states.size === 1
			? this.states.values().next().value
			: undefined;
	}

	getOrCreate(
		context: SessionContextLike | undefined,
	): SessionState<PromptState> | undefined {
		const key = getSessionKey(context);
		if (key === undefined || !context) return this.get(context);
		const existing = this.states.get(key);
		if (existing) return existing;
		const state = createSessionState<PromptState>(context);
		this.states.set(key, state);
		return state;
	}

	deleteState(state: SessionState<PromptState>): boolean {
		for (const [key, candidate] of this.states) {
			if (candidate !== state) continue;
			releaseSessionLease(state.lease);
			return this.states.delete(key);
		}
		return false;
	}

	values(): SessionState<PromptState>[] {
		return Array.from(this.states.values());
	}
}
