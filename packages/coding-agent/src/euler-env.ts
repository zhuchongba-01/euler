/** Euler-owned environment variable names. Provider credentials remain external. */
export const EULER_ENV = {
	agentDir: "EULER_CODING_AGENT_DIR",
	sessionDir: "EULER_CODING_AGENT_SESSION_DIR",
	packageDir: "EULER_PACKAGE_DIR",
	offline: "EULER_OFFLINE",
	skipVersionCheck: "EULER_SKIP_VERSION_CHECK",
	releasesApiUrl: "EULER_RELEASES_API_URL",
	shareViewerUrl: "EULER_SHARE_VIEWER_URL",
	managedInstallRoot: "EULER_MANAGED_INSTALL_ROOT",
	installerApiBase: "EULER_INSTALLER_API_BASE",
	startupBenchmark: "EULER_STARTUP_BENCHMARK",
	experimental: "EULER_EXPERIMENTAL",
	clipboard: "EULER_CLIPBOARD",
	clearOnShrink: "EULER_CLEAR_ON_SHRINK",
	hardwareCursor: "EULER_HARDWARE_CURSOR",
	timing: "EULER_TIMING",
	codingAgent: "EULER_CODING_AGENT",
	sessionId: "EULER_SESSION_ID",
	sessionFile: "EULER_SESSION_FILE",
	provider: "EULER_PROVIDER",
	model: "EULER_MODEL",
	reasoningLevel: "EULER_REASONING_LEVEL",
} as const;

const LEGACY_SESSION_ENV = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

export type EulerEnvKey = keyof typeof EULER_ENV;

export function getEulerEnv(key: EulerEnvKey, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[EULER_ENV[key]] || undefined;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isEulerEnvFlagEnabled(key: EulerEnvKey, env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(getEulerEnv(key, env));
}

/** Prevent stale PI session metadata from masquerading as the active Euler session. */
export function stripLegacySessionEnv(env: NodeJS.ProcessEnv): void {
	for (const name of LEGACY_SESSION_ENV) delete env[name];
}
