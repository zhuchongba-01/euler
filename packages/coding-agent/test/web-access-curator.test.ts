import { rmSync } from "node:fs";
import { platform } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import {
	resolveEulerWebSearchWorkflow,
	shouldOpenEulerCuratorBrowser,
} from "../src/extensions/web-access/euler-config.ts";
import eulerWebAccess from "../src/extensions/web-access/index.ts";

const curatorTestState = vi.hoisted(() => {
	const agentDir = `${process.env.TEMP ?? "C:\\Temp"}\\euler-curator-${process.pid}`;
	const previous = process.env.EULER_CODING_AGENT_DIR;
	process.env.EULER_CODING_AGENT_DIR = agentDir;
	return {
		agentDir,
		previous,
		startServer: vi.fn(async () => ({
			url: "http://127.0.0.1:43123/",
			close: vi.fn(),
			pushError: vi.fn(),
			pushResult: vi.fn(),
			searchesDone: vi.fn(),
			getConnectionState: () => ({ browserConnected: false, lastHeartbeatAgeMs: 0 }),
		})),
	};
});

vi.mock("../src/extensions/web-access/curator-server.ts", () => ({
	startCuratorServer: curatorTestState.startServer,
}));

beforeEach(() => curatorTestState.startServer.mockClear());
afterAll(() => {
	rmSync(curatorTestState.agentDir, { recursive: true, force: true });
	if (curatorTestState.previous === undefined) delete process.env.EULER_CODING_AGENT_DIR;
	else process.env.EULER_CODING_AGENT_DIR = curatorTestState.previous;
});

function registeredCommands() {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
	const sendMessage = vi.fn();
	const api = {
		registerTool: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn(),
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		},
		exec,
		sendMessage,
	} as unknown as ExtensionAPI;
	eulerWebAccess(api);
	return { commands, exec, sendMessage };
}

function commandContext(): ExtensionCommandContext {
	return {
		cwd: curatorTestState.agentDir,
		hasUI: true,
		model: undefined,
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
		},
		isProjectTrusted: () => false,
		ui: {
			notify: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
}

describe("Euler curator browser boundary", () => {
	it("opens a browser only for the explicit /websearch command", () => {
		expect(shouldOpenEulerCuratorBrowser("websearch-command")).toBe(true);
		expect(shouldOpenEulerCuratorBrowser("automatic-search")).toBe(false);
		expect(shouldOpenEulerCuratorBrowser("curator-command")).toBe(false);
	});

	it("defaults to auto-summary while preserving explicit upstream workflows", () => {
		expect(resolveEulerWebSearchWorkflow(undefined)).toBe("auto-summary");
		expect(resolveEulerWebSearchWorkflow("summary-review")).toBe("summary-review");
		expect(resolveEulerWebSearchWorkflow("auto-summary")).toBe("auto-summary");
		expect(resolveEulerWebSearchWorkflow("none")).toBe("none");
	});

	it("the real /curator handler preserves auto-summary without opening a browser", async () => {
		const { commands, exec } = registeredCommands();

		await commands.get("curator")?.handler("auto-summary", commandContext());

		expect(exec).not.toHaveBeenCalled();
		expect(curatorTestState.startServer).not.toHaveBeenCalled();
	});

	it("the real /websearch handler starts one curator and opens one browser", async () => {
		const { commands, exec } = registeredCommands();

		await commands.get("websearch")?.handler("", commandContext());

		expect(curatorTestState.startServer).toHaveBeenCalledTimes(1);
		if (platform() === "win32") {
			expect(exec).toHaveBeenCalledTimes(1);
			expect(exec).toHaveBeenCalledWith("cmd", ["/c", "start", "", "http://127.0.0.1:43123/"]);
		} else {
			expect(exec).not.toHaveBeenCalled();
		}
	});
});
