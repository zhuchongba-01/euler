import {
	type Command,
	type CommandResult,
	DEFAULT_MAX_FRAME_LENGTH,
	encodeClientMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ResultForCommand,
	type ServerEvent,
	type ServerMessage,
	ServerMessageDecoder,
	type ServerSnapshot,
	type SessionSnapshot,
	type SessionSummary,
} from "@earendil-works/pi-protocol";
import { PiDisconnectedError, PiError, PiSessionDetachedError, toDisconnectedError, toError } from "./errors.ts";
import { notifyListeners } from "./listeners.ts";
import { PiSessionClient } from "./session-client.ts";
import type { ByteTransport, ByteTransportHandlers } from "./transport.ts";
import type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	PendingRequest,
	PiClientOptions,
	Unsubscribe,
} from "./types.ts";

const MAX_UINT32 = 0xffff_ffff;
export class PiClient {
	private readonly options: PiClientOptions;
	private readonly maxFrameLength: number;
	private transport: ByteTransport | undefined;
	private decoder: ServerMessageDecoder | undefined;
	private connectionSequence = 0;
	private stateValue: ConnectionState = "disconnected";
	private snapshotValue: ServerSnapshot | undefined;
	private readonly sessionSnapshots = new Map<string, SessionSnapshot>();
	private readonly attachedSessionIds = new Set<string>();
	private readonly sessionHandles = new Map<string, PiSessionClient>();
	private readonly snapshotListeners = new Set<(snapshot: ServerSnapshot) => void>();
	private readonly eventListeners = new Set<(event: ServerEvent) => void>();
	private readonly stateListeners = new Set<(change: ConnectionStateChange) => void>();
	private readonly sessionSnapshotListeners = new Map<string, Set<(snapshot: SessionSnapshot) => void>>();
	private readonly sessionEventListeners = new Map<string, Set<(event: ServerEvent) => void>>();
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private requestSequence = 0;
	private connectResolve: ((snapshot: ServerSnapshot) => void) | undefined;
	private connectReject: ((error: Error) => void) | undefined;

