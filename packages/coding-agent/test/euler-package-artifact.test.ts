/**
 * Euler build artifact guarantees.
 *
 * Verifies:
 * - The published npm package exposes only the `euler` bin and ships the
 *   runtime files needed for a working install (bundle, prompts, shrinkwrap).
 * - The standalone binary build produces `euler`-named binaries and archives.
 * - The release workflow publishes Euler-named assets, always gates on the
 *   Windows x64 smoke test, and lets non-Windows platforms fail without
 *   blocking the release.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("euler npm package", () => {
	it("exposes only the euler bin with Euler config branding", () => {
		const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));

		expect(pkg.bin).toEqual({ euler: "dist/bundle/cli.js" });
		expect(pkg.piConfig).toMatchObject({ name: "euler", title: "Euler", configDir: ".euler" });
		expect(Object.keys(pkg.bin)).not.toContain("pi");
	});

	it("packs the runtime files needed for a working install", () => {
		// The tarball cannot list dist files that only exist after a build; CI
		// builds before testing, so skip fresh checkouts without dist.
		const cliBundle = join(packageDir, "dist", "bundle", "cli.js");
		if (!existsSync(cliBundle)) {
			console.warn("Skipping npm pack assertion: dist has not been built yet.");
			return;
		}

		const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: packageDir,
			encoding: "utf-8",
			shell: process.platform === "win32",
		});
		const pack = JSON.parse(output).at(-1);

		expect(pack.name).toBe("@earendil-works/pi-coding-agent");
		const files = pack.files.map((entry: { path: string }) => entry.path);
		expect(files).toContain("dist/bundle/cli.js");
		expect(files).toContain("npm-shrinkwrap.json");
		expect(files).toContain("CHANGELOG.md");
		expect(files).toContain("dist/LICENSE");
		expect(files.some((path: string) => path.includes("euler-system.md"))).toBe(true);
		expect(files.some((path: string) => path.startsWith("pi/") || path.includes("/pi/"))).toBe(false);
	});
});

describe("standalone binary build", () => {
	it("produces euler-named binaries and archives", () => {
		const script = readFileSync(join(packageDir, "..", "..", "scripts", "build-binaries.sh"), "utf-8");

		expect(script).toContain("$OUTPUT_DIR/$platform/euler.exe");
		expect(script).toContain('--outfile "$OUTPUT_DIR/$platform/euler"');
		expect(script).toContain("euler-$platform.zip");
		expect(script).toContain("euler-$platform.tar.gz");
		expect(script).not.toMatch(/\bpi\.exe\b/);
		expect(script).not.toMatch(/pi-\$platform/);
		expect(script).not.toContain('mv "$platform" pi');
	});
});

describe("release workflow", () => {
	const workflowPath = join(packageDir, "..", "..", ".github", "workflows", "build-binaries.yml");

	function readWorkflow(): string {
		return readFileSync(workflowPath, "utf-8");
	}

	it("publishes only Euler-named release assets", () => {
		const workflow = readWorkflow();

		expect(workflow).toContain(`euler-\${VERSION}-source.tar.gz`);
		expect(workflow).toContain("euler-windows-x64.zip");
		expect(workflow).toContain("euler-install-package.json");
		expect(workflow).not.toMatch(/pi-\$\{VERSION\}/);
		expect(workflow).not.toMatch(/\bpi-windows-x64\.zip\b/);
		expect(workflow).not.toMatch(/\bpi-coding-agent\b/);
	});

	it("gates the release on the Windows x64 smoke test only", () => {
		const workflow = readWorkflow();

		// Windows must never be allowed to fail silently.
		expect(workflow).toMatch(/runner:\s*windows-latest\s*\n\s*allow_failure:\s*false/);
		// Non-Windows runners are best-effort for the first release.
		expect(workflow).toMatch(/runner:\s*ubuntu-latest\s*\n\s*allow_failure:\s*true/);
		expect(workflow).toMatch(/runner:\s*macos-latest\s*\n\s*allow_failure:\s*true/);
		expect(workflow).toMatch(/continue-on-error:\s*\$\{\{ matrix\.allow_failure \}\}/);
		// The staging job hard-requires the Windows smoke result marker.
		expect(workflow).toContain("smoke-ok-windows-x64");
	});
});
