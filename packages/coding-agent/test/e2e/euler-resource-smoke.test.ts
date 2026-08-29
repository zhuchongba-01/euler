/**
 * E2E: resource smoke.
 *
 * Loads representative PI-format resources (theme, prompt template, skill,
 * local package) through the real loaders against an isolated agent dir,
 * fully offline.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptTemplates } from "../../src/core/prompt-templates.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { loadThemeFromPath } from "../../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

describe("euler resource smoke e2e", () => {
	it("loads themes, prompts, and skills from an isolated agent dir", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "euler-res-"));
		tempDirs.push(agentDir);
		const cwd = mkdtempSync(join(tmpdir(), "euler-res-cwd-"));
		tempDirs.push(cwd);

		mkdirSync(join(agentDir, "themes"), { recursive: true });
		copyFileSync(new URL("fixtures/smoke-theme.json", import.meta.url), join(agentDir, "themes", "smoke.json"));
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(
			join(agentDir, "prompts", "greet.md"),
			'---\ndescription: Greet someone\nargument-hint: "<name>"\n---\nHello $1!',
		);
		mkdirSync(join(agentDir, "skills", "smoke-skill"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "smoke-skill", "SKILL.md"),
			"---\nname: smoke-skill\ndescription: Smoke skill.\n---\n\nBody.",
		);

		const theme = loadThemeFromPath(join(agentDir, "themes", "smoke.json"));
		expect(theme.name).toBe("smoke");

		const prompts = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });
		expect(prompts.map((prompt) => prompt.name)).toContain("greet");
		expect(prompts.find((prompt) => prompt.name === "greet")?.argumentHint).toBe("<name>");

		const skills = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
		expect(skills.skills.map((skill) => skill.name)).toContain("smoke-skill");
		expect(skills.diagnostics).toHaveLength(0);
	});
});
