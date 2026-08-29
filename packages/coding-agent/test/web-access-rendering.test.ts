import { describe, expect, it } from "vitest";
import { formatEulerSearchResult } from "../src/extensions/web-access/euler-rendering.ts";

const result = {
	provider: "exa\u001b]8;;https://evil.test\u0007",
	totalResults: 2,
	summary: "Euler is a compact terminal agent.\u001b[2J",
	sources: [
		{ title: "Euler overview\u001b[31m", url: "https://example.test/euler\u001b]0;owned\u0007" },
		{ title: "Search design", url: "https://example.test/search" },
	],
};

describe("Euler web search rendering", () => {
	it("shows provider, result count, one-line summary, and source count when collapsed", () => {
		const output = formatEulerSearchResult(result, false);

		expect(output).toContain("exa");
		expect(output).toContain("2 results");
		expect(output).toContain("Euler is a compact terminal agent.");
		expect(output).toContain("2 sources");
		expect(output).not.toMatch(/[\u001b\u0007]/u);
	});

	it("shows the summary, titles, and URLs when expanded without control sequences", () => {
		const output = formatEulerSearchResult(result, true);

		expect(output).toContain("Euler overview");
		expect(output).toContain("https://example.test/euler");
		expect(output).toContain("Search design");
		expect(output).not.toMatch(/[\u001b\u0007]/u);
	});
});
