import { encodeCbor, encodeFrame, PROTOCOL_VERSION, ProtocolValidationError } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { PiClient } from "../src/index.ts";
import { baseServerSnapshot, collectRequests, connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

describe("PiClient", () => {
	test("enforces the configured frame limit for outbound and inbound messages", async () => {
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
		const client = new PiClient({
			token: "bearer-secret",
			maxFrameLength: 512,
			transportFactory: (handlers) => server.connect(handlers),
		});
		await client.connect();
		const sentBefore = server.sentByClient.length;
		await expect(
			client.request({ command: "prompt", sessionId: "session-1", text: "x".repeat(1_000) }),
		).rejects.toBeInstanceOf(ProtocolValidationError);
		expect(server.sentByClient).toHaveLength(sentBefore);

		server.sendRaw(new Uint8Array([0, 0, 2, 1]));
		expect(client.connectionState).toBe("disconnected");
	});

	test("disconnects on invalid protocol data", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.sendRaw(encodeFrame(encodeCbor({ type: "event", event: { type: "session_removed", sessionId: 1 } })));
		expect(client.connectionState).toBe("disconnected");
	});

	test("reports truncated framing when the transport closes", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.listSessions();
		server.sendRaw(new Uint8Array([0, 0, 0, 2, 1]));
		server.close();

		await expect(pending).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: expect.stringMatching(/truncated/i),
		});
		expect(client.connectionState).toBe("disconnected");
	});

	test("rejects a mismatched response instead of leaving its request pending", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const listed = client.listSessions();
		expect(requests).toMatchObject([{ request: { command: "list" } }]);
		server.send({
			type: "response",
			id: requests[0]!.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1") },
		});

		await expect(listed).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: "Response command attach does not match list",
		});
		expect(client.connectionState).toBe("disconnected");
	});

	test("does not let a delayed command response replace a newer event snapshot", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const initial = sessionSnapshot("session-1", { revision: 1, thinkingLevel: "off" });
		server.send({ type: "event", event: { type: "session_snapshot", snapshot: initial } });
		const handle = client.getSession("session-1");
		const requests = collectRequests(server);
		const changing = handle.setThinking("high");
		const request = requests.find((candidate) => candidate.request.command === "set_thinking");
		if (!request) throw new Error("Missing set_thinking request");
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { revision: 3, thinkingLevel: "high" }),
			},
		});
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: {
				command: "set_thinking",
				session: sessionSnapshot("session-1", { revision: 2, thinkingLevel: "medium" }),
			},
		});

		await changing;
		expect(handle.snapshot).toMatchObject({ revision: 3, thinkingLevel: "high" });
	});

	test("does not let an attach response replace a newer snapshot from the reacquired runtime", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { revision: 10, attached: false }),
			},
		});
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "attach") return;
			server.send({
				type: "event",
				event: {
					type: "session_snapshot",
					snapshot: sessionSnapshot("session-1", { revision: 3, thinkingLevel: "high" }),
				},
			});
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: {
					command: "attach",
					session: sessionSnapshot("session-1", { revision: 2, thinkingLevel: "medium" }),
				},
			});
		});

		const handle = await client.attachSession("session-1");
		expect(handle.snapshot).toMatchObject({ revision: 3, thinkingLevel: "high" });
	});

	test("accepts a lower revision after detaching and reacquiring the same session", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		let attachCount = 0;
		server.onMessage((message) => {
			if (message.type !== "request") return;
			if (message.request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: {
						command: "attach",
						session: sessionSnapshot("session-1", { revision: attachCount++ === 0 ? 10 : 0 }),
					},
				});
			}
			if (message.request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: "session-1" },
				});
			}
		});

		const first = await client.attachSession("session-1");
		expect(first.snapshot?.revision).toBe(10);
		await first.detach();
		const reopened = await client.attachSession("session-1");
		expect(reopened.snapshot?.revision).toBe(0);
	});

	test("rejects frame limits outside the unsigned 32-bit range", () => {
		const server = new MemoryByteServer();
		expect(
			() =>
				new PiClient({
					token: "secret",
					maxFrameLength: 0x1_0000_0000,
					transportFactory: (handlers) => server.connect(handlers),
				}),
		).toThrow(/maxFrameLength/);
	});

	test("surfaces typed request errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const attaching = client.attachSession("locked");
		server.send({
			type: "response",
			id: requests[0]?.id ?? "missing",
			ok: false,
			error: { code: "session_locked", message: "Already attached" },
		});
		await expect(attaching).rejects.toMatchObject({ name: "PiError", code: "session_locked" });
	});
});
