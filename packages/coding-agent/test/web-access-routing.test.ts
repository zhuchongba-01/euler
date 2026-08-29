import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runEulerSearchRoute } from "../src/extensions/web-access/euler-config.ts";
import { search as registeredWebSearchRoute } from "../src/extensions/web-access/gemini-search.ts";

const routeEnvironment = vi.hoisted(() => {
	const previous = process.env.EULER_CODING_AGENT_DIR;
	process.env.EULER_CODING_AGENT_DIR = `${process.env.TEMP ?? "C:\\Temp"}\\euler-web-route-test`;
	return { previous };
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
	if (routeEnvironment.previous === undefined) delete process.env.EULER_CODING_AGENT_DIR;
	else process.env.EULER_CODING_AGENT_DIR = routeEnvironment.previous;
});

describe("Euler web search routing", () => {
	it("tries anonymous Exa MCP and falls back only to DuckDuckGo", async () => {
		const search = vi.fn(async (provider: string) => {
			if (provider === "exa") throw new Error("Exa MCP unavailable");
			return { provider, results: [{ title: "Euler", url: "https://example.test/euler" }] };
		});

		await expect(runEulerSearchRoute("auto", search)).resolves.toMatchObject({ provider: "duckduckgo" });
		expect(search.mock.calls.map(([provider]) => provider)).toEqual(["exa", "duckduckgo"]);
	});

	it("never introduces paid providers into auto routing", async () => {
		const search = vi.fn(async (provider: string) => {
			throw new Error(`${provider} unavailable`);
		});

		await expect(runEulerSearchRoute("auto", search)).rejects.toThrow("Exa MCP");
		expect(search.mock.calls.map(([provider]) => provider)).toEqual(["exa", "duckduckgo"]);
		expect(search).not.toHaveBeenCalledWith("firecrawl");
		expect(search).not.toHaveBeenCalledWith("openai");
	});

	it("uses a non-default provider only when explicitly selected", async () => {
		const search = vi.fn(async (provider: string) => ({ provider, results: [] }));

		await runEulerSearchRoute("firecrawl", search);
		expect(search).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalledWith("firecrawl");
	});

	it("the real search entrypoint cannot bypass Exa MCP to reach a paid provider", async () => {
		const previousExaKey = process.env.EXA_API_KEY;
		process.env.EXA_API_KEY = "must-not-be-used";
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith("https://mcp.exa.ai/")) {
				return new Response("Exa unavailable", { status: 503 });
			}
			if (url.startsWith("https://html.duckduckgo.com/")) {
				return new Response(
					'<div class="result"><a class="result__a" href="https://example.test/euler">Euler</a><div class="result__snippet">Terminal agent</div></div>',
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected provider request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			await expect(registeredWebSearchRoute("Euler", { provider: "auto" })).resolves.toMatchObject({
				provider: "duckduckgo",
				results: [{ title: "Euler", url: "https://example.test/euler" }],
			});
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
				expect.stringMatching(/^https:\/\/mcp\.exa\.ai\//),
				expect.stringMatching(/^https:\/\/html\.duckduckgo\.com\//),
			]);
			expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContainEqual(
				expect.stringMatching(/^https:\/\/api\.exa\.ai\//),
			);
		} finally {
			if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = previousExaKey;
		}
	});
});
