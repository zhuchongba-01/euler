import { describe, expect, it } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import {
	EULER_WEB_ACCESS_COMMAND_NAMES,
	EULER_WEB_ACCESS_TOOL_NAMES,
	getEulerWebSearchConfigPath,
} from "../src/extensions/web-access/euler-config.ts";

describe("Euler built-in web access", () => {
	it("is a hidden inline extension with the fixed tool and command surface", () => {
		const extension = builtInExtensions.find((candidate) => candidate.name === "Euler Web Access");

		expect(extension).toMatchObject({ name: "Euler Web Access", hidden: true });
		expect(EULER_WEB_ACCESS_TOOL_NAMES).toEqual([
			"web_search",
			"fetch_content",
			"get_search_content",
			"source_check",
		]);
		expect(EULER_WEB_ACCESS_COMMAND_NAMES).toEqual(["websearch", "curator", "search"]);
	});

	it("uses only the Euler agent directory and ignores PI inputs", () => {
		const env: Record<string, string | undefined> = {
			EULER_CODING_AGENT_DIR: "C:\\isolated\\.euler\\agent",
			PI_CODING_AGENT_DIR: "C:\\legacy\\.pi\\agent",
		};

		expect(getEulerWebSearchConfigPath(env, "C:\\home")).toBe("C:\\isolated\\.euler\\agent\\web-search.json");
		delete env.EULER_CODING_AGENT_DIR;
		expect(getEulerWebSearchConfigPath(env, "C:\\home")).toBe("C:\\home\\.euler\\agent\\web-search.json");
	});
});
