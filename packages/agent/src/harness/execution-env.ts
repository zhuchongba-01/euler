import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExecutionEnv } from "./types.js";

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		try {
			const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors.
		}
		return null;
	}

	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors.
	}
	return null;
}

function getShellConfig(customShellPath?: string): { shell: string; args: string[] } {
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return { shell: candidate, args: ["-c"] };
			}
		}
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}
		throw new Error("No bash shell found");
	}

	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}
	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}
	return { shell: "sh", args: ["-c"] };
}

function getShellEnv(baseEnv?: NodeJS.ProcessEnv, extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
			signal?: AbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const { shell, args } = getShellConfig(this.shellPath);

		return await new Promise((resolvePromise, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: getShellEnv(this.shellEnv, options?.env),
				stdio: ["ignore", "pipe", "pipe"],
			});

			const timeoutId =
				typeof options?.timeout === "number"
					? setTimeout(() => {
							timedOut = true;
							if (child.pid) {
								killProcessTree(child.pid);
							}
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};
			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				options?.onStdout?.(chunk);
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				options?.onStderr?.(chunk);
			});

			child.on("error", (error) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) options.signal.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				reject(error);
			});

			child.on("close", (code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) options.signal.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				if (options?.signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timeout:${options?.timeout}`));
					return;
				}
				resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
			});
		});
	}

	async readTextFile(path: string): Promise<string> {
		return await readFile(resolvePath(this.cwd, path), "utf8");
	}

	async readBinaryFile(path: string): Promise<Uint8Array> {
		return await readFile(resolvePath(this.cwd, path));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const resolved = resolvePath(this.cwd, path);
		await mkdir(resolve(resolved, ".."), { recursive: true });
		await writeFile(resolved, content);
	}

	async stat(
		path: string,
	): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; size: number; mtime: Date }> {
		const s = await stat(resolvePath(this.cwd, path));
		return {
			isFile: s.isFile(),
			isDirectory: s.isDirectory(),
			isSymbolicLink: s.isSymbolicLink(),
			size: s.size,
			mtime: s.mtime,
		};
	}

	async listDir(path: string): Promise<string[]> {
		return await readdir(resolvePath(this.cwd, path));
	}

	async pathExists(path: string): Promise<boolean> {
		try {
			await stat(resolvePath(this.cwd, path));
			return true;
		} catch {
			return false;
		}
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await mkdir(resolvePath(this.cwd, path), { recursive: options?.recursive });
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await rm(resolvePath(this.cwd, path), { recursive: options?.recursive, force: options?.force });
	}

	async createTempDir(prefix: string = "tmp-"): Promise<string> {
		return await mkdtemp(join(tmpdir(), prefix));
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<string> {
		const dir = await this.createTempDir("tmp-");
		const filePath = join(dir, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		await writeFile(filePath, "");
		return filePath;
	}

	resolvePath(path: string): string {
		return resolvePath(this.cwd, path);
	}

	async cleanup(): Promise<void> {
		// nothing to clean up for the local node implementation
	}
}
