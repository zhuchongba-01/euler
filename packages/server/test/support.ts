import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
	type ClientMessage,
	type Command,
	encodeClientMessage,
	type ModelMetadata,
	type ModelRef,
	PROTOCOL_VERSION,
	type ResponseEnvelope,
	type ServerMessage,
	ServerMessageDecoder,
	type SessionPhase,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
	type TranscriptProgress,
} from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServerError,
	type PiSessionBackend,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
} from "../src/index.ts";

export const TEST_TOKEN = "server-conformance-token";
export const TEST_MODEL: ModelMetadata = {
	provider: "test",
	id: "small",
	name: "Test Small",
	api: "test-api",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 16_000,
	maxTokens: 2_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	supportedThinkingLevels: ["off", "medium", "high"],
	authenticated: true,
};

export class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

interface StoredSession {
	snapshot: SessionSnapshot;
}

export class ConformanceRuntime implements PiSessionRuntime {
	readonly disposed = new Deferred<void>();
	disposeCount = 0;
	private readonly stored: StoredSession;
	private readonly onDispose: () => void;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();

	constructor(stored: StoredSession, onDispose: () => void) {
		this.stored = stored;
		this.onDispose = onDispose;
	}

	snapshot(): SessionSnapshot {
		return structuredClone(this.stored.snapshot);
	}

	getPhase(): SessionPhase {
		return this.stored.snapshot.phase;
	}

