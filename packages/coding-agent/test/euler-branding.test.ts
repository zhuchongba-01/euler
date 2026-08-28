import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME } from "../src/config.ts";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	bin: Record<string, string>;
	piConfig?: { name?: string; title?: string; configDir?: string };
};

describe("Euler branding contract", () => {
	test("exports the explicit CLI and display identities", () => {
		expect(APP_NAME).toBe("euler");
		expect(APP_TITLE).toBe("Euler");
		expect(CONFIG_DIR_NAME).toBe(".euler");
		expect(packageJson.piConfig).toEqual({ name: "euler", title: "Euler", configDir: ".euler" });
	});

	test("installs only the euler executable", () => {
		expect(packageJson.bin).toEqual({ euler: "dist/bundle/cli.js" });
	});

	test("uses Euler throughout the complete help text", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		printHelp();
		const help = log.mock.calls.map(([message]) => String(message)).join("\n");
		log.mockRestore();

		expect(help).toContain("euler - AI coding assistant");
		expect(help).toContain("euler [options]");
		expect(help).not.toContain("π");
		expect(help).not.toMatch(/\bpi\b/);
	});
});
