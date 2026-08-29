import { homedir } from "node:os";
import { join } from "node:path";

export const EULER_WEB_ACCESS_TOOL_NAMES = [
	"web_search",
	"fetch_content",
	"get_search_content",
	"source_check",
] as const;

export const EULER_WEB_ACCESS_COMMAND_NAMES = ["websearch", "curator", "search"] as const;
export const EULER_DEFAULT_SEARCH_PROVIDERS = ["exa", "duckduckgo"] as const;
export const EULER_DEFAULT_WEB_SEARCH_WORKFLOW = "auto-summary" as const;

type EulerEnvironment = Readonly<Record<string, string | undefined>>;
type EulerSearchOrigin = "automatic-search" | "curator-command" | "websearch-command";

export function getEulerWebSearchConfigDir(env: EulerEnvironment = process.env, home = homedir()): string {
	return env.EULER_CODING_AGENT_DIR || join(home, ".euler", "agent");
}

export function getEulerWebSearchConfigPath(env: EulerEnvironment = process.env, home = homedir()): string {
	return join(getEulerWebSearchConfigDir(env, home), "web-search.json");
}

export function isEulerOffline(env: EulerEnvironment = process.env): boolean {
	const value = env.EULER_OFFLINE?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function resolveEulerWebSearchWorkflow(value: unknown): "none" | "summary-review" | "auto-summary" {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "none" || normalized === "summary-review" || normalized === "auto-summary") {
		return normalized;
	}
	return EULER_DEFAULT_WEB_SEARCH_WORKFLOW;
}

export function shouldOpenEulerCuratorBrowser(origin: EulerSearchOrigin): boolean {
	return origin === "websearch-command";
}

export function createEulerOfflineResult(toolName: string): {
	content: Array<{ type: "text"; text: string }>;
	details: { error: "offline"; tool: string };
	isError: true;
} {
	return {
		content: [{ type: "text", text: `${toolName} is unavailable because EULER_OFFLINE is enabled.` }],
		details: { error: "offline", tool: toolName },
		isError: true,
	};
}

export async function executeUnlessEulerOffline<T>(
	toolName: string,
	env: EulerEnvironment,
	execute: () => Promise<T>,
): Promise<
	| T
	| {
			content: Array<{ type: "text"; text: string }>;
			details: { error: "offline"; tool: string };
			isError: true;
	  }
> {
	if (!isEulerOffline(env)) return execute();
	return createEulerOfflineResult(toolName);
}

export async function runEulerSearchRoute<T>(
	requestedProvider: string,
	search: (provider: string) => Promise<T>,
): Promise<T> {
	if (requestedProvider !== "auto") return search(requestedProvider);

	const errors: string[] = [];
	for (const provider of EULER_DEFAULT_SEARCH_PROVIDERS) {
		try {
			return await search(provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.toLowerCase().includes("abort")) throw error;
			errors.push(`${provider === "exa" ? "Exa MCP" : "DuckDuckGo"}: ${message}`);
		}
	}
	throw new Error(`Euler free search route failed:\n  - ${errors.join("\n  - ")}`);
}
