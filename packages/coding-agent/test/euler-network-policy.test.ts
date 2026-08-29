import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isInstallTelemetryEnabled } from "../src/core/telemetry.ts";

const testRoot = join(process.cwd(), "test-euler-network-policy-tmp");

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

describe("Euler telemetry policy", () => {
	it("keeps product telemetry disabled even with legacy settings or an explicit argument", () => {
		const agentDir = join(testRoot, "agent");
		const projectDir = join(testRoot, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: true }));
		const settingsManager = SettingsManager.create(projectDir, agentDir);

		expect(isInstallTelemetryEnabled(settingsManager)).toBe(false);
		expect(isInstallTelemetryEnabled(settingsManager, "1")).toBe(false);
	});

	it("has no report-install request or install telemetry setting in runtime source", () => {
		const files = [
			"../src/core/settings-manager.ts",
			"../src/modes/interactive/interactive-mode.ts",
			"../src/modes/interactive/components/settings-selector.ts",
			"../src/package-manager-cli.ts",
		].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
		const source = files.join("\n");

		expect(source).not.toContain("report-install");
		expect(source).not.toContain("enableInstallTelemetry");
		expect(source).not.toContain("Install telemetry");
		expect(source).not.toContain("pi.dev/api/installer");
		expect(source).toContain("self-update is unavailable until Euler release artifacts are configured");
	});
});
