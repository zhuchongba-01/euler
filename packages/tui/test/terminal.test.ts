import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

describe("ProcessTerminal", () => {
	it("should skip the Kitty query inside Zellij and enable modifyOtherKeys immediately", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const stdinOnCalls: Array<{ event: string | symbol; listener: (...args: unknown[]) => void }> = [];
		const stdinRemoveCalls: Array<{ event: string | symbol; listener: (...args: unknown[]) => void }> = [];
		const stdoutRemoveCalls: Array<{ event: string | symbol; listener: (...args: unknown[]) => void }> = [];

		const originalStdoutWrite = process.stdout.write;
		const originalStdinOn = process.stdin.on;
		const originalStdinRemoveListener = process.stdin.removeListener;
		const originalStdinPause = process.stdin.pause;
		const originalStdoutRemoveListener = process.stdout.removeListener;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			stdinOnCalls.push({ event, listener });
			return process.stdin;
		}) as typeof process.stdin.on;
		process.stdin.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			stdinRemoveCalls.push({ event, listener });
			return process.stdin;
		}) as typeof process.stdin.removeListener;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		process.stdout.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			stdoutRemoveCalls.push({ event, listener });
			return process.stdout;
		}) as typeof process.stdout.removeListener;

		try {
			withEnv("ZELLIJ", "1", () => {
				(
					terminal as unknown as {
						queryAndEnableKittyProtocol(): void;
					}
				).queryAndEnableKittyProtocol();
			});

			assert.deepStrictEqual(writes, ["\x1b[>4;2m"]);
			assert.strictEqual(stdinOnCalls.length, 1);
			assert.strictEqual(stdinOnCalls[0]?.event, "data");

			terminal.stop();

			assert.deepStrictEqual(writes, ["\x1b[>4;2m", "\x1b[?2004l", "\x1b[>4;0m"]);
			assert.strictEqual(stdinRemoveCalls.length, 1);
			assert.strictEqual(stdinRemoveCalls[0]?.event, "data");
			assert.strictEqual(stdoutRemoveCalls.length, 0);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stdin.on = originalStdinOn;
			process.stdin.removeListener = originalStdinRemoveListener;
			process.stdin.pause = originalStdinPause;
			process.stdout.removeListener = originalStdoutRemoveListener;
		}
	});
});