	async prompt(input: PromptInput): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({
			transcript: [
				...this.stored.snapshot.transcript,
				{
					id: `user-${this.stored.snapshot.revision + 1}`,
					role: "user",
					content: [{ type: "text", text: input.text }],
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
	}

	async steer(): Promise<void> {
		throw new PiServerError("busy", "There is no active prompt to steer");
	}

	async abort(): Promise<void> {
		throw new PiServerError("busy", "There is no active prompt to abort");
	}

	async setModel(model: ModelRef): Promise<void> {
		this.update({ model });
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		this.update({ thinkingLevel });
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.disposeCount += 1;
		this.onDispose();
		this.disposed.resolve(undefined);
	}

	setPhase(phase: SessionPhase): void {
		this.stored.snapshot = { ...this.stored.snapshot, phase };
	}

	emitProgress(progress: TranscriptProgress): void {
		for (const listener of this.listeners) listener({ type: "progress", progress });
	}

	emitError(error: PiServerError): void {
		for (const listener of this.listeners) listener({ type: "error", error });
	}

	private update(updates: Partial<SessionSnapshot>): void {
		this.stored.snapshot = {
			...this.stored.snapshot,
			...updates,
			revision: this.stored.snapshot.revision + 1,
			updatedAt: this.stored.snapshot.updatedAt + 1,
		};
		for (const listener of this.listeners) listener({ type: "snapshot" });
	}
}

interface ListDelay {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class ConformanceBackend implements PiSessionBackend {
	readonly sessions = new Map<string, StoredSession>();
	readonly runtimes = new Map<string, ConformanceRuntime[]>();
	readonly locked = new Set<string>();
	private nextListDelay?: ListDelay;

	async listSessions(): Promise<SessionSummary[]> {
		const delay = this.nextListDelay;
		if (delay) {
			this.nextListDelay = undefined;
			delay.entered.resolve(undefined);
			await delay.release.promise;
		}
		return [...this.sessions.values()].map(({ snapshot }) => ({
			id: snapshot.id,
			name: snapshot.name,
			cwd: snapshot.cwd,
			createdAt: snapshot.createdAt,
			updatedAt: snapshot.updatedAt,
			phase: snapshot.phase,
			model: snapshot.model,
			thinkingLevel: snapshot.thinkingLevel,
			attached: false,
			locked: this.locked.has(snapshot.id),
		}));
	}

	async listModels(): Promise<ModelMetadata[]> {
		return [TEST_MODEL];
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		if (this.sessions.has(options.id)) throw new PiServerError("session_locked", "Session already exists");
		this.seed(options.id, options.name, options.cwd, options.model, options.thinkingLevel);
		return this.acquire(options.id);
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		if (!this.sessions.has(sessionId)) throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
		if (this.locked.has(sessionId)) throw new PiServerError("session_locked", `Session is locked: ${sessionId}`);
		return this.acquire(sessionId);
	}

	seed(
		id: string,
		name = `Session ${id}`,
		cwd = "/tmp/pi-server-conformance",
		model: ModelRef = { provider: TEST_MODEL.provider, id: TEST_MODEL.id },
		thinkingLevel: ThinkingLevel = "off",
	): void {
		this.sessions.set(id, {
			snapshot: {
				id,
				name,
				cwd,
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model,
				thinkingLevel,
				attached: false,
				locked: false,
				revision: 0,
				transcript: [],
				queuedSteer: [],
				queuedSteerCount: 0,
			},
		});
	}

	delayNextList(): ListDelay {
		const delay = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextListDelay = delay;
		return delay;
	}

	latestRuntime(id: string): ConformanceRuntime {
		const runtimes = this.runtimes.get(id);
		if (!runtimes?.length) throw new Error(`No runtime for ${id}`);
		return runtimes.at(-1)!;
	}

	private acquire(id: string): ConformanceRuntime {
		const stored = this.sessions.get(id);
		if (!stored) throw new Error(`Unknown session: ${id}`);
		this.locked.add(id);
		const runtime = new ConformanceRuntime(stored, () => this.locked.delete(id));
		const runtimes = this.runtimes.get(id) ?? [];
		runtimes.push(runtime);
		this.runtimes.set(id, runtimes);
		return runtime;
	}
}

interface MessageWaiter {
	predicate: (message: ServerMessage) => boolean;
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
}

interface WireChannel {
	send(chunk: Uint8Array): Promise<void>;
	sendFragmented(chunk: Uint8Array, splitAt: number): Promise<void>;
	close(): Promise<void>;
}

export class WireClient {
	readonly messages: ServerMessage[] = [];
	private readonly channel: WireChannel;
	private readonly decoder = new ServerMessageDecoder();
	private readonly waiters = new Set<MessageWaiter>();
	private readonly closedDeferred = new Deferred<void>();
	private requestSequence = 0;
	private closedValue = false;

	constructor(channel: WireChannel) {
		this.channel = channel;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	hello(token = TEST_TOKEN, version: number = PROTOCOL_VERSION): Promise<ServerMessage> {
		const response = this.next((message) => message.type === "hello" || message.type === "hello_error");
		void this.sendMessage({ type: "hello", token, version });
		return response;
	}

	async request(command: Command, id = `request-${++this.requestSequence}`): Promise<ResponseEnvelope> {
		const response = this.next(
			(message): message is ResponseEnvelope => message.type === "response" && message.id === id,
		);
		await this.sendMessage({ type: "request", id, request: command });
		return (await response) as ResponseEnvelope;
	}

	sendMessage(message: ClientMessage): Promise<void> {
		return this.channel.send(encodeClientMessage(message));
	}

	sendBytes(chunk: Uint8Array): Promise<void> {
		return this.channel.send(chunk);
	}

	sendFragmentedMessage(message: ClientMessage, splitAt: number): Promise<void> {
		return this.channel.sendFragmented(encodeClientMessage(message), splitAt);
	}

	next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.closedValue) return Promise.reject(new Error("Wire client is closed"));
		return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
	}

	waitForClose(): Promise<void> {
		return this.closedValue ? Promise.resolve() : this.closedDeferred.promise;
	}

	close(): Promise<void> {
		return this.channel.close();
	}

	receive(chunk: Uint8Array): void {
		try {
			for (const message of this.decoder.push(chunk)) {
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closedDeferred.resolve(undefined);
		this.fail(new Error("Wire connection closed"));
	}

	fail(error: Error): void {
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
	}
}

export async function connectUnix(path: string): Promise<WireClient> {
	const socket = createConnection(path);
	await once(socket, "connect");
	const client = new WireClient({
		send: (chunk) => writeSocket(socket, chunk),
		async sendFragmented(chunk, splitAt) {
			await writeSocket(socket, chunk.subarray(0, splitAt));
			await writeSocket(socket, chunk.subarray(splitAt));
		},
		async close() {
			if (socket.destroyed) return;
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		},
	});
	socket.on("data", (chunk) => {
		client.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	});
	socket.on("error", (error) => client.fail(error));
	socket.once("close", () => client.markClosed());
	return client;
}

function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		socket.write(chunk, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
