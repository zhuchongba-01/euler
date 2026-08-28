import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";

let tempHome: string | undefined;

afterEach(() => {
	vi.unstubAllEnvs();
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = undefined;
	}
});

describe("Euler config isolation", () => {
	test("uses an isolated HOME under ~/.euler/agent and ignores ~/.pi/agent", () => {
		tempHome = mkdtempSync(join(tmpdir(), "euler-home-"));
		const piAgentDir = join(tempHome, ".pi", "agent");
		mkdirSync(piAgentDir, { recursive: true });
		writeFileSync(join(piAgentDir, "settings.json"), '{"from":"pi"}');
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		vi.stubEnv("EULER_CODING_AGENT_DIR", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		expect(getAgentDir()).toBe(join(tempHome, ".euler", "agent"));
	});

	test("honors only the Euler directory override", () => {
		const eulerDir = join(homedir(), "euler-test-config");
		vi.stubEnv("EULER_CODING_AGENT_DIR", eulerDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(homedir(), "pi-test-config"));
		expect(getAgentDir()).toBe(eulerDir);
	});

	test("ignores PI_CODING_AGENT_DIR when it is the only override", () => {
		vi.stubEnv("EULER_CODING_AGENT_DIR", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", join(homedir(), "pi-test-config"));
		expect(getAgentDir()).toBe(join(homedir(), ".euler", "agent"));
	});
});
