import { getEulerEnv } from "../euler-env.ts";

const PREFER_STRICT_TOOL_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

export function areExperimentalFeaturesEnabled(): boolean {
	return getEulerEnv("experimental") === "1";
}

export function getExperimentalToolSampling() {
	return areExperimentalFeaturesEnabled() ? PREFER_STRICT_TOOL_SAMPLING : undefined;
}
