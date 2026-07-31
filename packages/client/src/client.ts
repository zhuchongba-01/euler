import {
	type Command,
	type CommandResult,
	type EventEnvelope,
	encodeClientMessage,
	type ModelRef,
	ProtocolValidationError,
	type ResponseEnvelope,
	type ResultForCommand,
	type ServerEvent,
	type ServerSnapshot,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { PiDisconnectedError, PiServerError, PiSessionDetachedError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import { ClientState } from "./state.ts";
import type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	PiClientOptions,
	Unsubscribe,
} from "./types.ts";

type SessionCommand = Extract<Command, { sessionId: string }>;

export interface PiSessionHandle {
	readonly id: string;
	readonly attached: boolean;
	readonly snapshot: SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	prompt(text: string): Promise<SessionSnapshot>;
	steer(text: string): Promise<SessionSnapshot>;
	abort(): Promise<SessionSnapshot>;
	setModel(model: ModelRef): Promise<SessionSnapshot>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot>;
}

interface SessionHandleCallbacks {
	isAttached(): boolean;
	getSnapshot(): SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
}

class SessionHandle implements PiSessionHandle {
	readonly id: string;
	readonly #callbacks: SessionHandleCallbacks;

	constructor(id: string, callbacks: SessionHandleCallbacks) {
		this.id = id;
		this.#callbacks = callbacks;
	}

	get attached(): boolean {
		return this.#callbacks.isAttached();
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.#callbacks.getSnapshot();
	}

	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.#callbacks.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#callbacks.onEvent(listener);
	}

	async detach(): Promise<void> {
		await this.#request({ command: "detach", sessionId: this.id });
	}

	async prompt(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "prompt", sessionId: this.id, text })).session;
	}

	async steer(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "steer", sessionId: this.id, text })).session;
	}

	async abort(): Promise<SessionSnapshot> {
		return (await this.#request({ command: "abort", sessionId: this.id })).session;
	}

	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_model", sessionId: this.id, model })).session;
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_thinking", sessionId: this.id, thinkingLevel })).session;
	}

	#request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		return this.#callbacks.request(command);
	}
}

interface PendingRequest {
	command: Command;
	resolve(result: CommandResult): void;
	reject(error: Error): void;
}

export class PiClient {
	readonly #options: PiClientOptions;
	readonly #connection: Connection;
	readonly #state: ClientState;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #sessions = new Map<string, PiSessionHandle>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	#requestSequence = 0;

	constructor(options: PiClientOptions) {
		this.#options = options;
		this.#state = new ClientState(options.onListenerError);
		this.#connection = new Connection({
			token: options.token,
			transportFactory: options.transportFactory,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (snapshot) => this.#state.applyServerSnapshot(snapshot),
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#state.snapshot;
	}

	connect(): Promise<ServerSnapshot> {
		if (this.#connection.state === "disconnected") this.#state.reset();
		return this.#connection.connect();
	}

	reconnect(): Promise<ServerSnapshot> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		return this.#state.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#state.onEvent(listener);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	async listSessions(): Promise<readonly SessionSummary[]> {
		return (await this.#request({ command: "list" })).sessions;
	}

	async createSession(options: CreateSessionOptions = {}): Promise<PiSessionHandle> {
		const result = await this.#request({ command: "create", ...options });
		return this.#getOrCreateSessionHandle(result.session.id);
	}

	async attachSession(sessionId: string): Promise<PiSessionHandle> {
		const previous = this.#state.forgetSessionSnapshot(sessionId);
		try {
			await this.#request({ command: "attach", sessionId });
			return this.#getOrCreateSessionHandle(sessionId);
		} catch (error) {
			if (previous) this.#state.restoreSessionSnapshot(previous);
			throw error;
		}
	}

	#request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<CommandResult>();
		this.#pendingRequests.set(id, { command, resolve, reject });
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, request: command },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise as Promise<ResultForCommand<TCommand>>;
		}
		this.#connection.send(frame);
		return promise as Promise<ResultForCommand<TCommand>>;
	}

	#getOrCreateSessionHandle(sessionId: string): PiSessionHandle {
		let handle = this.#sessions.get(sessionId);
		if (handle) return handle;
		const callbacks: SessionHandleCallbacks = {
			isAttached: () => this.#state.isSessionAttached(sessionId),
			getSnapshot: () => this.#state.getSessionSnapshot(sessionId),
			subscribe: (listener) => this.#state.subscribeSession(sessionId, listener),
			onEvent: (listener) => this.#state.onSessionEvent(sessionId, listener),
			request: (command) => {
				this.#assertSessionAttached(sessionId);
				return this.#request(command);
			},
		};
		handle = new SessionHandle(sessionId, callbacks);
		this.#sessions.set(sessionId, handle);
		return handle;
	}

	#handleMessage(message: ResponseEnvelope | EventEnvelope): void {
		if (message.type === "event") {
			this.#state.applyEvent(message.event);
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new PiServerError(message.error));
			return;
		}
		if (message.result.command !== pending.command.command) {
			const error = new ProtocolValidationError(
				`Response command ${message.result.command} does not match ${pending.command.command}`,
			);
			pending.reject(error);
			this.#connection.fail(error);
			return;
		}
		this.#state.applyResult(message.result);
		pending.resolve(message.result);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#state.clearAttachments();
			this.#rejectPendingRequests(change.error ?? new PiDisconnectedError());
		}
		this.#notifyConnectionStateListeners(change);
	}

	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) this.#pendingRequests.delete(id);
		return request;
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) request.reject(error);
	}

	#assertSessionAttached(sessionId: string): void {
		if (!this.connected) throw new PiDisconnectedError();
		if (!this.#state.isSessionAttached(sessionId)) throw new PiSessionDetachedError(sessionId);
	}

	#notifyConnectionStateListeners(change: ConnectionStateChange): void {
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect protocol or transport state.
		}
	}
}
