import type { ResourceDiagnostic } from "./diagnostics.ts";

const PI_ENV_PATTERN = /\bPI_[A-Z0-9_]{2,}\b/g;
const PI_CONFIG_DIR_PATTERN = /["'`][^"'`]*\.pi(?:[/\\]|["'`])/g;

/**
 * Detect PI-specific references in third-party extension source.
 *
 * Euler never reads PI configuration, so an extension that hardcodes
 * `PI_*` variables or `.pi` paths will silently misbehave. Surface each
 * finding as an explicit compatibility warning instead.
 */
export function findPiCompatIssues(sourceText: string): string[] {
	const findings = new Set<string>();

	for (const match of sourceText.matchAll(PI_ENV_PATTERN)) {
		findings.add(match[0]);
	}

	for (const match of sourceText.matchAll(PI_CONFIG_DIR_PATTERN)) {
		findings.add(match[0].replace(/["'`]/g, ""));
	}

	return [...findings];
}

/**
 * Build a compatibility diagnostic for an extension whose source still
 * references PI-specific configuration. Returns undefined when clean.
 */
export function createPiCompatDiagnostic(extensionPath: string, sourceText: string): ResourceDiagnostic | undefined {
	const findings = findPiCompatIssues(sourceText);
	if (findings.length === 0) return undefined;

	return {
		type: "warning",
		message:
			`Extension references PI configuration (${findings.join(", ")}). ` +
			"Euler does not read PI configuration or ~/.pi; update the extension to use " +
			"Euler paths (~/.euler/agent) and EULER_* environment variables.",
		path: extensionPath,
	};
}
