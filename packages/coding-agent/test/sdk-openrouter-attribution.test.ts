import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("provider attribution headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-attribution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(provider: string, baseUrl: string, id = `${provider}-test-model`): Model<Api> {
		return {
			id,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function captureHeaders(
		model: Model<Api>,
		options: {
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
		} = {},
	): ProviderHeaders | undefined {
		const settingsManager = SettingsManager.create(cwd, agentDir);

		return mergeProviderAttributionHeaders(
			model,
			settingsManager,
			options.sessionId,
			options.providerHeaders,
			options.requestHeaders,
		);
	}

	it("does not add product attribution headers for OpenRouter models", () => {
		const headers = captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Title"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Categories"]).toBeUndefined();
	});

	it("does not add product attribution headers for custom providers routed through OpenRouter", () => {
		const headers = captureHeaders(createModel("custom-openrouter", "https://openrouter.ai/api/v1"));

		expect(headers ?? {}).toEqual({});
	});

	it("does not infer product attribution from a legacy OpenRouter URL substring", () => {
		const headers = captureHeaders(createModel("custom-openrouter", "not-a-url-openrouter.ai"));

		expect(headers ?? {}).toEqual({});
	});

	it("preserves provider and request headers", () => {
		const headers = captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: {
				"HTTP-Referer": "https://provider.example",
				"X-OpenRouter-Categories": "provider-category",
			},
			requestHeaders: {
				"X-OpenRouter-Title": "request-title",
			},
		});

		expect(headers?.["HTTP-Referer"]).toBe("https://provider.example");
		expect(headers?.["X-OpenRouter-Title"]).toBe("request-title");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("provider-category");
	});

	it("does not add product attribution headers for direct NVIDIA NIM endpoints", () => {
		const headers = captureHeaders(createModel("custom-nim", "https://integrate.api.nvidia.com/v1"));

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("does not add product attribution headers for the NVIDIA provider", () => {
		const headers = captureHeaders(createModel("nvidia", "https://example.test/v1"));

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("preserves NVIDIA NIM provider and request headers", () => {
		const headers = captureHeaders(createModel("nvidia", "https://integrate.api.nvidia.com/v1"), {
			providerHeaders: {
				"X-BILLING-INVOKE-ORIGIN": "Provider",
			},
			requestHeaders: {
				"X-BILLING-INVOKE-ORIGIN": "Request",
			},
		});

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBe("Request");
	});

	it("does not add NVIDIA NIM attribution headers for NVIDIA models routed through OpenRouter", () => {
		const headers = captureHeaders(
			createModel("openrouter", "https://openrouter.ai/api/v1", "nvidia/nemotron-3-super-120b-a12b"),
		);

		expect(headers?.["HTTP-Referer"]).toBeUndefined();
		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("does not add NVIDIA NIM attribution headers for NVIDIA models routed through Vercel AI Gateway", () => {
		const headers = captureHeaders(
			createModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", "nvidia/nemotron-3-super-120b-a12b"),
		);

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("adds OpenCode session headers", () => {
		const headers = captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(headers?.["x-opencode-session"]).toBe("opencode-session");
		expect(headers?.["x-opencode-client"]).toBe("pi");
	});

	it("lets configured OpenCode headers override the defaults", () => {
		const headers = captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
				"x-opencode-client": "configured-client",
			},
		});

		expect(headers?.["x-opencode-session"]).toBe("configured-session");
		expect(headers?.["x-opencode-client"]).toBe("configured-client");
	});
});
