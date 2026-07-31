import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeClientMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { PiServer, type PiSessionBackend } from "../src/index.ts";
import { createUnixServer } from "../src/transports/unix/index.ts";

const TOKEN = "transport-smoke-token";

const backend: PiSessionBackend = {
	async listSessions() {
		return [];
	},
	async listModels() {
		return [];
	},
	async createSession() {
		throw new Error("not used");
	},
	async openSession() {
		throw new Error("not used");
	},
};

let server: PiServer | undefined;
let socket: Socket | undefined;
let tempDirectory: string | undefined;

async function makeSocketPath(): Promise<string> {
	tempDirectory = await mkdtemp(join(tmpdir(), "pi-server-smoke-"));
	return join(tempDirectory, "server.sock");
}

afterEach(async () => {
	socket?.destroy();
	await server?.close();
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
	server = undefined;
	socket = undefined;
	tempDirectory = undefined;
});

test("requires explicit listeners", () => {
	expect(() => Reflect.construct(PiServer, [backend, { token: TOKEN }])).toThrow(/listeners/);
});

test("rejects Unix socket paths that cannot fit in sockaddr_un", () => {
	expect(() => createUnixServer(backend, { token: TOKEN, path: `/tmp/${"x".repeat(512)}` })).toThrow(/too long/);
});

test("rejects an overlong derived private Unix bind path", async () => {
	const maxLength = process.platform === "linux" ? 107 : 103;
	const suffixLength = Buffer.byteLength("/tmp//s");
	const path = `/tmp/${"x".repeat(maxLength - suffixLength)}/s`;
	server = createUnixServer(backend, { token: TOKEN, path });

	await expect(server.start()).rejects.toThrow(/private Unix bind path.*too long/);
});

test("Unix socket accepts a fragmented framed-CBOR hello", async () => {
	const path = await makeSocketPath();
	server = createUnixServer(backend, { token: TOKEN, path });
	await server.start();
	expect(server.addresses[0]).toBe(path);

	socket = createConnection(path);
	await once(socket, "connect");
	const response = nextServerMessage(socket);
	const hello = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION, token: TOKEN });
	socket.write(hello.subarray(0, 2));
	socket.write(hello.subarray(2));
	expect(await response).toMatchObject({ type: "hello", version: PROTOCOL_VERSION });
});

test("rejects concurrent start calls without leaking the Unix listener", async () => {
	const path = await makeSocketPath();
	server = createUnixServer(backend, { token: TOKEN, path });
	const starting = server.start();
	await expect(server.start()).rejects.toThrow(/starting/);
	await starting;
	await server.close();
	expect(server.addresses[0]).toBeUndefined();
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("handshake timeout cleanup does not wait for a blocked output queue", async () => {
	class BlockedConnection implements ByteConnection {
		closed = false;
		finalChunk?: Uint8Array;

		send(): Promise<void> {
			return new Promise(() => {});
		}

		close(finalChunk?: Uint8Array): void {
			this.finalChunk = finalChunk;
			this.closed = true;
		}
	}
	const core = new PiServer(backend, {
		listeners: [],
		token: TOKEN,
		maxFrameLength: 1024,
		handshakeTimeoutMs: 10,
	});
	const connection = new BlockedConnection();
	core.accept(connection);

	await vi.waitFor(() => expect(connection.closed).toBe(true));
	expect(connection.finalChunk).toBeInstanceOf(Uint8Array);
	const messages = new ServerMessageDecoder().push(connection.finalChunk!);
	expect(messages).toMatchObject([{ type: "hello_error", error: { code: "invalid_request" } }]);
	await core.close();
});

test("rejects timeout values above Node's maximum timer delay", () => {
	const unix = { path: "/tmp/pi-server-timeout-test.sock" };
	expect(() =>
		createUnixServer(backend, { token: TOKEN, path: unix.path, handshakeTimeoutMs: 2_147_483_648 }),
	).toThrow(/handshakeTimeoutMs/);
	expect(() =>
		createUnixServer(backend, { token: TOKEN, path: unix.path, gracefulCloseTimeoutMs: 2_147_483_648 }),
	).toThrow(/gracefulCloseTimeoutMs/);
});

test("rejects pending-byte limits smaller than one maximum frame", async () => {
	const path = await makeSocketPath();
	expect(() => createUnixServer(backend, { token: TOKEN, path, maxFrameLength: 128, maxPendingBytes: 131 })).toThrow(
		/maxPendingBytes/,
	);
});

function nextServerMessage(target: Socket): Promise<ServerMessage> {
	const decoder = new ServerMessageDecoder();
	return new Promise((resolve, reject) => {
		const onData = (chunk: Buffer): void => {
			try {
				const messages = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				if (messages.length === 0) return;
				target.off("data", onData);
				resolve(messages[0]!);
			} catch (error) {
				reject(error);
			}
		};
		target.on("data", onData);
		target.once("error", reject);
	});
}
