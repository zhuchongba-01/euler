import type {
	CommandResult,
	ServerEvent,
	ServerSnapshot,
	SessionSnapshot,
	SessionSummary,
} from "@earendil-works/pi-protocol";
import { notifyListeners } from "./listeners.ts";
import type { ListenerErrorHandler, Unsubscribe } from "./types.ts";

export class ClientStateStore {
	readonly #sessionSnapshots = new Map<string, SessionSnapshot>();
	readonly #attachedSessionIds = new Set<string>();
	readonly #snapshotListeners = new Set<(snapshot: ServerSnapshot) => void>();
	readonly #eventListeners = new Set<(event: ServerEvent) => void>();
	readonly #sessionSnapshotListeners = new Map<string, Set<(snapshot: SessionSnapshot) => void>>();
	readonly #sessionEventListeners = new Map<string, Set<(event: ServerEvent) => void>>();
	readonly #onListenerError: ListenerErrorHandler | undefined;
	#snapshot: ServerSnapshot | undefined;

	constructor(onListenerError?: ListenerErrorHandler) {
		this.#onListenerError = onListenerError;
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#snapshot;
	}

	get sessions(): readonly SessionSummary[] {
		return this.#snapshot?.sessions ?? [];
	}

	reset(): void {
		this.#snapshot = undefined;
		this.#sessionSnapshots.clear();
		this.#attachedSessionIds.clear();
	}

	clearAttachments(): void {
		this.#attachedSessionIds.clear();
	}

	getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		return this.#sessionSnapshots.get(sessionId);
	}

	isSessionAttached(sessionId: string): boolean {
		return this.#attachedSessionIds.has(sessionId);
	}

	forgetSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		const previous = this.#sessionSnapshots.get(sessionId);
		this.#sessionSnapshots.delete(sessionId);
		return previous;
	}

	restoreSessionSnapshot(snapshot: SessionSnapshot): void {
		if (!this.#sessionSnapshots.has(snapshot.id)) this.#sessionSnapshots.set(snapshot.id, snapshot);
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#snapshotListeners.add(listener);
		return () => this.#snapshotListeners.delete(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	subscribeSession(sessionId: string, listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return addMappedListener(this.#sessionSnapshotListeners, sessionId, listener);
	}

	onSessionEvent(sessionId: string, listener: (event: ServerEvent) => void): Unsubscribe {
		return addMappedListener(this.#sessionEventListeners, sessionId, listener);
	}

	applyResult(result: CommandResult): void {
		if (result.command === "list") return;
		if (result.command === "detach") {
			this.#attachedSessionIds.delete(result.sessionId);
			const snapshot = this.#sessionSnapshots.get(result.sessionId);
			if (snapshot) this.#applySessionSnapshot({ ...snapshot, attached: false }, true);
			return;
		}
		this.#applySessionSnapshot(result.session);
	}

	applyEvent(event: ServerEvent): void {
		if (event.type === "server_snapshot") this.applyServerSnapshot(event.snapshot);
		if (event.type === "session_snapshot") this.#applySessionSnapshot(event.snapshot);
		if (event.type === "session_removed") {
			this.#sessionSnapshots.delete(event.sessionId);
			this.#attachedSessionIds.delete(event.sessionId);
		}
		notifyListeners(this.#eventListeners, event, this.#onListenerError);
		const sessionId = getEventSessionId(event);
		if (sessionId) notifyListeners(this.#sessionEventListeners.get(sessionId), event, this.#onListenerError);
	}

	applyServerSnapshot(snapshot: ServerSnapshot): void {
		if (this.#snapshot && snapshot.revision < this.#snapshot.revision) return;
		this.#snapshot = snapshot;
		this.#attachedSessionIds.clear();
		for (const session of snapshot.sessions) if (session.attached) this.#attachedSessionIds.add(session.id);
		notifyListeners(this.#snapshotListeners, snapshot, this.#onListenerError);
	}

	#applySessionSnapshot(snapshot: SessionSnapshot, force = false): void {
		const current = this.#sessionSnapshots.get(snapshot.id);
		if (!force && current && snapshot.revision < current.revision) return;
		this.#sessionSnapshots.set(snapshot.id, snapshot);
		if (snapshot.attached) this.#attachedSessionIds.add(snapshot.id);
		else this.#attachedSessionIds.delete(snapshot.id);
		notifyListeners(this.#sessionSnapshotListeners.get(snapshot.id), snapshot, this.#onListenerError);
	}
}

function addMappedListener<T>(
	listenersById: Map<string, Set<(value: T) => void>>,
	id: string,
	listener: (value: T) => void,
): Unsubscribe {
	let listeners = listenersById.get(id);
	if (!listeners) {
		listeners = new Set();
		listenersById.set(id, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) listenersById.delete(id);
	};
}

function getEventSessionId(event: ServerEvent): string | undefined {
	if (event.type === "session_snapshot") return event.snapshot.id;
	if (event.type === "session_progress" || event.type === "session_removed") return event.sessionId;
	return undefined;
}
