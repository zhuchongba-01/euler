import { describe, expect, test } from "vitest";
import type { ByteConnectionAcceptor } from "../src/connection.ts";
import type { PiServerListener } from "../src/listener.ts";
import { PiServer } from "../src/server.ts";
import type { PiSessionBackend } from "../src/types.ts";

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

class TestListener implements PiServerListener {
	address: string | undefined;
	accept?: ByteConnectionAcceptor;
	startCount = 0;
	closeCount = 0;
	readonly startError: Error | undefined;

	constructor(address: string, startError?: Error) {
		this.address = address;
		this.startError = startError;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		this.startCount += 1;
		this.accept = accept;
		if (this.startError) throw this.startError;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		this.address = undefined;
	}
}

describe("PiServer listener composition", () => {
	test("starts and closes every configured listener", async () => {
		const first = new TestListener("first");
		const second = new TestListener("second");
		const server = new PiServer(backend, { token: "secret", listeners: [first, second] });

		await server.start();
		expect(server.addresses).toEqual(["first", "second"]);
		expect(first.accept).toBeTypeOf("function");
		expect(second.accept).toBeTypeOf("function");

		await server.close();
		expect(first.closeCount).toBe(1);
		expect(second.closeCount).toBe(1);
		expect(server.addresses).toEqual([]);
	});

	test("closes previously started listeners when startup fails", async () => {
		const first = new TestListener("first");
		const failure = new Error("listener failed");
		const second = new TestListener("second", failure);
		const server = new PiServer(backend, { token: "secret", listeners: [first, second] });

		await expect(server.start()).rejects.toBe(failure);
		expect(first.closeCount).toBe(1);
		expect(second.closeCount).toBe(0);
	});
});
