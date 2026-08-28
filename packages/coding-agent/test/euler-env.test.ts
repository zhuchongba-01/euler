import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EULER_ENV, getEulerEnv, isTruthyEnvFlag } from "../src/euler-env.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Euler-owned environment", () => {
	test("defines product variables in one explicit namespace", () => {
		expect(EULER_ENV).toMatchObject({
			agentDir: "EULER_CODING_AGENT_DIR",
			sessionDir: "EULER_CODING_AGENT_SESSION_DIR",
			packageDir: "EULER_PACKAGE_DIR",
			offline: "EULER_OFFLINE",
			skipVersionCheck: "EULER_SKIP_VERSION_CHECK",
			shareViewerUrl: "EULER_SHARE_VIEWER_URL",
			managedInstallRoot: "EULER_MANAGED_INSTALL_ROOT",
			installerApiBase: "EULER_INSTALLER_API_BASE",
			startupBenchmark: "EULER_STARTUP_BENCHMARK",
			experimental: "EULER_EXPERIMENTAL",
			clipboard: "EULER_CLIPBOARD",
			sessionId: "EULER_SESSION_ID",
			sessionFile: "EULER_SESSION_FILE",
			provider: "EULER_PROVIDER",
			model: "EULER_MODEL",
			reasoningLevel: "EULER_REASONING_LEVEL",
		});
	});

	test.each(["1", "true", "TRUE", "yes", "YES"])("parses %s as enabled", (value) => {
		expect(isTruthyEnvFlag(value)).toBe(true);
	});

	test.each([undefined, "", "0", "false", "no", "anything"])("does not parse %s as enabled", (value) => {
		expect(isTruthyEnvFlag(value)).toBe(false);
	});

	test("does not read a corresponding PI alias", () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("EULER_OFFLINE", "");
		expect(getEulerEnv("offline")).toBeUndefined();
	});

	test("retains external Provider variables untouched", () => {
		vi.stubEnv("OPENAI_API_KEY", "provider-secret");
		expect(process.env.OPENAI_API_KEY).toBe("provider-secret");
	});
});

describe("Euler environment source audit", () => {
	test("does not read PI-owned environment aliases in runtime source or scripts", () => {
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const files = [
			...globSync("src/**/*.{ts,js,mjs}", { cwd: packageRoot }),
			...globSync("scripts/*.{js,mjs,sh}", { cwd: repoRoot }).map((file) => `../../../${file}`),
		];
		const offenders = files
			.filter((file) => existsSync(new URL(file, new URL("../", import.meta.url))))
			.filter((file) =>
				/process\.env(?:\.|\[\s*["'])PI_[A-Z0-9_]+/.test(
					readFileSync(new URL(file, new URL("../", import.meta.url)), "utf8"),
				),
			);
		expect(offenders).toEqual([]);
	});

	test("renames the development launcher", () => {
		const repoRoot = new URL("../../../", import.meta.url);
		expect(existsSync(new URL("scripts/auto-euler.sh", repoRoot))).toBe(true);
		expect(existsSync(new URL("scripts/auto-pi.sh", repoRoot))).toBe(false);
	});
});
