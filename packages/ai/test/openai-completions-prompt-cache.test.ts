import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions prompt caching", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		mockState.lastParams = undefined;
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_CACHE_RETENTION;
		} else {
			process.env.PI_CACHE_RETENTION = originalEnv;
		}
	});

	async function capturePayload(options?: { cacheRetention?: "none" | "short" | "long"; sessionId?: string }) {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamOpenAICompletions(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", ...options },
		).result();

		return mockState.lastParams as { prompt_cache_key?: string; prompt_cache_retention?: "24h" | "in-memory" | null };
	}

	it("sets prompt_cache_key for direct OpenAI requests when caching is enabled", async () => {
		const payload = await capturePayload({ sessionId: "session-123" });

		expect(payload.prompt_cache_key).toBe("session-123");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("sets prompt_cache_retention to 24h for direct OpenAI requests when cacheRetention is long", async () => {
		const payload = await capturePayload({ cacheRetention: "long", sessionId: "session-456" });

		expect(payload.prompt_cache_key).toBe("session-456");
		expect(payload.prompt_cache_retention).toBe("24h");
	});

	it("omits prompt cache fields when cacheRetention is none", async () => {
		const payload = await capturePayload({ cacheRetention: "none", sessionId: "session-789" });

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt cache fields for non-OpenAI base URLs", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model = {
			...baseModel,
			api: "openai-completions",
			baseUrl: "https://proxy.example.com/v1",
		} as const;

		await streamOpenAICompletions(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", cacheRetention: "long", sessionId: "session-proxy" },
		).result();

		const payload = mockState.lastParams as {
			prompt_cache_key?: string;
			prompt_cache_retention?: "24h" | "in-memory" | null;
		};

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("uses PI_CACHE_RETENTION for direct OpenAI requests", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const payload = await capturePayload({ sessionId: "session-env" });

		expect(payload.prompt_cache_key).toBe("session-env");
		expect(payload.prompt_cache_retention).toBe("24h");
	});
});
