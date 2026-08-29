/**
 * Euler resource compatibility guarantees.
 *
 * Verifies:
 * - A clean ~/.euler/agent starts with zero skills, prompts, and user packages.
 * - Representative PI-format resources (prompt template, SKILL.md, TypeScript
 *   extension, multi-resource package) load unchanged in Euler.
 * - The ExtensionAPI public type surface stays identical to the PI baseline.
 * - Third-party extensions hardcoding PI paths/env vars get an explicit
 *   compatibility diagnostic instead of silently reading PI data.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { readPiManifest } from "../src/core/pi-manifest.ts";
import { loadPromptTemplates } from "../src/core/prompt-templates.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills } from "../src/core/skills.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("euler resource compatibility", () => {
	const tempDirs: string[] = [];

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	describe("clean home", () => {
		it("starts with zero skills, prompts, and user packages", () => {
			const cwd = makeTempDir("euler-compat-cwd-");
			const agentDir = makeTempDir("euler-compat-home-");
			mkdirSync(join(agentDir, "agent"));

			const skills = loadSkills({ cwd, agentDir: join(agentDir, "agent"), skillPaths: [], includeDefaults: true });
			expect(skills.skills).toHaveLength(0);
			expect(skills.diagnostics).toHaveLength(0);

			const prompts = loadPromptTemplates({
				cwd,
				agentDir: join(agentDir, "agent"),
				promptPaths: [],
				includeDefaults: true,
			});
			expect(prompts).toHaveLength(0);

			const settings = SettingsManager.create(cwd, join(agentDir, "agent"));
			expect(settings.getGlobalSettings().packages ?? []).toHaveLength(0);
		});

		it("does not read PI project resources from the working directory", () => {
			const cwd = makeTempDir("euler-compat-pi-cwd-");
			const agentDir = makeTempDir("euler-compat-pi-home-");
			mkdirSync(join(agentDir, "agent"));

			// A PI-style project checkout must not leak into Euler.
			mkdirSync(join(cwd, ".pi", "skills", "pi-only-skill"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "skills", "pi-only-skill", "SKILL.md"),
				"---\nname: pi-only-skill\ndescription: Only lives in PI config.\n---\n\nBody.\n",
			);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "pi-only.md"), "PI only prompt");

			expect(CONFIG_DIR_NAME).toBe(".euler");

			const skills = loadSkills({ cwd, agentDir: join(agentDir, "agent"), skillPaths: [], includeDefaults: true });
			expect(skills.skills).toHaveLength(0);

			const prompts = loadPromptTemplates({
				cwd,
				agentDir: join(agentDir, "agent"),
				promptPaths: [],
				includeDefaults: true,
			});
			expect(prompts).toHaveLength(0);
		});
	});

	describe("representative PI-format resources", () => {
		it("loads a prompt template with argument hints", () => {
			const cwd = makeTempDir("euler-compat-prompt-cwd-");
			const agentDir = join(makeTempDir("euler-compat-prompt-home-"), "agent");
			mkdirSync(join(agentDir, "prompts"), { recursive: true });
			writeFileSync(
				join(agentDir, "prompts", "review.md"),
				'---\ndescription: Review a pull request with structured analysis\nargument-hint: "<pr-number> <focus>"\n---\nReview PR $1 focusing on $2.',
			);

			const prompts = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });
			expect(prompts).toHaveLength(1);
			expect(prompts[0].name).toBe("review");
			expect(prompts[0].argumentHint).toBe("<pr-number> <focus>");
		});

		it("loads a SKILL.md skill from the user skills directory", () => {
			const cwd = makeTempDir("euler-compat-skill-cwd-");
			const agentDir = join(makeTempDir("euler-compat-skill-home-"), "agent");
			mkdirSync(join(agentDir, "skills", "deploy-notes"), { recursive: true });
			writeFileSync(
				join(agentDir, "skills", "deploy-notes", "SKILL.md"),
				"---\nname: deploy-notes\ndescription: Summarize deployment notes.\n---\n\nDo the thing.",
			);

			const { skills, diagnostics } = loadSkills({
				cwd,
				agentDir,
				skillPaths: [],
				includeDefaults: true,
			});
			expect(diagnostics).toHaveLength(0);
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("deploy-notes");
			expect(skills[0].sourceInfo.scope).toBe("user");
		});

		it("loads a TypeScript extension that registers commands and tools", async () => {
			const cwd = makeTempDir("euler-compat-ext-cwd-");
			const extensionPath = join(cwd, "legacy-extension.ts");
			writeFileSync(
				extensionPath,
				`
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerCommand("legacy-hello", { handler: async () => {} });
					pi.registerTool({
						name: "legacy_tool",
						label: "legacy_tool",
						description: "Legacy tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
				}
				`,
			);

			const result = await loadExtensions([extensionPath], cwd);
			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0].commands.has("legacy-hello")).toBe(true);
			expect(result.extensions[0].tools.has("legacy_tool")).toBe(true);
		});

		it("loads a multi-resource package via its pi manifest", async () => {
			const cwd = makeTempDir("euler-compat-pkg-cwd-");
			const packageDir = join(cwd, "sample-package");
			mkdirSync(join(packageDir, "skills", "pkg-skill"), { recursive: true });
			mkdirSync(join(packageDir, "prompts"), { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({
					name: "sample-package",
					pi: {
						extensions: ["index.ts"],
						skills: ["skills"],
						prompts: ["prompts"],
					},
				}),
			);
			writeFileSync(
				join(packageDir, "index.ts"),
				`export default function(pi) { pi.registerCommand("pkg-cmd", { handler: async () => {} }); }`,
			);
			writeFileSync(
				join(packageDir, "skills", "pkg-skill", "SKILL.md"),
				"---\nname: pkg-skill\ndescription: Packaged skill.\n---\n\nBody.",
			);
			writeFileSync(join(packageDir, "prompts", "pkg-prompt.md"), "Packaged prompt");

			const manifest = readPiManifest(join(packageDir, "package.json"));
			expect(manifest).toEqual({
				extensions: ["index.ts"],
				skills: ["skills"],
				prompts: ["prompts"],
			});

			const result = await loadExtensions([join(packageDir, "index.ts")], cwd);
			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0].commands.has("pkg-cmd")).toBe(true);

			const agentDir = join(makeTempDir("euler-compat-pkg-home-"), "agent");
			const skills = loadSkills({
				cwd,
				agentDir,
				skillPaths: [join(packageDir, "skills")],
				includeDefaults: false,
			});
			expect(skills.skills).toHaveLength(1);
			expect(skills.skills[0].name).toBe("pkg-skill");

			const prompts = loadPromptTemplates({
				cwd,
				agentDir,
				promptPaths: [join(packageDir, "prompts")],
				includeDefaults: false,
			});
			expect(prompts).toHaveLength(1);
			expect(prompts[0].name).toBe("pkg-prompt");
		});
	});

	describe("ExtensionAPI public type surface", () => {
		it("matches the PI 0.84.3 baseline snapshot", () => {
			const typesPath = join(__dirname, "..", "src", "core", "extensions", "types.ts");
			const source = readFileSync(typesPath, "utf-8");
			const currentDeclarations = [
				...source.matchAll(/^export (?:declare )?(?:interface|type|class|function|const|enum) ([A-Za-z0-9_]+)/gm),
			]
				.map((match) => match[1])
				.sort();

			const fixturePath = join(__dirname, "fixtures", "euler-extension-api-snapshot.txt");
			const baselineDeclarations = readFileSync(fixturePath, "utf-8").split("\n").filter(Boolean).sort();

			expect(currentDeclarations).toEqual(baselineDeclarations);
		});
	});

	describe("PI-path compatibility diagnostics", () => {
		it("warns when a third-party extension reads PI env vars or .pi paths", async () => {
			const cwd = makeTempDir("euler-compat-diag-cwd-");
			const extensionPath = join(cwd, "pi-hardcoded-extension.ts");
			writeFileSync(
				extensionPath,
				`
				import { readFileSync } from "node:fs";
				import { homedir } from "node:os";
				import { join } from "node:path";
				export default function(pi) {
					const piAgentDir = join(homedir(), ".pi", "agent");
					const legacyEnv = process.env.PI_CODING_AGENT_DIR;
					void readFileSync;
					void piAgentDir;
					void legacyEnv;
					pi.registerCommand("legacy", { handler: async () => {} });
				}
				`,
			);

			const result = await loadExtensions([extensionPath], cwd);
			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);

			const compat = result.diagnostics ?? [];
			const warning = compat.find(
				(diagnostic) => diagnostic.type === "warning" && diagnostic.path === extensionPath,
			);
			expect(warning).toBeDefined();
			expect(warning?.message).toContain("PI_CODING_AGENT_DIR");
			expect(warning?.message).toContain(".pi");
			expect(warning?.message).toContain("Euler does not read PI configuration");
		});

		it("does not warn for extensions without PI references", async () => {
			const cwd = makeTempDir("euler-compat-clean-cwd-");
			const extensionPath = join(cwd, "clean-extension.ts");
			writeFileSync(
				extensionPath,
				`export default function(pi) { pi.registerCommand("clean", { handler: async () => {} }); }`,
			);

			const result = await loadExtensions([extensionPath], cwd);
			expect(result.errors).toHaveLength(0);
			expect(result.diagnostics ?? []).toHaveLength(0);
		});
	});
});
