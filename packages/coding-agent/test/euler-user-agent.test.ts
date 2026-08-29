import { describe, expect, it } from "vitest";
import { getEulerUserAgent } from "../src/utils/euler-user-agent.ts";

describe("getEulerUserAgent", () => {
	it("formats the Euler user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getEulerUserAgent("1.2.3");

		expect(userAgent).toBe(`euler/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^euler\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
