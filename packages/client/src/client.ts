import {
	type Command,
	DEFAULT_MAX_FRAME_LENGTH,
	encodeClientMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ResultForCommand,
	type ServerEvent,
	type ServerMessage,
	ServerMessageDecoder,
	type ServerSnapshot,
	type SessionSummary,
} from "@earendil-works/pi-protocol";
import { PiDisconnectedError, PiError, PiSessionDetachedError, toDisconnectedError, toError } from "./errors.ts";
import { notifyListeners } from "./listeners.ts";
import { PendingRequests } from "./pending-requests.ts";
import { PiSessionClient, type SessionClientOperations } from "./session-client.ts";
import { ClientStateStore } from "./state-store.ts";
import type { ByteTransport, ByteTransportHandlers } from "./transport.ts";
import type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	PiClientOptions,
	Unsubscribe,
} from "./types.ts";

const MAX_UINT32 = 0xffff_ffff;

type Connection =
	| { state: "disconnected" }
	| {
			state: "connecting";
			id: number;
			decoder: ServerMessageDecoder;
			deferred: PromiseWithResolvers<ServerSnapshot>;
			transport?: ByteTransport;
	  }
	| { state: "connected"; id: number; decoder: ServerMessageDecoder; transport: ByteTransport };

export class PiClient {
	readonly #options: PiClientOptions;
	readonly #maxFrameLength: number;
	readonly #stateStore: ClientStateStore;
	readonly #pendingRequests = new PendingRequests();
	readonly #sessionHandles = new Map<string, PiSessionClient>();
	readonly #stateListeners = new Set<(change: ConnectionStateChange) => void>();
	#connection: Connection = { state: "disconnected" };
	#connectionSequence = 0;

