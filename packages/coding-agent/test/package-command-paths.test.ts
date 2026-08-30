import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { main } from "../src/main.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalPath: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	function prepareManagedInstall(
		targetVersion: string,
		npmExitCode = 0,
	): { managedRoot: string; npmRecordPath: string } {
		const managedRoot = join(agentDir, "install");
		const activeRelease = join(managedRoot, "releases", VERSION);
		const selfPackageDir = join(activeRelease, "node_modules", ...PACKAGE_NAME.split("/"));
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(join(activeRelease, "active.txt"), "active");
		writeFileSync(join(managedRoot, "current-version"), `${VERSION}\n`);
		writeFileSync(
			join(managedRoot, "managed-install.json"),
			`${JSON.stringify({ kind: "euler-managed-install", schemaVersion: 1, layout: "releases-v1" })}\n`,
		);

		const binDir = join(tempDir, "managed-bin");
		const fakeNpmPath = join(tempDir, "managed-npm.cjs");
		const npmRecordPath = join(tempDir, "managed-npm-record.json");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(npmRecordPath)}, JSON.stringify(args));
if (${npmExitCode} !== 0) process.exit(${npmExitCode});
const binDir = path.join(process.cwd(), "node_modules", ".bin");
fs.mkdirSync(binDir, { recursive: true });
const piPath = path.join(binDir, process.platform === "win32" ? "euler.cmd" : "euler");
fs.writeFileSync(
	piPath,
	process.platform === "win32"
		? "@echo off\\r\\necho ${targetVersion}\\r\\n"
		: "#!/bin/sh\\nprintf '%s\\n' ${targetVersion}\\n",
);
if (process.platform !== "win32") fs.chmodSync(piPath, 0o755);
`,
		);
		const npmPath = join(binDir, process.platform === "win32" ? "npm.cmd" : "npm");
		writeFileSync(
			npmPath,
			process.platform === "win32"
				? `@echo off\r\n"${originalExecPath}" "${fakeNpmPath}" %*\r\n`
				: `#!/bin/sh\nexec "${originalExecPath}" "${fakeNpmPath}" "$@"\n`,
		);
		chmodSync(npmPath, 0o755);

		vi.stubEnv("EULER_INSTALLER_API_BASE", "https://example.test/api/installer/releases");
		vi.stubEnv("EULER_MANAGED_INSTALL_ROOT", managedRoot);
		process.env.EULER_PACKAGE_DIR = selfPackageDir;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		return { managedRoot, npmRecordPath };
	}

	function mockManagedUpdate(targetVersion: string): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === "https://api.github.com/repos/euler-agent/euler/releases/latest") {
					return Response.json({ tag_name: `v${targetVersion}` });
				}
				const releaseUrl = `https://example.test/api/installer/releases/${targetVersion}`;
				if (url === `${releaseUrl}/package.json` || url === `${releaseUrl}/package-lock.json`) {
					return Response.json({});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	}

	async function runPackageCommandDirectly(args: string[]): Promise<void> {
		expect(await handlePackageCommand(args)).toBe(true);
	}

	function extensionPaths(
		packageRoot: string,
		source: string,
		scope: "user" | "project",
		names: string[],
	): ResolvedPaths {
		return {
			extensions: names.map((name) => ({
				path: join(packageRoot, "extensions", name),
				enabled: true,
				metadata: { source, scope, origin: "package", baseDir: packageRoot },
			})),
			skills: [],
			prompts: [],
			themes: [],
		};
	}

	beforeEach(() => {
		allowNetwork();
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.EULER_PACKAGE_DIR;
		originalPath = process.env.PATH;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			if (code === undefined || code === null || Number(code) === 0) {
				process.exitCode = undefined;
			} else {
				process.exitCode = code;
			}
			return undefined as never;
		}) as typeof process.exit);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPiPackageDir === undefined) {
			delete process.env.EULER_PACKAGE_DIR;
		} else {
			process.env.EULER_PACKAGE_DIR = originalPiPackageDir;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("skips untrusted project package settings", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses remembered project trust for list", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("overrides remembered trust for list with --no-approve", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("approves project trust for list with --approve", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses default project trust for list", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses project_trust extensions for package commands", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["list"], {
					extensionFactories: [
						(euler) => {
							euler.on("project_trust", () => ({ trusted: "yes" }));
						},
					],
				}),
			).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not prompt or ask extensions for project trust during update", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const fakeNpmPath = join(tempDir, "fake-project-npm.cjs");
		const recordPath = join(tempDir, "project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".euler", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		let projectTrustCalled = false;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["update", "--extensions"], {
					extensionFactories: [
						(euler) => {
							euler.on("project_trust", () => {
								projectTrustCalled = true;
								return { trusted: "yes" };
							});
						},
					],
				}),
			).resolves.toBeUndefined();

			expect(projectTrustCalled).toBe(false);
			expect(existsSync(recordPath)).toBe(false);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses saved project trust during update", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		const fakeNpmPath = join(tempDir, "fake-trusted-project-npm.cjs");
		const recordPath = join(tempDir, "trusted-project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".euler", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--extensions"])).resolves.toBeUndefined();

			expect(existsSync(recordPath)).toBe(true);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lets trust.json override default project trust", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".euler", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("blocks local package changes when project is untrusted", async () => {
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(join(projectDir, ".euler", "settings.json"), "{}");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "-l", "./local-package"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted. Use --approve to modify local package config.");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows local package install to initialize fresh project settings", async () => {
		await main(["install", "-l", packageDir]);

		const settingsPath = join(projectDir, ".euler", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		expect(realpathSync(join(projectDir, ".euler", stored))).toBe(realpathSync(packageDir));
		expect(process.exitCode).toBeUndefined();
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("euler install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refreshes only model catalogs with update --models", async () => {
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({ refresh } as unknown as ModelRuntime);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--models"])).resolves.toBeUndefined();

		expect(create).toHaveBeenCalledWith({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: expect.any(AbortSignal),
		});
		expect(refresh).toHaveBeenCalledWith({
			allowNetwork: true,
			force: true,
			signal: expect.any(AbortSignal),
		});
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Model catalogs refreshed");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("rejects update --models combined with another update target", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--models", "--self"])).resolves.toBeUndefined();

		expect(create).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"--models cannot be combined with --self",
		);
		expect(process.exitCode).toBe(1);
	});

	it("cycles project package overrides in config local mode", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ packages: ["npm:pi-tools"] }));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		const resolvedPaths = extensionPaths(join(tempDir, "pkg"), "npm:pi-tools", "user", ["bar.ts"]);
		const selector = new ConfigSelectorComponent(
			{ global: resolvedPaths, project: resolvedPaths },
			settingsManager,
			projectDir,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
			"project",
		);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["-extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["+extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "euler --help" or "euler install <source> [-l] [--approve|--no-approve]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: euler install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows explicit self-update checks when automatic version checks are disabled", async () => {
		const previousSkipVersionCheck = process.env.EULER_SKIP_VERSION_CHECK;
		process.env.EULER_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ tag_name: `v${VERSION}` }));
		vi.stubGlobal("fetch", fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(fetchMock).toHaveBeenCalledOnce();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				`euler is already up to date (v${VERSION})`,
			);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			if (previousSkipVersionCheck === undefined) {
				delete process.env.EULER_SKIP_VERSION_CHECK;
			} else {
				process.env.EULER_SKIP_VERSION_CHECK = previousSkipVersionCheck;
			}
		}
	});

	it("retries a transient self-update version check", async () => {
		const previousSkipVersionCheck = process.env.EULER_SKIP_VERSION_CHECK;
		delete process.env.EULER_SKIP_VERSION_CHECK;
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ tag_name: `v${VERSION}` }));
		vi.stubGlobal("fetch", fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			if (previousSkipVersionCheck === undefined) delete process.env.EULER_SKIP_VERSION_CHECK;
			else process.env.EULER_SKIP_VERSION_CHECK = previousSkipVersionCheck;
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("gates managed self-update until release artifacts are configured", async () => {
		const targetVersion = getNewerPatchVersion();
		const { managedRoot, npmRecordPath } = prepareManagedInstall(targetVersion);
		mockManagedUpdate(targetVersion);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

		expect(readFileSync(join(managedRoot, "current-version"), "utf8")).toBe(`${VERSION}
`);
		expect(existsSync(join(managedRoot, "releases", targetVersion))).toBe(false);
		expect(existsSync(npmRecordPath)).toBe(false);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"euler self-update is unavailable until Euler release artifacts are configured.",
		);
		expect(process.exitCode).toBe(1);
	});

	it("gates managed self-update before the concurrent-update lock", async () => {
		const targetVersion = getNewerPatchVersion();
		const { managedRoot } = prepareManagedInstall(targetVersion);
		const releaseLock = await lockfile.lock(join(managedRoot, "update"), { realpath: false });
		mockManagedUpdate(targetVersion);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();
		} finally {
			await releaseLock();
		}

		expect(readFileSync(join(managedRoot, "current-version"), "utf8")).toBe(`${VERSION}
`);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"euler self-update is unavailable until Euler release artifacts are configured.",
		);
		expect(process.exitCode).toBe(1);
	});

	it("rejects forced managed reinstalls", async () => {
		const targetVersion = getNewerPatchVersion();
		const { npmRecordPath } = prepareManagedInstall(targetVersion);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--self", "--force"])).resolves.toBeUndefined();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(npmRecordPath)).toBe(false);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Managed euler installations do not support --force",
		);
		expect(process.exitCode).toBe(1);
	});

	it("leaves the managed install untouched when self-update is gated", async () => {
		const targetVersion = getNewerPatchVersion();
		const { managedRoot } = prepareManagedInstall(targetVersion, 23);
		mockManagedUpdate(targetVersion);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

		expect(readFileSync(join(managedRoot, "current-version"), "utf8")).toBe(`${VERSION}
`);
		expect(existsSync(join(managedRoot, "releases", targetVersion))).toBe(false);
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"euler self-update is unavailable until Euler release artifacts are configured.",
		);
	});

	it("gates forced npm self-updates even when the managed environment is inherited", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "euler-agent");
		const inheritedManagedRoot = join(tempDir, "inherited-managed-install");
		mkdirSync(join(inheritedManagedRoot, "releases"), { recursive: true });
		writeFileSync(
			join(inheritedManagedRoot, "managed-install.json"),
			JSON.stringify({ kind: "euler-managed-install", schemaVersion: 1, layout: "releases-v1" }),
		);
		vi.stubEnv("EULER_MANAGED_INSTALL_ROOT", inheritedManagedRoot);
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(join(projectDir, ".euler"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		writeFileSync(
			join(projectDir, ".euler", "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix] }, null, 2),
		);
		process.env.EULER_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json({ tag_name: `v${VERSION}` }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self", "--force"])).resolves.toBeUndefined();

			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"euler self-update is unavailable until Euler release artifacts are configured.",
			);
			expect(process.exitCode).toBe(1);
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("reports up-to-date for a same-version GitHub release without installer APIs", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "euler-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.EULER_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json({ tag_name: `v${VERSION}` }));
		vi.stubGlobal("fetch", fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(fetchMock).toHaveBeenCalledOnce();
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain(`euler is already up to date (v${VERSION})`);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("gates self-update without touching npm when a newer release exists", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "euler-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.EULER_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json({ tag_name: `v${getNewerPatchVersion()}` }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"euler self-update is unavailable until Euler release artifacts are configured.",
			);
			expect(process.exitCode).toBe(1);
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("gates pnpm self-updates instead of invoking the package manager", async () => {
		const targetVersion = getNewerPatchVersion();
		const fetchMock = vi.fn(async () => Response.json({ tag_name: `v${targetVersion}` }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(fetchMock).toHaveBeenCalledOnce();
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"euler self-update is unavailable until Euler release artifacts are configured.",
			);
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("gates renamed-package self-updates instead of reinstalling", async () => {
		const targetVersion = getNewerPatchVersion();
		const fetchMock = vi.fn(async () => Response.json({ tag_name: `v${targetVersion}` }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(fetchMock).toHaveBeenCalledOnce();
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"euler self-update is unavailable until Euler release artifacts are configured.",
			);
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
