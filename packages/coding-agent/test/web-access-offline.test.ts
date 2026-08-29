import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { EULER_WEB_ACCESS_TOOL_NAMES, executeUnlessEulerOffline } from "../src/extensions/web-access/euler-config.ts";
import eulerWebAccess from "../src/extensions/web-access/index.ts";

afterEach(() => {
	delete process.env.EULER_OFFLINE;
	vi.unstubAllGlobals();
});

describe("Euler web access offline mode", () => {
	it.each(EULER_WEB_ACCESS_TOOL_NAMES)("blocks %s before any network work", async (toolName) => {
		const execute = vi.fn(async () => ({ content: [{ type: "text", text: "online" }] }));

		const result = await executeUnlessEulerOffline(toolName, { EULER_OFFLINE: "1" }, execute);

		expect(execute).not.toHaveBeenCalled();
		expect(result).toMatchObject({ isError: true, details: { error: "offline", tool: toolName } });
		expect(result.content[0]?.text).toContain("EULER_OFFLINE");
	});

	it("short-circuits every tool registered by the real hidden extension", async () => {
		process.env.EULER_OFFLINE = "1";
		const network = vi.fn(async () => {
			throw new Error("network must not run");
		});
		vi.stubGlobal("fetch", network);
		const tools = new Map<string, ToolDefinition>();
		const api = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as ExtensionAPI;
		eulerWebAccess(api);

		expect([...tools.keys()].sort()).toEqual([...EULER_WEB_ACCESS_TOOL_NAMES].sort());
		for (const toolName of EULER_WEB_ACCESS_TOOL_NAMES) {
			const tool = tools.get(toolName);
			expect(tool).toBeDefined();
			const result = await tool?.execute("call", {}, undefined, undefined, {} as ExtensionContext);
			expect(result).toMatchObject({ isError: true, details: { error: "offline", tool: toolName } });
		}
		expect(network).not.toHaveBeenCalled();
	});
});
