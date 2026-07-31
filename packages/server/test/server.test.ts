import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClientMessage,
	encodeClientMessage,
	type ModelMetadata,
	type ModelRef,
	PROTOCOL_VERSION,
	type ServerMessage,
	ServerMessageDecoder,
	type SessionPhase,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
	type TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CreateSessionOptions,
	type PiServer,
	PiServerError,
	type PiSessionBackend,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
} from "../src/index.ts";
import { createUnixServer, type UnixServerOptions } from "../src/transports/unix/index.ts";

const TOKEN = "correct horse battery staple";
const MODEL: ModelMetadata = {
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

class Deferred<T> {
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

class MemoryRuntime implements PiSessionRuntime {
	readonly disposed = new Deferred<void>();
	disposeCount = 0;
	steers: PromptInput[] = [];
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private readonly stored: StoredSession;
	private readonly onDispose: () => void;
	private pendingPrompt?: { input: PromptInput; done: Deferred<"complete" | "aborted"> };

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
		if (this.getPhase() !== "idle") {
			throw new PiServerError("busy", "A prompt is already running");
		}
		const done = new Deferred<"complete" | "aborted">();
		this.pendingPrompt = { input, done };
		this.update({
			phase: "turn",
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
		const outcome = await done.promise;
		const assistantId = `assistant-${this.stored.snapshot.revision + 1}`;
		this.update({
			phase: "idle",
			transcript: [
				...this.stored.snapshot.transcript,
				{
					id: assistantId,
					role: "assistant",
					content: [{ type: "text", text: outcome === "complete" ? `reply:${input.text}` : "" }],
					status: outcome === "complete" ? "complete" : "aborted",
					model: this.stored.snapshot.model,
					stopReason: outcome === "complete" ? "stop" : "aborted",
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
		this.pendingPrompt = undefined;
	}

	async steer(input: PromptInput): Promise<void> {
		if (this.getPhase() === "idle") {
			throw new PiServerError("busy", "There is no active prompt to steer");
		}
		this.steers.push(input);
		this.update({
			queuedSteerCount: this.stored.snapshot.queuedSteerCount + 1,
			queuedSteer: [
				...this.stored.snapshot.queuedSteer,
				{
					id: `steer-${this.stored.snapshot.revision + 1}`,
					role: "user",
					content: [{ type: "text", text: input.text }],
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
	}

	async abort(): Promise<void> {
		if (!this.pendingPrompt) {
			throw new PiServerError("busy", "There is no active prompt to abort");
		}
		this.pendingPrompt.done.resolve("aborted");
	}

	async setModel(model: ModelRef): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({ model });
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({ thinkingLevel });
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.disposeCount += 1;
		this.onDispose();
		this.disposed.resolve();
	}

	finishPrompt(): void {
		if (!this.pendingPrompt) throw new Error("No prompt is pending");
		this.pendingPrompt.done.resolve("complete");
	}

	emitProgress(progress: TranscriptProgress): void {
		for (const listener of this.listeners) listener({ type: "progress", progress });
	}

	emitSnapshot(): void {
		for (const listener of this.listeners) listener({ type: "snapshot" });
	}

	private update(updates: Partial<SessionSnapshot>): void {
		this.stored.snapshot = {
			...this.stored.snapshot,
			...updates,
			revision: this.stored.snapshot.revision + 1,
			updatedAt: this.stored.snapshot.updatedAt + 1,
		};
		this.emitSnapshot();
	}
}

class MemoryBackend implements PiSessionBackend {
	readonly sessions = new Map<string, StoredSession>();
	readonly runtimes = new Map<string, MemoryRuntime[]>();
	readonly locked = new Set<string>();
	lastCreatedId?: string;

	async listSessions(): Promise<SessionSummary[]> {
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
		return [MODEL];
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		this.lastCreatedId = options.id;
		if (this.sessions.has(options.id)) throw new PiServerError("session_locked", "Session id already exists");
		const stored: StoredSession = {
			snapshot: {
				id: options.id,
				name: options.name,
				queuedSteer: [],
				cwd: options.cwd ?? "/tmp/pi-server-test",
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model: options.model ?? { provider: MODEL.provider, id: MODEL.id },
				thinkingLevel: options.thinkingLevel ?? "off",
				attached: false,
				locked: true,
				revision: 0,
				transcript: [],
				queuedSteerCount: 0,
			},
		};
		this.sessions.set(options.id, stored);
		return this.acquire(options.id, stored);
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const stored = this.sessions.get(sessionId);
		if (!stored) throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
		if (this.locked.has(sessionId)) throw new PiServerError("session_locked", `Session is locked: ${sessionId}`);
		return this.acquire(sessionId, stored);
	}

	seed(id = "session-1"): StoredSession {
		const stored: StoredSession = {
			snapshot: {
				id,
				name: "Seed session",
				queuedSteer: [],
				cwd: "/tmp/pi-server-test",
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model: { provider: MODEL.provider, id: MODEL.id },
				thinkingLevel: "off",
				attached: false,
				locked: false,
				revision: 0,
				transcript: [],
				queuedSteerCount: 0,
			},
		};
		this.sessions.set(id, stored);
		return stored;
	}

	latestRuntime(id: string): MemoryRuntime {
		const runtimes = this.runtimes.get(id);
		if (!runtimes?.length) throw new Error(`No runtime for ${id}`);
		return runtimes.at(-1)!;
	}

	private acquire(id: string, stored: StoredSession): MemoryRuntime {
		this.locked.add(id);
		const runtime = new MemoryRuntime(stored, () => this.locked.delete(id));
		const runtimes = this.runtimes.get(id) ?? [];
		runtimes.push(runtime);
		this.runtimes.set(id, runtimes);
		return runtime;
	}
}

class OrderedSnapshotBackend extends MemoryBackend {
	readonly firstStarted = new Deferred<void>();
	readonly secondStarted = new Deferred<void>();
	readonly firstRelease = new Deferred<void>();
	readonly secondRelease = new Deferred<void>();
	controlled = false;
	startedCount = 0;

	override async listModels(): Promise<ModelMetadata[]> {
		if (!this.controlled) return super.listModels();
		this.startedCount += 1;
		if (this.startedCount === 1) {
			this.firstStarted.resolve(undefined);
			await this.firstRelease.promise;
		} else if (this.startedCount === 2) {
			this.secondStarted.resolve(undefined);
			await this.secondRelease.promise;
		}
		return [MODEL];
	}
}

class Client {
	readonly messages: ServerMessage[] = [];
	private readonly waiters = new Set<{
		predicate: (message: ServerMessage) => boolean;
		resolve: (message: ServerMessage) => void;
	}>();
	private requestNumber = 0;
	private readonly decoder = new ServerMessageDecoder();
	readonly socket: Socket;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk) => {
			for (const message of this.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		});
	}

	static async connect(path: string): Promise<Client> {
		const socket = createConnection(path);
		const client = new Client(socket);
		await once(socket, "connect");
		return client;
	}

	async hello(token = TOKEN, version: number = PROTOCOL_VERSION): Promise<ServerMessage> {
		this.send({ type: "hello", token, version });
		return this.next((message) => message.type === "hello" || message.type === "hello_error");
	}

	async request(request: Record<string, unknown>): Promise<Extract<ServerMessage, { type: "response" }>> {
		const id = `request-${++this.requestNumber}`;
		this.send({ type: "request", id, request } as ClientMessage);
		return (await this.next((message) => message.type === "response" && message.id === id)) as Extract<
			ServerMessage,
			{ type: "response" }
		>;
	}

	next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		return this.nextFrom(0, predicate);
	}

	nextFrom(index: number, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.slice(index).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => this.waiters.add({ predicate, resolve }));
	}

	async close(): Promise<void> {
		if (this.socket.destroyed) return;
		const closed = once(this.socket, "close");
		this.socket.destroy();
		await closed;
	}
	private send(message: ClientMessage): void {
		this.socket.write(encodeClientMessage(message));
	}
}

const servers = new Set<PiServer>();
const clients = new Set<Client>();
const tempDirectories = new Set<string>();

async function startServer(backend = new MemoryBackend(), options: Partial<UnixServerOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-server-test-"));
	tempDirectories.add(directory);
	const server = createUnixServer(backend, {
		token: TOKEN,
		path: join(directory, "server.sock"),
		...options,
	});
	servers.add(server);
	await server.start();
	return { server, backend };
}

async function connect(server: PiServer): Promise<Client> {
	const client = await Client.connect(server.addresses[0]!);
	clients.add(client);
	return client;
}

async function attach(client: Client, sessionId: string): Promise<SessionSnapshot> {
	const response = await client.request({ command: "attach", sessionId });
	if (!response.ok || response.result.command !== "attach") throw new Error("Attach failed");
	return response.result.session;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("PiServer Unix integration", () => {
	test("requires a valid first-message auth/version handshake", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);

		const badToken = await connect(server);
		const authError = await badToken.hello("wrong");
		expect(authError).toMatchObject({ type: "hello_error", error: { code: "auth" } });
		await once(badToken.socket, "close");

		const badVersion = await connect(server);
		const versionError = await badVersion.hello(TOKEN, PROTOCOL_VERSION + 1);
		expect(versionError).toMatchObject({ type: "hello_error", error: { code: "version" } });

		const client = await connect(server);
		const hello = await client.hello();
		expect(hello).toMatchObject({
			type: "hello",
			version: PROTOCOL_VERSION,
			snapshot: { sessions: [{ id: "session-1" }], models: [MODEL] },
		});
	});

	test("times out clients that do not send a hello", async () => {
		const { server } = await startServer(new MemoryBackend(), { handshakeTimeoutMs: 10 });
		const client = await connect(server);
		await once(client.socket, "close");
		expect(client.socket.destroyed).toBe(true);
	});

	test("serializes server snapshot revisions", async () => {
		const backend = new OrderedSnapshotBackend();
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		backend.controlled = true;
		const messageIndex = client.messages.length;

		const firstCreate = client.request({ command: "create", name: "first" });
		await backend.firstStarted.promise;
		const secondCreate = client.request({ command: "create", name: "second" });
		await Promise.resolve();
		expect(backend.startedCount).toBe(1);

		backend.firstRelease.resolve(undefined);
		await backend.secondStarted.promise;
		backend.secondRelease.resolve(undefined);
		await Promise.all([firstCreate, secondCreate]);
		await client.nextFrom(
			messageIndex,
			(message) =>
				message.type === "event" &&
				message.event.type === "server_snapshot" &&
				message.event.snapshot.revision === 2,
		);

		const revisions = client.messages
			.slice(messageIndex)
			.flatMap((message) =>
				message.type === "event" && message.event.type === "server_snapshot"
					? [message.event.snapshot.revision]
					: [],
			);
		expect(revisions).toEqual([1, 2]);
	});

	test("creates server-assigned durable IDs and supports list, attach, and detach", async () => {
		const { server, backend } = await startServer();
		const client = await connect(server);
		await client.hello();
		const created = await client.request({ command: "create", cwd: "/work", name: "Created" });
		expect(created.ok).toBe(true);
		if (!created.ok || created.result.command !== "create") throw new Error("Create failed");
		expect(created.result.session).toMatchObject({
			id: backend.lastCreatedId,
			cwd: "/work",
			name: "Created",
			attached: true,
			locked: true,
		});

		const listed = await client.request({ command: "list" });
		expect(listed).toMatchObject({
			ok: true,
			result: { command: "list", sessions: [{ id: backend.lastCreatedId, attached: true, locked: true }] },
		});
		const detached = await client.request({ command: "detach", sessionId: backend.lastCreatedId });
		expect(detached).toMatchObject({ ok: true, result: { command: "detach", sessionId: backend.lastCreatedId } });
		expect(backend.latestRuntime(backend.lastCreatedId!).disposeCount).toBe(1);

		const attached = await attach(client, backend.lastCreatedId!);
		expect(attached.id).toBe(backend.lastCreatedId);
		expect(backend.runtimes.get(backend.lastCreatedId!)?.length).toBe(2);
	});

	test("keeps multiple attachments on one connection independent", async () => {
		const backend = new MemoryBackend();
		backend.seed("first");
		backend.seed("second");
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		await attach(client, "first");
		await attach(client, "second");

		await client.request({ command: "detach", sessionId: "first" });
		expect(backend.latestRuntime("first").disposeCount).toBe(1);
		expect(backend.latestRuntime("second").disposeCount).toBe(0);
		const response = await client.request({
			command: "set_thinking",
			sessionId: "second",
			thinkingLevel: "medium",
		});
		expect(response).toMatchObject({ ok: true, result: { session: { id: "second", thinkingLevel: "medium" } } });
	});

	test("broadcasts full snapshots and progress only to clients attached to that session", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);
		const attachedClient = await connect(server);
		const unattachedClient = await connect(server);
		await attachedClient.hello();
		await unattachedClient.hello();
		await attach(attachedClient, "session-1");
		const runtime = backend.latestRuntime("session-1");
		const progress: TranscriptProgress = {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "hello",
		};
		runtime.emitProgress(progress);
		const progressMessage = await attachedClient.next(
			(message) => message.type === "event" && message.event.type === "session_progress",
		);
		expect(progressMessage).toEqual({
			type: "event",
			event: { type: "session_progress", sessionId: "session-1", progress },
		});
		expect(
			unattachedClient.messages.some(
				(message) => message.type === "event" && message.event.type === "session_progress",
			),
		).toBe(false);

		const messageCount = attachedClient.messages.length;
		runtime.emitSnapshot();
		const snapshotMessage = await attachedClient.nextFrom(
			messageCount,
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.revision === runtime.snapshot().revision,
		);
		expect(snapshotMessage).toMatchObject({
			type: "event",
			event: { type: "session_snapshot", snapshot: { id: "session-1", attached: true, locked: true } },
		});
		expect(
			unattachedClient.messages.some(
				(message) => message.type === "event" && message.event.type === "session_snapshot",
			),
		).toBe(false);
	});

	test("allows every attached client to control a singleton live runtime", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);
		const first = await connect(server);
		const second = await connect(server);
		await first.hello();
		await second.hello();
		await attach(first, "session-1");
		const secondList = await second.request({ command: "list" });
		expect(secondList).toMatchObject({
			ok: true,
			result: { sessions: [{ id: "session-1", attached: false, locked: true }] },
		});
		await attach(second, "session-1");
		expect(backend.runtimes.get("session-1")?.length).toBe(1);

		const modelResponse = await second.request({
			command: "set_model",
			sessionId: "session-1",
			model: { provider: "test", id: "large" },
		});
		expect(modelResponse).toMatchObject({ ok: true, result: { session: { model: { id: "large" } } } });
		await first.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.model.id === "large",
		);
		const thinkingResponse = await first.request({
			command: "set_thinking",
			sessionId: "session-1",
			thinkingLevel: "high",
		});
		expect(thinkingResponse).toMatchObject({ ok: true, result: { session: { thinkingLevel: "high" } } });
	});

	test("does not queue prompts and processes steer and abort while a prompt response is pending", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");

		const prompt = client.request({ command: "prompt", sessionId: "session-1", text: "first" });
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const busy = await client.request({ command: "prompt", sessionId: "session-1", text: "second" });
		expect(busy).toMatchObject({ ok: false, error: { code: "busy" } });

		const steer = await client.request({ command: "steer", sessionId: "session-1", text: "adjust" });
		expect(steer).toMatchObject({ ok: true, result: { command: "steer" } });
		expect(backend.latestRuntime("session-1").steers).toEqual([{ text: "adjust" }]);
		const abort = await client.request({ command: "abort", sessionId: "session-1" });
		expect(abort).toMatchObject({ ok: true, result: { command: "abort" } });
		expect(await prompt).toMatchObject({ ok: true, result: { command: "prompt", session: { phase: "idle" } } });
	});

	test("returns operation attachment state relative to the requesting connection", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);
		const first = await connect(server);
		const second = await connect(server);
		await first.hello();
		await second.hello();
		await attach(first, "session-1");
		await attach(second, "session-1");

		const prompt = first.request({ command: "prompt", sessionId: "session-1", text: "hello" });
		await first.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		await first.request({ command: "detach", sessionId: "session-1" });
		backend.latestRuntime("session-1").finishPrompt();

		expect(await prompt).toMatchObject({
			ok: true,
			result: { command: "prompt", session: { id: "session-1", attached: false } },
		});
	});

	test("keeps busy work alive after disconnect and disposes when it next becomes idle", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");
		void client.request({ command: "prompt", sessionId: "session-1", text: "survive" });
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const runtime = backend.latestRuntime("session-1");
		await client.close();
		expect(runtime.disposeCount).toBe(0);
		runtime.finishPrompt();
		await runtime.disposed.promise;
		expect(runtime.disposeCount).toBe(1);

		const reconnect = await connect(server);
		await reconnect.hello();
		const snapshot = await attach(reconnect, "session-1");
		expect(snapshot.transcript).toHaveLength(2);
		expect(snapshot.transcript[1]).toMatchObject({ role: "assistant", content: [{ text: "reply:survive" }] });
	});

	test("restores persisted sessions lazily after a server restart", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server: firstServer } = await startServer(backend);
		const firstClient = await connect(firstServer);
		await firstClient.hello();
		await attach(firstClient, "session-1");
		await firstClient.request({ command: "set_thinking", sessionId: "session-1", thinkingLevel: "high" });
		await firstClient.close();
		await firstServer.close();

		const { server: secondServer } = await startServer(backend);
		expect(backend.runtimes.get("session-1")).toHaveLength(1);
		const secondClient = await connect(secondServer);
		await secondClient.hello();
		const restored = await attach(secondClient, "session-1");
		expect(restored.thinkingLevel).toBe("high");
		expect(backend.runtimes.get("session-1")).toHaveLength(2);
	});

	test("rejects and disposes a backend runtime with the wrong server-assigned ID", async () => {
		class WrongIdBackend extends MemoryBackend {
			override async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
				return super.createSession({ ...options, id: "wrong-id" });
			}
		}
		const backend = new WrongIdBackend();
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		const response = await client.request({ command: "create" });
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(backend.latestRuntime("wrong-id").disposeCount).toBe(1);
	});

	test("maps backend lock errors and rejects control from unattached clients", async () => {
		const backend = new MemoryBackend();
		backend.seed("locked");
		backend.locked.add("locked");
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		const locked = await client.request({ command: "attach", sessionId: "locked" });
		expect(locked).toMatchObject({ ok: false, error: { code: "session_locked" } });
		const unattached = await client.request({ command: "abort", sessionId: "locked" });
		expect(unattached).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	test("gracefully closes clients and releases all live runtimes", async () => {
		const backend = new MemoryBackend();
		backend.seed();
		const { server } = await startServer(backend);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");
		const runtime = backend.latestRuntime("session-1");
		const clientClosed = once(client.socket, "close");
		await server.close();
		await clientClosed;
		expect(runtime.disposeCount).toBe(1);
		expect(server.addresses).toEqual([]);
		await server.close();
	});
});
