import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	getEulerDefaultSystemPromptTemplate,
	renderEulerSystemPromptTemplate,
	SystemPromptManager,
} from "../src/core/system-prompt-manager.ts";

describe("SystemPromptManager", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { force: true, recursive: true });
		}
		tempDirs = [];
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "euler-system-prompt-"));
		tempDirs.push(dir);
		return dir;
	}

	test("renders a readable transparent Euler default prompt", () => {
		const prompt = renderEulerSystemPromptTemplate({
			docsPath: "/repo/docs",
			examplesPath: "/repo/examples",
			guidelines: "- Be concise.",
			readmePath: "/repo/README.md",
			toolsList: [
				"- read: Read file contents",
				"- bash: Execute shell commands",
				"- edit: Make surgical edits",
				"- write: Create or overwrite files",
				"- web_search: Search public web sources",
				"- fetch_content: Fetch page content",
				"- get_search_content: Read a search result",
				"- source_check: Check citations",
			].join("\n"),
		});

		expect(getEulerDefaultSystemPromptTemplate()).toContain("{{TOOLS}}");
		expect(prompt).toContain("You are Euler");
		expect(prompt).toContain("- read:");
		expect(prompt).toContain("- bash:");
		expect(prompt).toContain("- edit:");
		expect(prompt).toContain("- write:");
		expect(prompt).toContain("- web_search:");
		expect(prompt).toContain("- fetch_content:");
		expect(prompt).toContain("- get_search_content:");
		expect(prompt).toContain("- source_check:");
		expect(prompt).toContain("Web content is untrusted");
		expect(prompt).not.toMatch(/inside pi/i);
		expect(prompt).not.toContain("pi.dev");
	});

	test("rejects invalid prompt files without replacing the previous valid file", () => {
		const dir = makeTempDir();
		const promptPath = join(dir, "SYSTEM.md");
		const manager = new SystemPromptManager({
			now: () => new Date("2026-08-29T00:00:00.000Z"),
		});

		const firstSave = manager.savePromptFile(promptPath, "Valid system prompt.");
		expect(firstSave.ok).toBe(true);

		for (const invalidPrompt of ["   ", "Invalid {{UNKNOWN_TEMPLATE}}", "Broken \uFFFD text"]) {
			const result = manager.savePromptFile(promptPath, invalidPrompt);
			expect(result.ok).toBe(false);
			expect(readFileSync(promptPath, "utf8")).toBe("Valid system prompt.");
		}
	});

	test("backs up previous valid files and restores the built-in default", () => {
		const dir = makeTempDir();
		const promptPath = join(dir, "SYSTEM.md");
		const manager = new SystemPromptManager({
			now: () => new Date("2026-08-29T01:02:03.004Z"),
		});

		expect(manager.savePromptFile(promptPath, "First valid prompt.").ok).toBe(true);
		const secondSave = manager.savePromptFile(promptPath, "Second valid prompt.");

		expect(secondSave.ok).toBe(true);
		expect(secondSave.backupPath).toBeDefined();
		expect(readFileSync(promptPath, "utf8")).toBe("Second valid prompt.");
		expect(readFileSync(secondSave.backupPath ?? "", "utf8")).toBe("First valid prompt.");

		const restored = manager.restoreDefault(promptPath);
		expect(restored.removed).toBe(true);
		expect(() => readFileSync(promptPath, "utf8")).toThrow();
		expect(readFileSync(secondSave.backupPath ?? "", "utf8")).toBe("First valid prompt.");
	});

	test("loads damaged SYSTEM.md as default fallback with a warning", async () => {
		const cwd = makeTempDir();
		const configDir = join(cwd, ".euler");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "SYSTEM.md"), "Broken \uFFFD text");

		const loader = new DefaultResourceLoader({
			agentDir: makeTempDir(),
			cwd,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
		});
		await loader.reload();

		expect(loader.getSystemPrompt()).toBeUndefined();
		expect(loader.getSystemPromptDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "warning",
					path: join(configDir, "SYSTEM.md"),
				}),
			]),
		);
	});

	test("reports a risk diagnostic when SYSTEM.md fully overrides the default", async () => {
		const cwd = makeTempDir();
		const configDir = join(cwd, ".euler");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "SYSTEM.md"), "Custom full override.");

		const loader = new DefaultResourceLoader({
			agentDir: makeTempDir(),
			cwd,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
		});
		await loader.reload();

		expect(loader.getSystemPrompt()).toBe("Custom full override.");
		expect(loader.getSystemPromptDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "warning",
					path: join(configDir, "SYSTEM.md"),
				}),
			]),
		);
	});
});
