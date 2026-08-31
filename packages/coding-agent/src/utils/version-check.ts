import { compare, valid } from "semver";
import { getEulerEnv } from "../euler-env.ts";
import { fetchWithRetry } from "./management-http.ts";

const DEFAULT_RELEASES_API_URL = "https://registry.npmjs.org/euler-agent/latest";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface VersionCheckOptions {
	timeoutMs?: number;
	retry?: boolean;
	releaseApiUrl?: string;
}

export interface LatestPiRelease {
	version: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

function resolveReleaseApiUrl(configuredUrl: string | undefined): string | undefined {
	try {
		const url = new URL(configuredUrl || DEFAULT_RELEASES_API_URL);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "registry.npmjs.org" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return undefined;
		}
		if (url.pathname !== "/euler-agent/latest") {
			return undefined;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

export async function getLatestPiRelease(
	_currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<LatestPiRelease | undefined> {
	if (getEulerEnv("offline")) return undefined;
	const releaseApiUrl = resolveReleaseApiUrl(options.releaseApiUrl || getEulerEnv("releasesApiUrl"));
	if (!releaseApiUrl) return undefined;

	try {
		const response = await fetchWithRetry(
			releaseApiUrl,
			{
				headers: { accept: "application/json" },
			},
			{
				maxRetries: options.retry ? 2 : 0,
				timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
			},
		);
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: unknown };
		if (typeof data.version !== "string") return undefined;
		const version = data.version.trim();
		if (!valid(version)) return undefined;
		return { version };
	} catch {
		return undefined;
	}
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (getEulerEnv("skipVersionCheck")) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
