import type { SettingsManager } from "./settings-manager.ts";

/** Product telemetry is disabled in Euler. Kept as a no-op compatibility boundary. */
export function isInstallTelemetryEnabled(_settingsManager: SettingsManager, _telemetryEnv?: string): false {
	return false;
}
