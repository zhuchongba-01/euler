#!/usr/bin/env node
/**
 * Brand audit: user-visible Euler surfaces must not leak PI branding.
 *
 * Scans user-facing source (CLI entrypoints, interactive mode, config,
 * settings) and package metadata for PI product references. License files,
 * upstream notices, and extension-compatibility diagnostics are exempt.
 *
 * Usage: node scripts/check-euler-branding.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// User-visible product surfaces. Internal upstream compatibility code (web
// access vendor, ExtensionAPI `pi` naming) is intentionally out of scope.
const SCAN_TARGETS = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/rpc-entry.ts",
	"packages/coding-agent/src/config.ts",
	"packages/coding-agent/src/cli",
	"packages/coding-agent/src/modes",
	"packages/coding-agent/package.json",
	".github/ISSUE_TEMPLATE",
];

// Tokens that must never reach a user in Euler surfaces.
const FORBIDDEN = [/pi\.dev/gi, /\binside pi\b/gi, /π/g, /earendil-works\/pi(?:-mono)?(?=["\'\/)\s]|$)/gi, /@mariozechner\/pi-/g];

// Contexts where a forbidden token is acceptable (upstream theme schema URL).
const ALLOWED_CONTEXT = [
	/earendil-works\/pi\/main\/packages\/coding-agent\/src\/modes\/interactive\/theme\/theme-schema\.json/,
];

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

function stripComments(source) {
	// Remove block and line comments so internal notes don't fail the audit.
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

const offenders = [];

for (const target of SCAN_TARGETS) {
	const full = join(repoRoot, target);
	const files = [];
	try {
		if (statSync(full).isDirectory()) files.push(...walk(full));
		else files.push(full);
	} catch {
		offenders.push(`${target}: configured scan target is missing`);
		continue;
	}

	for (const file of files) {
		if (![".ts", ".tsx", ".json", ".md", ".html"].includes(extname(file))) continue;
		const text = extname(file) === ".json" ? readFileSync(file, "utf-8") : stripComments(readFileSync(file, "utf-8"));

		for (const pattern of FORBIDDEN) {
			pattern.lastIndex = 0;
			for (const match of text.matchAll(pattern)) {
				const contextStart = Math.max(0, match.index - 160);
				const context = text.slice(contextStart, match.index + 200);
				if (ALLOWED_CONTEXT.some((allow) => allow.test(context))) continue;
				const line = text.slice(0, match.index).split("\n").length;
				offenders.push(`${relative(repoRoot, file)}:${line}: ${JSON.stringify(match[0])}`);
			}
		}
	}
}

// Package metadata contract.
const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf-8"));
if (pkg.piConfig?.title !== "Euler" || pkg.piConfig?.configDir !== ".euler") {
	offenders.push("packages/coding-agent/package.json: piConfig must be { name: euler, title: Euler, configDir: .euler }");
}
if (JSON.stringify(pkg.bin) !== JSON.stringify({ euler: "dist/bundle/cli.js" })) {
	offenders.push("packages/coding-agent/package.json: bin must expose only euler");
}

if (offenders.length > 0) {
	console.error("Euler branding audit failed:");
	for (const offender of offenders) console.error(`  - ${offender}`);
	process.exit(1);
}

console.log("Euler branding audit passed.");