	constructor(options: PiClientOptions) {
		this.#options = options;
		this.#maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		if (
			!Number.isSafeInteger(this.#maxFrameLength) ||
			this.#maxFrameLength <= 0 ||
			this.#maxFrameLength > MAX_UINT32
		) {
			throw new TypeError(`PiClient maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
		}
		this.#stateStore = new ClientStateStore(options.onListenerError);
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#stateStore.snapshot;
	}

	get sessions(): readonly SessionSummary[] {
		return this.#stateStore.sessions;
	}

	connect(): Promise<ServerSnapshot> {
		if (this.#connection.state !== "disconnected") {
			return Promise.reject(new PiDisconnectedError(`PiClient is already ${this.#connection.state}`));
		}
		this.#stateStore.reset();
		const id = ++this.#connectionSequence;
		const deferred = Promise.withResolvers<ServerSnapshot>();
		this.#connection = {
			state: "connecting",
			id,
			decoder: new ServerMessageDecoder({ maxFrameLength: this.#maxFrameLength }),
			deferred,
		};
		this.#notifyConnectionState();
		const handlers = {
			onData: (chunk) => this.#handleTransportData(id, chunk),
			onClose: () => {
				if (this.#isCurrentConnection(id)) this.#handleTransportClose();
			},
			onError: (error) => {
				if (this.#isCurrentConnection(id)) this.#handleTransportError(error);
			},
		} satisfies ByteTransportHandlers;
		void this.#openTransport(id, handlers);
		return deferred.promise;
	}

	reconnect(): Promise<ServerSnapshot> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		if (this.#connection.state === "disconnected") return;
		const transport = this.#connection.transport;
		this.#failConnection(new PiDisconnectedError(reason));
		transport?.close();
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		return this.#stateStore.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#stateStore.onEvent(listener);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	getSession(sessionId: string): PiSessionClient {
		let handle = this.#sessionHandles.get(sessionId);
		if (handle) return handle;
		const operations: SessionClientOperations = {
			isAttached: () => this.#stateStore.isSessionAttached(sessionId),
			getSnapshot: () => this.#stateStore.getSessionSnapshot(sessionId),
			subscribe: (listener) => this.#stateStore.subscribeSession(sessionId, listener),
			onEvent: (listener) => this.#stateStore.onSessionEvent(sessionId, listener),
			request: (command) => {
				this.#assertSessionAttached(sessionId);
				return this.request(command);
			},
		};
		handle = new PiSessionClient(sessionId, operations);
		this.#sessionHandles.set(sessionId, handle);
		return handle;
	}

	async listSessions(): Promise<readonly SessionSummary[]> {
		return (await this.request({ command: "list" })).sessions;
	}

	async createSession(options: CreateSessionOptions = {}): Promise<PiSessionClient> {
		const result = await this.request({ command: "create", ...options });
		return this.getSession(result.session.id);
	}

	async attachSession(sessionId: string): Promise<PiSessionClient> {
		const previous = this.#stateStore.forgetSessionSnapshot(sessionId);
		try {
			await this.request({ command: "attach", sessionId });
			return this.getSession(sessionId);
		} catch (error) {
			if (previous) this.#stateStore.restoreSessionSnapshot(previous);
			throw error;
		}
	}

	request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		const connection = this.#connection;
		if (connection.state !== "connected") return Promise.reject(new PiDisconnectedError());
		let frame: Uint8Array;
		const pending = this.#pendingRequests.create(command);
		try {
			frame = encodeClientMessage(
				{ type: "request", id: pending.id, request: command },
				{ maxFrameLength: this.#maxFrameLength },
			);
		} catch (error) {
			this.#pendingRequests.take(pending.id)?.reject(toError(error));
			return pending.promise;
		}
		this.#sendFrame(connection.transport, frame);
		return pending.promise;
	}

	async #openTransport(connectionId: number, handlers: ByteTransportHandlers): Promise<void> {
		let transport: ByteTransport;
		try {
			transport = await this.#options.transportFactory(handlers);
		} catch (error) {
			if (this.#isCurrentConnection(connectionId)) this.#failConnection(toDisconnectedError(error));
			return;
		}
		const connection = this.#connection;
		if (connection.state !== "connecting" || connection.id !== connectionId) {
			transport.close();
			return;
		}
		this.#connection = { ...connection, transport };
		try {
			await transport.send(
				encodeClientMessage(
					{ type: "hello", version: PROTOCOL_VERSION, token: this.#options.token },
					{ maxFrameLength: this.#maxFrameLength },
				),
			);
		} catch (error) {
			if (this.#isCurrentConnection(connectionId)) {
				this.#failConnection(toDisconnectedError(error));
				transport.close();
			}
		}
	}

	#sendFrame(transport: ByteTransport, frame: Uint8Array): void {
		let sending: Promise<void>;
		try {
			sending = transport.send(frame);
		} catch (error) {
			this.#handleTransportError(toError(error));
			return;
		}
		void sending.catch((error: unknown) => {
			const connection = this.#connection;
			if (connection.state !== "disconnected" && connection.transport === transport) {
				this.#handleTransportError(toError(error));
			}
		});
	}

	#handleTransportData(connectionId: number, chunk: Uint8Array): void {
		const connection = this.#connection;
		if (connection.state === "disconnected" || connection.id !== connectionId) return;
		if (connection.state === "connecting" && !connection.transport) {
			this.#protocolFailure(new ProtocolValidationError("Received server data before the client hello was sent"));
			return;
		}
		let messages: ServerMessage[];
		try {
			messages = connection.decoder.push(chunk);
		} catch (error) {
			this.#protocolFailure(toError(error));
			return;
		}
		for (const message of messages) {
			if (this.#connection.state === "disconnected") return;
			this.#handleMessage(message);
		}
	}

	#handleMessage(message: ServerMessage): void {
		const connection = this.#connection;
		if (connection.state === "connecting") {
			if (message.type === "hello_error") {
				this.#failAndClose(new PiError(message.error));
				return;
			}
			if (message.type !== "hello") {
				this.#protocolFailure(new ProtocolValidationError("Expected server hello as first message"));
				return;
			}
			if (!connection.transport) {
				this.#protocolFailure(
					new ProtocolValidationError("Received server hello before the client hello was sent"),
				);
				return;
			}
			this.#connection = {
				state: "connected",
				id: connection.id,
				decoder: connection.decoder,
				transport: connection.transport,
			};
			this.#stateStore.applyServerSnapshot(message.snapshot);
			this.#notifyConnectionState();
			connection.deferred.resolve(message.snapshot);
			return;
		}
		if (connection.state !== "connected") return;
		if (message.type === "hello" || message.type === "hello_error") {
			this.#protocolFailure(new ProtocolValidationError("Unexpected handshake message"));
			return;
		}
		if (message.type === "event") {
			this.#stateStore.applyEvent(message.event);
			return;
		}
		const pending = this.#pendingRequests.take(message.id);
		if (!pending) {
			this.#protocolFailure(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new PiError(message.error));
			return;
		}
		if (message.result.command !== pending.command.command) {
			const error = new ProtocolValidationError(
				`Response command ${message.result.command} does not match ${pending.command.command}`,
			);
			pending.reject(error);
			this.#protocolFailure(error);
			return;
		}
		this.#stateStore.applyResult(message.result);
		pending.resolve(message.result);
	}

	#handleTransportClose(): void {
		const connection = this.#connection;
		if (connection.state === "disconnected") return;
		let error: Error = new PiDisconnectedError("Byte transport closed");
		try {
			connection.decoder.end();
		} catch (decoderError) {
			error = toError(decoderError);
		}
		this.#failConnection(error);
	}

	#handleTransportError(error: Error): void {
		this.#failAndClose(toDisconnectedError(error));
	}

	#protocolFailure(error: Error): void {
		this.#failAndClose(error);
	}

	#failAndClose(error: Error): void {
		const connection = this.#connection;
		const transport = connection.state === "disconnected" ? undefined : connection.transport;
		this.#failConnection(error);
		transport?.close();
	}

	#failConnection(error: Error): void {
		const connection = this.#connection;
		if (connection.state === "disconnected") return;
		this.#connection = { state: "disconnected" };
		this.#stateStore.clearAttachments();
		if (connection.state === "connecting") connection.deferred.reject(error);
		this.#pendingRequests.rejectAll(error);
		this.#notifyConnectionState(error);
	}

	#assertSessionAttached(sessionId: string): void {
		if (this.#connection.state !== "connected") throw new PiDisconnectedError();
		if (!this.#stateStore.isSessionAttached(sessionId)) throw new PiSessionDetachedError(sessionId);
	}

	#isCurrentConnection(connectionId: number): boolean {
		return this.#connection.state !== "disconnected" && this.#connection.id === connectionId;
	}

	#notifyConnectionState(error?: Error): void {
		const state = this.#connection.state;
		notifyListeners(this.#stateListeners, error ? { state, error } : { state }, this.#options.onListenerError);
	}
}
