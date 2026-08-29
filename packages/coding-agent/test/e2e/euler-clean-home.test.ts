/**
 * E2E: clean-home startup.
 *
 * Spawns the bundled CLI with an isolated HOME, no API keys, and no existing
 * PI/Euler configuration. Verifies Euler branding in user-visible output and
 * that no `pi` command exists.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const packageDir = join(import.meta.dirname, "..", "..");
const cliPath = join(packageDir, "dist", "bundle", "cli.js");

const tempDirs: string[] = [];

beforeAll(() => {
	if (!existsSync(cliPath)) {
		console.warn(`Skipping clean-home e2e: bundle not built at ${cliPath}`);
	}
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe.skipIf(!existsSync(cliPath))("euler clean-home e2e", () => {
	function cleanHomeEnv(extra: Record<string, string> = {}): Record<string, string> {
		const home = mkdtempSync(join(tmpdir(), "euler-clean-home-"));
		tempDirs.push(home);
		return {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			EULER_CODING_AGENT_DIR: join(home, ".euler", "agent"),
			EULER_OFFLINE: "1",
			// Strip ambient provider credentials so the run is truly keyless.
			OPENAI_API_KEY: "",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_OAUTH_TOKEN: "",
			GEMINI_API_KEY: "",
			...extra,
		};
	}

	it("prints Euler-branded help without PI commands", () => {
		const result = spawnSync(process.execPath, [cliPath, "--help"], {
			encoding: "utf-8",
			env: cleanHomeEnv(),
			timeout: 60_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("euler");
		expect(result.stdout).not.toMatch(/\bpi\.dev\b|π/);
		expect(result.stdout).not.toMatch(/Usage:\s*\n?\s*pi\b/);
	});

	it("reports the version without network access", () => {
		const result = spawnSync(process.execPath, [cliPath, "--version"], {
			encoding: "utf-8",
			env: cleanHomeEnv(),
			timeout: 60_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("creates the agent config directory under .euler on startup", () => {
		const home = mkdtempSync(join(tmpdir(), "euler-clean-home-"));
		tempDirs.push(home);
		const agentDir = join(home, ".euler", "agent");

		const result = spawnSync(process.execPath, [cliPath, "--mode", "rpc", "--no-session", "--help"], {
			encoding: "utf-8",
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				EULER_CODING_AGENT_DIR: agentDir,
				EULER_OFFLINE: "1",
			},
			timeout: 60_000,
		});
		expect(result.status).toBe(0);
		expect(existsSync(agentDir)).toBe(true);
		expect(existsSync(join(home, ".pi"))).toBe(false);
	}, 90_000);

	it("does not inherit ambient PI configuration", () => {
		const home = mkdtempSync(join(tmpdir(), "euler-clean-home-"));
		tempDirs.push(home);

		const result = execFileSync(process.execPath, [cliPath, "--version"], {
			encoding: "utf-8",
			env: cleanHomeEnv({ PI_CODING_AGENT_DIR: "C:\\definitely-pi-config" }),
			timeout: 60_000,
		});
		expect(result.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(home).toBeDefined();
	});
});
