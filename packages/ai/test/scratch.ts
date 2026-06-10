// Scratch script showing real-world use of the new Models API.
// Run from packages/ai: node test/scratch.ts
// Requires ANTHROPIC_API_KEY.

import { anthropicMessagesApi } from "../src/api/anthropic-messages.lazy.ts";
import { createModels, getModels, type Provider } from "../src/models.ts";
import type { Context } from "../src/types.ts";

const anthropicApi = anthropicMessagesApi();

// ---------------------------------------------------------------------------
// 1. Define a provider. In the final design this comes from
//    `@earendil-works/pi-ai/providers/anthropic` as `anthropicProvider()`;
//    until Phase 3 lands we wire it by hand from existing parts.
// ---------------------------------------------------------------------------

const anthropic: Provider<"anthropic-messages"> = {
	id: "anthropic",
	name: "Anthropic",
	baseUrl: "https://api.anthropic.com/v1",

	auth: {
		apiKey: {
			name: "Anthropic API key",
			resolve: async ({ ctx, credential }) => {
				// stored credential (from a /login flow) wins, env is the ambient fallback
				const key = credential?.key ?? (await ctx.env("ANTHROPIC_API_KEY"));
				if (!key) return undefined;
				return { auth: { apiKey: key }, source: credential ? "stored credential" : "ANTHROPIC_API_KEY" };
			},
		},
	},

	// static catalog source; a dynamic provider would fetch here
	getModels: async () => getModels("anthropic"),

	// shared lazy API implementation (loads the SDK on first request)
	stream: anthropicApi.stream,
	streamSimple: anthropicApi.streamSimple,
};

// ---------------------------------------------------------------------------
// 2. Build a Models runtime and register the provider.
// ---------------------------------------------------------------------------

const models = createModels();
models.setProvider(anthropic);

// ---------------------------------------------------------------------------
// 3. Look up a model and check auth.
// ---------------------------------------------------------------------------

const model = await models.getModel("anthropic", "claude-haiku-4-5");
if (!model) throw new Error("model not found");

const auth = await models.getAuth(model);
console.log(`model: ${model.provider}/${model.id}`);
console.log(`auth:  ${auth ? `configured via ${auth.source}` : "not configured"}\n`);
if (!auth) process.exit(1);

const context: Context = {
	systemPrompt: "You are terse.",
	messages: [{ role: "user", content: "Say exactly: ok", timestamp: Date.now() }],
};

// ---------------------------------------------------------------------------
// 4. Simple completion (request-level auth resolution happens inside).
// ---------------------------------------------------------------------------

const message = await models.completeSimple(model, context);
console.log(`completeSimple -> [${message.stopReason}]`, message.content);

// ---------------------------------------------------------------------------
// 5. Streaming with deltas.
// ---------------------------------------------------------------------------

context.messages.push(message, {
	role: "user",
	content: "Now count from 1 to 5, one number per line.",
	timestamp: Date.now(),
});

process.stdout.write("streamSimple   -> ");
const stream = models.streamSimple(model, context);
for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta.replaceAll("\n", " "));
}
const final = await stream.result();
console.log(`[${final.stopReason}] cost: $${final.usage.cost.total.toFixed(6)}`);
