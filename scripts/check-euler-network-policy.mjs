#!/usr/bin/env node
/**
 * Network policy audit: Euler must not ship telemetry or call PI services.
 *
 * Static checks over runtime source and release configuration:
 * - No install/usage telemetry call sites or settings.
 * - Version checks only target the public npm package metadata endpoint.
 * - The default search route is Exa MCP -> DuckDuckGo with no paid provider.
 * - The provider-catalog overlay is opt-in (no default PI catalog endpoint).
 * - CI release flow has no PI installer announcement or R2 secrets.
 *
 * Usage: node scripts/check-euler-network-policy.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const offenders = [];

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full);
		} else {
			yield full;
		}
	}
}

function forbidToken(relPath, text, pattern, reason) {
	for (const match of text.matchAll(pattern)) {
		const line = text.slice(0, match.index).split("\n").length;
		offenders.push(`${relPath}:${line}: ${JSON.stringify(match[0])} (${reason})`);
	}
}

// 1. Telemetry must not exist anywhere in runtime source or release config.
const srcRoot = join(repoRoot, "packages/coding-agent/src");
for (const file of walk(srcRoot)) {
	const text = readFileSync(file, "utf-8");
	forbidToken(relative(repoRoot, file), text, /pi\.dev/gi, "PI service reference");
	forbidToken(relative(repoRoot, file), text, /report-install/g, "install telemetry call");
	forbidToken(relative(repoRoot, file), text, /enableInstallTelemetry/g, "telemetry setting");
	forbidToken(relative(repoRoot, file), text, /PI_TELEMETRY/g, "PI telemetry env");
}
for (const workflow of ["build-binaries.yml", "ci.yml", "publish-model-catalog.yml"]) {
	const path = join(repoRoot, ".github/workflows", workflow);
	try {
		const text = readFileSync(path, "utf-8");
		forbidToken(relative(repoRoot, path), text, /pi\.dev/gi, "PI service reference");
		forbidToken(relative(repoRoot, path), text, /PI_ARTIFACTS_R2/g, "PI R2 secret");
		forbidToken(relative(repoRoot, path), text, /pi-artifacts/g, "PI R2 bucket");
		forbidToken(relative(repoRoot, path), text, /pi-model-upload/g, "PI R2 environment");
		forbidToken(relative(repoRoot, path), text, /announce-pi-dev/g, "PI announcement job");
	} catch {
		offenders.push(`.github/workflows/${workflow}: missing`);
	}
}

// 2. Telemetry stays a hard-wired no-op.
const telemetry = readFileSync(join(repoRoot, "packages/coding-agent/src/core/telemetry.ts"), "utf-8");
if (!/return false;/.test(telemetry)) {
	offenders.push("packages/coding-agent/src/core/telemetry.ts: isInstallTelemetryEnabled must return literal false");
}

// 3. Version checks target only the public Euler npm metadata endpoint without a body.
const versionCheck = readFileSync(join(repoRoot, "packages/coding-agent/src/utils/version-check.ts"), "utf-8");
const versionUrl = versionCheck.match(/DEFAULT_RELEASES_API_URL\s*=\s*"([^"]+)"/);
if (!versionUrl) {
	offenders.push("version-check.ts: DEFAULT_RELEASES_API_URL is missing");
} else {
	const url = new URL(versionUrl[1]);
	if (url.hostname !== "registry.npmjs.org" || url.pathname !== "/euler-agent/latest") {
		offenders.push(`version-check.ts: unexpected release API endpoint ${versionUrl[1]}`);
	}
}
forbidToken("version-check.ts", versionCheck, /deviceId|machineId|sessionId|"user"|installationId/g, "identity in version check");

// 4. Default search route: free providers only, locked order.
const eulerConfig = readFileSync(join(repoRoot, "packages/coding-agent/src/extensions/web-access/euler-config.ts"), "utf-8");
const providers = eulerConfig.match(/EULER_DEFAULT_SEARCH_PROVIDERS\s*=\s*\[([^\]]+)\]/);
if (!providers || providers[1].replace(/["'\s]/g, "") !== "exa,duckduckgo") {
	offenders.push("euler-config.ts: EULER_DEFAULT_SEARCH_PROVIDERS must be exactly [exa, duckduckgo]");
}
const workflow = eulerConfig.match(/EULER_DEFAULT_WEB_SEARCH_WORKFLOW\s*=\s*"([^"]+)"/);
if (!workflow || workflow[1] !== "auto-summary") {
	offenders.push('euler-config.ts: EULER_DEFAULT_WEB_SEARCH_WORKFLOW must be "auto-summary"');
}

// 5. Provider-catalog overlay is opt-in: no default remote endpoint in runtime.
const catalogProvider = readFileSync(
	join(repoRoot, "packages/coding-agent/src/core/remote-catalog-provider.ts"),
	"utf-8",
);
forbidToken("remote-catalog-provider.ts", catalogProvider, /DEFAULT_CATALOG_BASE_URL/g, "default remote catalog endpoint");
const modelRuntime = readFileSync(join(repoRoot, "packages/coding-agent/src/core/model-runtime.ts"), "utf-8");
if (!/options\.catalogBaseUrl\s*&&/.test(modelRuntime)) {
	offenders.push("model-runtime.ts: remote catalog overlay must be gated on an explicitly configured base URL");
}

// 6. Runtime source must not read PI_* environment variables.
for (const file of walk(srcRoot)) {
	if (file.includes(`${srcRoot}\\extensions\\web-access`) || file.includes(`${srcRoot}/extensions/web-access`)) continue;
	const text = readFileSync(file, "utf-8");
	forbidToken(relative(repoRoot, file), text, /process\.env\.PI_[A-Z0-9_]+/g, "PI env read");
}

if (offenders.length > 0) {
	console.error("Euler network policy audit failed:");
	for (const offender of offenders) console.error(`  - ${offender}`);
	process.exit(1);
}

console.log("Euler network policy audit passed.");
