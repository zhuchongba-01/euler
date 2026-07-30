import {
	type ClientMessage,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerSnapshot,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { type ByteTransportFactory, PiClient, PiDisconnectedError, PiSessionDetachedError } from "../src/index.ts";
import {
	baseServerSnapshot,
	collectRequests,
	connectClient,
	createClient,
	MemoryByteServer,
	sessionSnapshot,
} from "./support.ts";

describe("PiClient", () => {
	test("sends a framed version and bearer token before accepting a fragmented server hello", async () => {
		const server = new MemoryByteServer();
		const received: ClientMessage[] = [];
		server.onMessage((message) => {
			received.push(message);
			if (message.type === "hello") {
				server.send(
					{
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: "connection-1",
						snapshot: baseServerSnapshot,
					},
					3,
				);
			}
		});
		const client = createClient(server);

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(received[0]).toEqual({ type: "hello", version: PROTOCOL_VERSION, token: "bearer-secret" });
		expect(server.sentByClient[0]).toBeInstanceOf(Uint8Array);
		expect(client.connectionState).toBe("connected");
	});

	test("rejects server data delivered before sending the client hello", async () => {
		let closeCount = 0;
		let sendCount = 0;
		const client = new PiClient({
			token: "bearer-secret",
			transportFactory: (handlers) => {
				handlers.onData(
					encodeServerMessage({
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: "connection-1",
						snapshot: baseServerSnapshot,
					}),
				);
				return {
					async send() {
						sendCount++;
					},
					close() {
						closeCount++;
					},
				};
			},
		});

		await expect(client.connect()).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: "Received server data before the client hello was sent",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(sendCount).toBe(0);
		expect(closeCount).toBe(1);
	});

	test("isolates subscriber failures from handshake and transport state", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = createClient(server);
		client.subscribe(() => {
			throw new Error("consumer failure");
		});

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(client.connectionState).toBe("connected");
	});

	test("reports subscriber failures without changing connection state", async () => {
		const server = new MemoryByteServer();
		const listenerErrors: Error[] = [];
		server.onMessage((message) => {
			if (message.type === "hello") {
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: "connection-1",
					snapshot: baseServerSnapshot,
				});
			}
		});
		const client = new PiClient({
			token: "bearer-secret",
			transportFactory: (handlers) => server.connect(handlers),
			onListenerError: (error) => listenerErrors.push(error),
		});
		client.subscribe(() => {
			throw new Error("consumer failure");
		});

		await expect(client.connect()).resolves.toEqual(baseServerSnapshot);
		expect(listenerErrors).toEqual([expect.objectContaining({ message: "consumer failure" })]);
		expect(client.connectionState).toBe("connected");
	});

	test("rejects a typed handshake authentication error", async () => {
		const server = new MemoryByteServer();
		server.onMessage(() => {
			server.send({
				type: "hello_error",
				error: { code: "auth", message: "Invalid token" },
			});
		});
		const client = createClient(server, "wrong");

		await expect(client.connect()).rejects.toMatchObject({
			name: "PiError",
			code: "auth",
			message: "Invalid token",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(server.clientCloseCount).toBe(1);
	});

	test("correlates coalesced out-of-order responses", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const listed = client.listSessions();
		const attached = client.attachSession("session-1");
		expect(requests).toHaveLength(2);

		const attachRequest = requests.find((request) => request.request.command === "attach");
		const listRequest = requests.find((request) => request.request.command === "list");
		if (!attachRequest || !listRequest) throw new Error("Missing requests");
		server.sendTogether([
			{
				type: "response",
				id: attachRequest.id,
				ok: true,
				result: { command: "attach", session: sessionSnapshot("session-1") },
			},
			{
				type: "response",
				id: listRequest.id,
				ok: true,
				result: { command: "list", sessions: [] },
			},
		]);

		await expect(listed).resolves.toEqual([]);
		await expect(attached).resolves.toMatchObject({ id: "session-1", attached: true });
	});

	test("reduces only authoritative snapshots and supports unsubscribe", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const initial = sessionSnapshot("session-1", { revision: 1, phase: "idle" });
		server.send({ type: "event", event: { type: "session_snapshot", snapshot: initial } });
		const handle = client.getSession("session-1");
		const observed: number[] = [];
		const progressTypes: string[] = [];
		const unsubscribe = handle.subscribe((snapshot) => observed.push(snapshot.revision));
		const unsubscribeEvents = handle.onEvent((event) => progressTypes.push(event.type));
		server.send({
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				progress: {
					type: "assistant_delta",
					messageId: "assistant-1",
					contentIndex: 0,
					kind: "text",
					delta: "hi",
				},
			},
		});
		expect(progressTypes).toEqual(["session_progress"]);
		expect(handle.snapshot).toEqual(initial);

		const prompting = handle.prompt("hello");
		expect(handle.snapshot).toEqual(initial);
		const promptRequest = requests.find((request) => request.request.command === "prompt");
		if (!promptRequest) throw new Error("Missing prompt request");
		const updated = sessionSnapshot("session-1", { revision: 2, phase: "turn" });
		server.send({
			type: "response",
			id: promptRequest.id,
			ok: true,
			result: { command: "prompt", session: updated },
		});
		await expect(prompting).resolves.toEqual(updated);
		expect(handle.snapshot).toEqual(updated);
		expect(observed).toEqual([2]);

		unsubscribe();
		unsubscribeEvents();
		server.send({
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 3 }) },
		});
		expect(observed).toEqual([2]);
	});

	test("keeps multiple session handles independent and enforces detach", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request") return;
			const request = message.request;
			if (request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "attach", session: sessionSnapshot(request.sessionId) },
				});
			}
			if (request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: request.sessionId },
				});
			}
		});

		const first = await client.attachSession("session-1");
		const second = await client.attachSession("session-2");
		expect(first.attached).toBe(true);
		expect(second.attached).toBe(true);
		await first.detach();
		expect(first.attached).toBe(false);
		expect(second.attached).toBe(true);
		await expect(first.abort()).rejects.toBeInstanceOf(PiSessionDetachedError);
	});

	test("rejects pending requests on close and reconnects through a fresh factory result", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		for (const server of [first, second]) {
			server.onMessage((message) => {
				if (message.type === "hello") {
					server.send({
						type: "hello",
						version: PROTOCOL_VERSION,
						connectionId: `connection-${connection}`,
						snapshot: { ...baseServerSnapshot, revision: connection },
					});
				}
			});
		}
		const transportFactory: ByteTransportFactory = (handlers) =>
			(connection++ === 0 ? first : second).connect(handlers);
		const client = new PiClient({ token: "bearer-secret", transportFactory });
		const states: string[] = [];
		client.onConnectionStateChange(({ state }) => states.push(state));
		await client.connect();
		const pending = client.listSessions();
		first.close();
		await expect(pending).rejects.toBeInstanceOf(PiDisconnectedError);
		expect(client.connectionState).toBe("disconnected");

		await expect(client.reconnect()).resolves.toMatchObject({ revision: 2 });
		expect(client.connectionState).toBe("connected");
		expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
	});

	test("supports synchronous reconnect from a disconnection listener", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		for (const server of [first, second]) {
			server.onMessage((message) => {
				if (message.type !== "hello") return;
				server.send({
					type: "hello",
					version: PROTOCOL_VERSION,
					connectionId: `connection-${connection}`,
					snapshot: { ...baseServerSnapshot, revision: connection },
				});
			});
		}
		const client = new PiClient({
			token: "bearer-secret",
			transportFactory: (handlers) => (connection++ === 0 ? first : second).connect(handlers),
		});
		await client.connect();
		let reconnect: Promise<ServerSnapshot> | undefined;
		client.onConnectionStateChange(({ state }) => {
			if (state === "disconnected") reconnect = client.reconnect();
		});

		first.close();
		expect(reconnect).toBeDefined();
		await expect(reconnect).resolves.toMatchObject({ revision: 2 });
		expect(client.connectionState).toBe("connected");
	});

	test("rejects pending requests on transport errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.listSessions();
		server.error(new Error("read failed"));

		await expect(pending).rejects.toMatchObject({ name: "PiDisconnectedError", message: "read failed" });
		expect(client.connectionState).toBe("disconnected");
	});
});
