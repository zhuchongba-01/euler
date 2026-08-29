/**
 * E2E: network audit.
 *
 * Verifies offline and normal starts make no requests beyond the (skippable)
 * Release query: CLI subprocesses run with proxy env vars pointed at an
 * unreachable local port, so any attempted egress fails fast and loudly.
 * The shipped bundle is also scanned for telemetry call sites.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = join(import.meta.dirname, "..", "..");
const cliPath = join(packageDir, "dist", "bundle", "cli.js");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Reserve a free port and immediately close the listener: egress to it must fail. */
async function reserveDeadPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

describe.skipIf(!existsSync(cliPath))("euler network audit e2e", () => {
	async function deadProxyEnv(extra: Record<string, string> = {}): Promise<Record<string, string>> {
		const port = await reserveDeadPort();
		const home = mkdtempSync(join(tmpdir(), "euler-net-audit-"));
		tempDirs.push(home);
		const proxy = `http://127.0.0.1:${port}`;
		return {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			EULER_CODING_AGENT_DIR: join(home, ".euler", "agent"),
			HTTP_PROXY: proxy,
			HTTPS_PROXY: proxy,
			http_proxy: proxy,
			https_proxy: proxy,
			ALL_PROXY: proxy,
			NO_PROXY: "",
			...extra,
		};
	}

	it("starts help with a dead proxy (no egress attempted)", async () => {
		const result = spawnSync(process.execPath, [cliPath, "--help"], {
			encoding: "utf-8",
			env: await deadProxyEnv(),
			timeout: 90_000,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("euler");
	});

	it("starts version offline without network errors", async () => {
		const result = spawnSync(process.execPath, [cliPath, "--version"], {
			encoding: "utf-8",
			env: await deadProxyEnv({ EULER_OFFLINE: "1" }),
			timeout: 90_000,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/);
	});

	it("ships a bundle without telemetry call sites", () => {
		const bundleDir = join(packageDir, "dist", "bundle");
		if (!existsSync(bundleDir)) {
			console.warn("Skipping bundle audit: dist/bundle has not been built yet.");
			return;
		}

		const forbidden = [/report-install/, /enableInstallTelemetry/, /pi\.dev\/api\/latest-version/i];
		const offenders: string[] = [];
		for (const file of readdirRecursive(bundleDir)) {
			if (statSync(file).size > 20 * 1024 * 1024) continue;
			const text = readFileSync(file, "utf-8");
			for (const pattern of forbidden) {
				if (pattern.test(text)) offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});

function* readdirRecursive(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) yield* readdirRecursive(full);
		else yield full;
	}
}