	constructor(options: PiClientOptions) {
		this.options = options;
		this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		if (!Number.isSafeInteger(this.maxFrameLength) || this.maxFrameLength <= 0 || this.maxFrameLength > MAX_UINT32) {
			throw new TypeError(`PiClient maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
		}
	}

	get connectionState(): ConnectionState {
		return this.stateValue;
	}
	get connected(): boolean {
		return this.stateValue === "connected";
	}
	get snapshot(): ServerSnapshot | undefined {
		return this.snapshotValue;
	}
	get sessions(): readonly SessionSummary[] {
		return this.snapshotValue?.sessions ?? [];
	}

	connect(): Promise<ServerSnapshot> {
		if (this.stateValue !== "disconnected") {
			return Promise.reject(new PiDisconnectedError(`PiClient is already ${this.stateValue}`));
		}
		this.setConnectionState("connecting");
		this.snapshotValue = undefined;
		this.sessionSnapshots.clear();
		this.attachedSessionIds.clear();
		this.decoder = new ServerMessageDecoder({ maxFrameLength: this.maxFrameLength });
		const connectionId = ++this.connectionSequence;
		const connected = new Promise<ServerSnapshot>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
		});
		const handlers: ByteTransportHandlers = {
			onData: (chunk) => {
				if (!this.isCurrentConnection(connectionId)) return;
				if (!this.transport) {
					this.protocolFailure(
						new ProtocolValidationError("Received server data before the client hello was sent"),
					);
					return;
				}
				this.handleChunk(chunk);
			},
			onClose: () => {
				if (this.isCurrentConnection(connectionId)) this.handleTransportClose();
			},
			onError: (error) => {
				if (this.isCurrentConnection(connectionId)) this.handleTransportError(error);
			},
		};
		void this.openTransport(connectionId, handlers);
		return connected;
	}

	reconnect(): Promise<ServerSnapshot> {
		return this.connect();
	}
	disconnect(reason = "Client disconnected"): void {
		if (this.stateValue === "disconnected") return;
		const transport = this.transport;
		this.failConnection(new PiDisconnectedError(reason));
		transport?.close();
	}
	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.snapshotListeners.add(listener);
		return () => this.snapshotListeners.delete(listener);
	}
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}
	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}
	getSession(sessionId: string): PiSessionClient {
		let handle = this.sessionHandles.get(sessionId);
		if (!handle) {
			handle = new PiSessionClient(this, sessionId);
			this.sessionHandles.set(sessionId, handle);
		}
		return handle;
	}
	getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		return this.sessionSnapshots.get(sessionId);
	}
	isSessionAttached(sessionId: string): boolean {
		return this.attachedSessionIds.has(sessionId);
	}
	async listSessions(): Promise<readonly SessionSummary[]> {
		return (await this.request({ command: "list" })).sessions;
	}
	async createSession(options: CreateSessionOptions = {}): Promise<PiSessionClient> {
		const result = await this.request({ command: "create", ...options });
		return this.getSession(result.session.id);
	}
	async attachSession(sessionId: string): Promise<PiSessionClient> {
		const previous = this.sessionSnapshots.get(sessionId);
		this.sessionSnapshots.delete(sessionId);
		try {
			await this.request({ command: "attach", sessionId });
			return this.getSession(sessionId);
		} catch (error) {
			if (previous && !this.sessionSnapshots.has(sessionId)) this.sessionSnapshots.set(sessionId, previous);
			throw error;
		}
	}
	async detachSession(sessionId: string): Promise<void> {
		await this.request({ command: "detach", sessionId });
	}

	request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		const transport = this.transport;
		if (this.stateValue !== "connected" || !transport) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.requestSequence}`;
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, request: command },
				{ maxFrameLength: this.maxFrameLength },
			);
		} catch (error) {
			return Promise.reject(toError(error));
		}
		const promise = new Promise<CommandResult>((resolve, reject) => {
			this.pendingRequests.set(id, { command, resolve, reject });
		});
		this.sendFrame(transport, frame);
		return promise as Promise<ResultForCommand<TCommand>>;
	}

	subscribeSession(sessionId: string, listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		let listeners = this.sessionSnapshotListeners.get(sessionId);
		if (!listeners) {
			listeners = new Set();
			this.sessionSnapshotListeners.set(sessionId, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.sessionSnapshotListeners.delete(sessionId);
		};
	}
	onSessionEvent(sessionId: string, listener: (event: ServerEvent) => void): Unsubscribe {
		let listeners = this.sessionEventListeners.get(sessionId);
		if (!listeners) {
			listeners = new Set();
			this.sessionEventListeners.set(sessionId, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.sessionEventListeners.delete(sessionId);
		};
	}
	assertAttached(sessionId: string): void {
		if (this.stateValue !== "connected") throw new PiDisconnectedError();
		if (!this.attachedSessionIds.has(sessionId)) throw new PiSessionDetachedError(sessionId);
	}

	private async openTransport(connectionId: number, handlers: ByteTransportHandlers): Promise<void> {
		let transport: ByteTransport;
		try {
			transport = await this.options.transportFactory(handlers);
		} catch (error) {
			if (this.isCurrentConnection(connectionId)) this.failConnection(toDisconnectedError(error));
			return;
		}
		if (!this.isCurrentConnection(connectionId)) {
			transport.close();
			return;
		}
		this.transport = transport;
		try {
			await transport.send(
				encodeClientMessage(
					{ type: "hello", version: PROTOCOL_VERSION, token: this.options.token },
					{ maxFrameLength: this.maxFrameLength },
				),
			);
		} catch (error) {
			if (this.isCurrentConnection(connectionId)) {
				this.failConnection(toDisconnectedError(error));
				transport.close();
			}
		}
	}
	private sendFrame(transport: ByteTransport, frame: Uint8Array): void {
		let sending: Promise<void>;
		try {
			sending = transport.send(frame);
		} catch (error) {
			this.handleTransportError(toError(error));
			return;
		}
		void sending.catch((error: unknown) => {
			if (this.transport === transport) this.handleTransportError(toError(error));
		});
	}
	private handleChunk(chunk: Uint8Array): void {
		let messages: ServerMessage[];
		try {
			messages = this.decoder?.push(chunk) ?? [];
		} catch (error) {
			this.protocolFailure(toError(error));
			return;
		}
		for (const message of messages) {
			if (this.stateValue === "disconnected") return;
			this.handleMessage(message);
		}
	}
	private handleMessage(message: ServerMessage): void {
		if (this.stateValue === "connecting") {
			if (message.type === "hello_error") {
				const transport = this.transport;
				this.failConnection(new PiError(message.error));
				transport?.close();
				return;
			}
			if (message.type !== "hello") {
				this.protocolFailure(new ProtocolValidationError("Expected server hello as first message"));
				return;
			}
			this.setConnectionState("connected");
			this.applyServerSnapshot(message.snapshot);
			const resolve = this.connectResolve;
			this.connectResolve = undefined;
			this.connectReject = undefined;
			resolve?.(message.snapshot);
			return;
		}
		if (this.stateValue !== "connected") return;
		if (message.type === "hello" || message.type === "hello_error") {
			this.protocolFailure(new ProtocolValidationError("Unexpected handshake message"));
			return;
		}
		if (message.type === "event") {
			this.applyEvent(message.event);
			return;
		}
		const pending = this.pendingRequests.get(message.id);
		if (!pending) {
			this.protocolFailure(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		this.pendingRequests.delete(message.id);
		if (!message.ok) {
			pending.reject(new PiError(message.error));
			return;
		}
		if (message.result.command !== pending.command.command) {
			const error = new ProtocolValidationError(
				`Response command ${message.result.command} does not match ${pending.command.command}`,
			);
			pending.reject(error);
			this.protocolFailure(error);
			return;
		}
		this.applyResult(message.result);
		pending.resolve(message.result);
	}
	private applyResult(result: CommandResult): void {
		if (result.command === "list") return;
		if (result.command === "detach") {
			this.attachedSessionIds.delete(result.sessionId);
			const snapshot = this.sessionSnapshots.get(result.sessionId);
			if (snapshot) this.applySessionSnapshot({ ...snapshot, attached: false }, true);
			return;
		}
		this.applySessionSnapshot(result.session);
	}
	private applyEvent(event: ServerEvent): void {
		if (event.type === "server_snapshot") this.applyServerSnapshot(event.snapshot);
		if (event.type === "session_snapshot") this.applySessionSnapshot(event.snapshot);
		if (event.type === "session_removed") {
			this.sessionSnapshots.delete(event.sessionId);
			this.attachedSessionIds.delete(event.sessionId);
		}
		notifyListeners(this.eventListeners, event);
		const sessionId = getEventSessionId(event);
		if (sessionId) notifyListeners(this.sessionEventListeners.get(sessionId), event);
	}
	private applyServerSnapshot(snapshot: ServerSnapshot): void {
		if (this.snapshotValue && snapshot.revision < this.snapshotValue.revision) return;
		this.snapshotValue = snapshot;
		this.attachedSessionIds.clear();
		for (const session of snapshot.sessions) if (session.attached) this.attachedSessionIds.add(session.id);
		notifyListeners(this.snapshotListeners, snapshot);
	}
	private applySessionSnapshot(snapshot: SessionSnapshot, force = false): void {
		const current = this.sessionSnapshots.get(snapshot.id);
		if (!force && current && snapshot.revision < current.revision) return;
		this.sessionSnapshots.set(snapshot.id, snapshot);
		if (snapshot.attached) this.attachedSessionIds.add(snapshot.id);
		else this.attachedSessionIds.delete(snapshot.id);
		notifyListeners(this.sessionSnapshotListeners.get(snapshot.id), snapshot);
	}
	private handleTransportClose(): void {
		let error: Error = new PiDisconnectedError("Byte transport closed");
		try {
			this.decoder?.end();
		} catch (decoderError) {
			error = toError(decoderError);
		}
		this.failConnection(error);
	}
	private handleTransportError(error: Error): void {
		const transport = this.transport;
		this.failConnection(toDisconnectedError(error));
		transport?.close();
	}
	private protocolFailure(error: Error): void {
		const transport = this.transport;
		this.failConnection(error);
		transport?.close();
	}
	private failConnection(error: Error): void {
		if (this.stateValue === "disconnected") return;
		const reject = this.connectReject;
		const pending = [...this.pendingRequests.values()];
		this.transport = undefined;
		this.decoder = undefined;
		this.connectResolve = undefined;
		this.connectReject = undefined;
		this.pendingRequests.clear();
		this.attachedSessionIds.clear();
		reject?.(error);
		for (const request of pending) request.reject(error);
		this.setConnectionState("disconnected", error);
	}
	private isCurrentConnection(connectionId: number): boolean {
		return connectionId === this.connectionSequence && this.stateValue !== "disconnected";
	}
	private setConnectionState(state: ConnectionState, error?: Error): void {
		this.stateValue = state;
		notifyListeners(this.stateListeners, error ? { state, error } : { state });
	}
}

function getEventSessionId(event: ServerEvent): string | undefined {
	if (event.type === "session_snapshot") return event.snapshot.id;
	if (event.type === "session_progress" || event.type === "session_removed") return event.sessionId;
	return undefined;
}
