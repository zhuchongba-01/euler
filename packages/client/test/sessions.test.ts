import { describe, expect, test } from "vitest";
import { PiSessionDetachedError } from "../src/index.ts";
import { connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

describe("PiClient", () => {
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
		expect(reopened).toBe(first);
		expect(reopened.snapshot?.revision).toBe(0);
	});
});
