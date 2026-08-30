import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const releaseDirectories = [
	"packages/telemetry",
	"packages/ai",
	"packages/tui",
	"packages/agent",
	"packages/protocol",
	"packages/client",
	"packages/session-backends/sqlite-node",
	"packages/server",
	"packages/coding-agent",
];

export function getPublicWorkspacePackages() {
	const packagesByDirectory = new Map(
		findPackageDirectories()
		.map((directory) => ({
			directory: directory.replaceAll("\\", "/"),
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => [directory, { directory, name, version }]),
	);

	const unexpectedDirectories = [...packagesByDirectory.keys()].filter((directory) => !releaseDirectories.includes(directory));
	if (unexpectedDirectories.length > 0) {
		throw new Error(`Public workspace packages must be added to release order: ${unexpectedDirectories.join(", ")}`);
	}

	return releaseDirectories.map((directory) => {
		const pkg = packagesByDirectory.get(directory);
		if (!pkg) {
			throw new Error(`Missing public workspace package in release order: ${directory}`);
		}
		return pkg;
	});
}
