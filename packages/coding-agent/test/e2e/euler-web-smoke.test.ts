/**
 * E2E: web access smoke (fully offline).
 *
 * Composition-level checks over the Euler web-access boundary: offline tool
 * short-circuit, free-provider auto routing, curator browser policy, and
 * terminal-safe rendering of search results.
 */

import { describe, expect, it, vi } from "vitest";
import {
	EULER_DEFAULT_SEARCH_PROVIDERS,
	EULER_WEB_ACCESS_TOOL_NAMES,
	executeUnlessEulerOffline,
	runEulerSearchRoute,
	shouldOpenEulerCuratorBrowser,
} from "../../src/extensions/web-access/euler-config.ts";
import { formatEulerSearchResult } from "../../src/extensions/web-access/euler-rendering.ts";

describe("euler web smoke e2e", () => {
	it("exposes exactly the four free web tools", () => {
		expect([...EULER_WEB_ACCESS_TOOL_NAMES]).toEqual([
			"web_search",
			"fetch_content",
			"get_search_content",
			"source_check",
		]);
		expect([...EULER_DEFAULT_SEARCH_PROVIDERS]).toEqual(["exa", "duckduckgo"]);
	});

	it("short-circuits every tool when offline without touching the network", async () => {
		const execute = vi.fn(async () => {
			throw new Error("must not be called");
		});

		for (const tool of EULER_WEB_ACCESS_TOOL_NAMES) {
			const result = await executeUnlessEulerOffline(tool, { EULER_OFFLINE: "1" }, execute);
			expect(result).toMatchObject({ isError: true, details: { error: "offline", tool } });
		}
		expect(execute).not.toHaveBeenCalled();

		// Without the offline flag the delegate runs.
		const ok = await executeUnlessEulerOffline("web_search", {}, async () => "ran");
		expect(ok).toBe("ran");
	});

	it("routes auto search through Exa MCP then DuckDuckGo only", async () => {
		const search = vi.fn(async (provider: string) => {
			if (provider === "exa") throw new Error("Exa MCP unavailable");
			return { provider, results: [{ title: "Euler", url: "https://example.test/euler" }] };
		});

		await expect(runEulerSearchRoute("auto", search)).resolves.toMatchObject({ provider: "duckduckgo" });
		expect(search.mock.calls.map(([provider]) => provider)).toEqual(["exa", "duckduckgo"]);
	});

	it("fails auto routing with a deterministic dual-failure message", async () => {
		const search = vi.fn(async (provider: string) => {
			throw new Error(`${provider} down`);
		});

		await expect(runEulerSearchRoute("auto", search)).rejects.toThrow(
			/Euler free search route failed:[\s\S]*Exa MCP: exa down[\s\S]*DuckDuckGo: duckduckgo down/,
		);
	});

	it("never opens the curator browser outside /websearch", () => {
		expect(shouldOpenEulerCuratorBrowser("websearch-command")).toBe(true);
		expect(shouldOpenEulerCuratorBrowser("automatic-search")).toBe(false);
		expect(shouldOpenEulerCuratorBrowser("curator-command")).toBe(false);
	});

	it("renders search results without terminal control sequences", () => {
		const data = {
			provider: "duckduckgo",
			query: "euler agent",
			summary: "Euler is a terminal agent\x1b[31m with injection attempt\u001b]0;title\u0007",
			sources: [
				{ title: "Euler docs", url: "https://example.test/euler\x1b]8;;https://evil.test\x1b\\" },
				{ title: "Another source\u0000with-nul", url: "https://example.test/2" },
			],
		};

		const collapsed = formatEulerSearchResult(data as never, false);
		const expanded = formatEulerSearchResult(data as never, true);
		expect(collapsed).toContain("duckduckgo");
		for (const output of [collapsed, expanded]) {
			expect(output).toContain("Euler is a terminal agent");
			// No raw escape sequences or control bytes survive rendering.
			expect(output).not.toMatch(/\x1b/);
			expect(output).not.toMatch(/\u0000/);
		}
		// Source titles and URLs render in the expanded view.
		expect(expanded).toContain("Euler docs");
		expect(expanded).toContain("https://example.test/2");
	});
});
