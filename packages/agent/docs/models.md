# Models architecture

This document describes the target design for the next `pi-ai` model/provider refactor. It describes the desired shape, not the current implementation. It is intended to be complete enough to start implementing from a fresh session.

Goals:

- `Models` is a dumb runtime collection of providers.
- Concrete providers own metadata, auth, model listing, and stream behavior.
- API implementations live under `src/api/` and are reusable/lazy.
- Concrete provider factories live under `src/providers/`.
- Users can import only the providers they need.
- Importing a provider must not eagerly import heavy SDKs.
- Dynamic model lists are first-class and side-effect-free.
- `models.json` and extensions layer by wrapping providers, not by mutating provider internals ad hoc.
- Old global APIs survive only in an explicit, temporary `/compat` entrypoint.

Non-goals for the immediate `pi-ai` pass:

- Do not migrate coding-agent `ModelRegistry` yet.
- Do not keep the stream/API registry inside `Models`.
- Do not implement web OAuth flows yet (the factory option is reserved).
- Images (`images.ts`, `images-api-registry.ts`) are out of scope; leave untouched.

## Package layout

Target source layout:

```txt
packages/ai/src/
  index.ts                    # core exports only; no built-in provider imports
  models.ts                   # Models runtime, Provider, auth types
  compat.ts                   # temporary old-API compatibility entrypoint
  auth/                       # auth method types, helpers, login callbacks
  api/                        # API implementations and lazy wrappers
    openai-completions.ts     # real implementation, imports SDKs, exports stream/streamSimple
    openai-completions-lazy.ts
    openai-responses.ts
    openai-responses-lazy.ts
    openai-codex-responses.ts
    openai-codex-responses-lazy.ts
    azure-openai-responses.ts
    azure-openai-responses-lazy.ts
    anthropic-messages.ts
    anthropic-messages-lazy.ts
    google-generative-ai.ts
    google-generative-ai-lazy.ts
    google-vertex.ts
    google-vertex-lazy.ts
    mistral-conversations.ts
    mistral-conversations-lazy.ts
    bedrock-converse-stream.ts
    bedrock-converse-stream-lazy.ts
    lazy.ts                   # lazyStream()/lazyApi() helpers
    (shared helpers: openai-responses-shared, google-shared, transform-messages, ...)
  providers/                  # concrete provider factories and per-provider catalogs
    openai.ts
    openai.models.ts          # generated OpenAI catalog
    openai-codex.ts
    openai-codex.models.ts
    anthropic.ts
    anthropic.models.ts
    google.ts
    google.models.ts
    ...one pair per built-in provider...
    faux.ts                   # test provider factory
    all.ts                    # explicit aggregate: builtinModels(), getBuiltin*()
  utils/oauth/                # OAuth flow implementations (node), lazy-loaded
```

`src/index.ts` must stay core-only. It must not import:

- generated model catalogs
- built-in provider factories
- provider SDK implementations
- Node-only OAuth modules
- `providers/all`
- `compat`

Provider, API, and compat entrypoints are explicit subpath exports.

## Public usage

Minimal provider usage:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());

const model = await models.getModel("openai", "gpt-4o-mini");
if (!model) throw new Error("model not found");

const response = await models.complete(model, context);
```

Multiple providers:

```ts
const models = createModels();
models.setProvider(openaiProvider());
models.setProvider(openrouterProvider());
```

All built-ins, explicitly heavy metadata entrypoint:

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels({ oauth: "node" });
```

`providers/all` may import all provider metadata/catalogs. It still must not eagerly import SDK implementations; provider streams use lazy wrappers.

## Core runtime: Models

`Models` is a provider collection plus auth application and stream convenience. No stream registry, no auth resolver strategy object.

```ts
export function createModels(options?: { credentials?: CredentialStore }): MutableModels;

export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;

  getModels(provider?: string, options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;
  getModel(provider: string, id: string, options?: { forceRefresh?: boolean }): Promise<Model<Api> | undefined>;

  /** Resolve request auth for a model. Includes source label for status UI. */
  getAuth(model: Model<Api>): Promise<AuthResolution | undefined>;

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): AssistantMessageEventStream;

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): Promise<AssistantMessage>;

  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

export interface MutableModels extends Models {
  /** Upsert/replace by provider.id. Provider ids are unique. */
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}
```

Removed concepts:

```txt
no Models.setStreamFunctions() / getStreamFunctions()
no api-registry as a real dispatch mechanism
no Models.provider(id) builder, no setModel/upsertModel/patchModel lifecycle
no ModelAuthResolver / setAuthResolver — resolution policy is fixed, store is injected
```

If an app needs different auth policy, it wraps providers (wrap auth methods or `getModels`) or passes explicit request auth in stream options.

## Provider

A provider is the concrete runtime unit. It owns id/name/base metadata, auth methods, model listing, and stream behavior.

```ts
export interface Provider {
  readonly id: string;
  readonly name: string;

  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;

  /** Required. Empty array for no-auth providers. */
  readonly auth: readonly AuthMethod[];

  getModels(options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): AssistantMessageEventStream;

  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}
```

There is no `Provider.api` field. `model.api` carries API identity; the provider dispatches internally (see `createProvider()`).

`Model.api` remains: existing metadata and tests use it, it is useful for diagnostics, and provider construction uses it for API implementation selection. But `Models` never dispatches on it; the provider does.

### Typed stream options

Full stream options are API-specific. `Model<TApi>` pays off by deriving the option type from the API:

```ts
// types.ts — type-only imports from API impl modules are erased, so this is tree-shake safe
export interface ApiOptionsMap {
  "anthropic-messages": AnthropicOptions;
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
  "openai-codex-responses": OpenAICodexResponsesOptions;
  "azure-openai-responses": AzureOpenAIResponsesOptions;
  "google-generative-ai": GoogleOptions;
  "google-vertex": GoogleVertexOptions;
  "mistral-conversations": MistralOptions;
  "bedrock-converse-stream": BedrockOptions;
}

export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
  ? ApiOptionsMap[TApi]
  : StreamOptions & Record<string, unknown>;
```

Custom api strings fall back to the generic shape.

### Name collision

`types.ts` currently exports `type Provider = KnownProvider | string` (a provider id). Rename that alias to `ProviderId` and fix call sites. The `Provider` interface above takes the name.

## Provider model listing

`Provider.getModels()` is async and returns full `Model<Api>` objects. Static providers wrap their catalog; dynamic providers (llama.cpp, OpenRouter live listing) fetch and cache, honoring `forceRefresh`.

Dynamic model listing must be side-effect-free discovery:

```txt
OK: fetch /v1/models, enumerate local catalog, refresh cached remote model list
Not OK: load model, download model, mutate server state, run request probe
```

Provider-specific model lifecycle (load/unload) belongs in app/provider-management commands, not in `getModels()`.

## Streaming path

`Models.stream()` finds the provider by `model.provider`, resolves auth, merges it into request options, and delegates:

```ts
function stream(model, context, options) {
  const provider = this.getProvider(model.provider);
  if (!provider) {
    // produce an error stream, not a throw — see Error behavior
  }

  // async setup happens inside the returned stream (lazyStream pattern)
  const resolution = await this.getAuth(model);
  const requestModel = resolution?.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
  const requestOptions = mergeAuth(options, resolution?.auth); // explicit options win per-field

  return provider.stream(requestModel, context, requestOptions);
}
```

`stream()` returns `AssistantMessageEventStream` synchronously; async setup (auth resolution, lazy module load) happens inside the returned stream. The forwarding pattern already exists in today's `register-builtins.ts` (`createLazyStream`); extract it as `lazyStream()` in `src/api/lazy.ts`.

No request hot-path model canonicalization: `stream()` uses the supplied model object as-is. If an app wants fresh model metadata, it calls `models.getModel(provider, id, { forceRefresh: true })` before starting the turn.

## API implementations under `src/api`

An API implementation is reusable stream behavior. It is not a provider.

Uniform export contract — every real implementation module exports exactly:

```ts
// src/api/anthropic-messages.ts — imports SDKs
export function stream(model, context, options) { ... }
export function streamSimple(model, context, options) { ... }
```

This makes the module itself satisfy `ProviderStreams`, so the lazy wrapper is one generic helper instead of bespoke per-API plumbing:

```ts
export interface ProviderStreams {
  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// src/api/lazy.ts
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams;

// src/api/anthropic-messages-lazy.ts
export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
```

Import chain:

```txt
provider module -> lazy API wrapper -> dynamic import(real API impl) -> SDK deps
```

Notes:

- Bedrock keeps the node-only dynamic import trick (`importNodeOnlyProvider`, `.ts`/`.js` specifier rewrite) inside its lazy wrapper. `setBedrockProviderModule()` (used by the Bun build) moves into the bedrock lazy wrapper module.
- Shared helper modules (`openai-responses-shared.ts`, `google-shared.ts`, `transform-messages.ts`, prompt-cache, copilot headers) move to `src/api/` alongside the implementations.

## Shared API implementations across concrete providers

Many concrete providers share an API implementation (OpenAI-completions: OpenRouter, Groq, Cerebras, xAI, ZAI, ...). They share lazy API objects by reference:

```ts
import { openAICompletionsApi } from "../api/openai-completions-lazy.ts";

export function openrouterProvider(): Provider {
  return createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: [envApiKeyMethod({ id: "api-key", name: "OpenRouter API key", env: ["OPENROUTER_API_KEY"] })],
    models: OPENROUTER_MODELS,
    api: openAICompletionsApi(),
  });
}
```

This copies Vercel AI SDK's useful property: users import concrete providers; shared protocol implementation is internal.

## Auth

Request auth output stays small:

```ts
export interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}
```

If a value cannot be expressed as `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth (Vertex project/location, Bedrock region/profile, Azure apiVersion are provider factory options).

### Auth methods

`Provider.auth` is a list of uniform auth methods. The `kind` discriminant keeps the UI's oauth-vs-api-key split and types the credential:

```ts
export interface ApiKeyAuthMethod {
  kind: "api-key";
  id: string;   // unique within provider, e.g. "api-key"
  name: string; // "Anthropic API key"

  /** Interactive setup (prompt for key/metadata). Absent = ambient-only (env, ADC, IAM). */
  login?(callbacks: AuthLoginCallbacks): Promise<LocalCredential>;

  resolve(input: {
    model: Model<Api>;
    ctx: ProviderAuthContext;
    credential?: LocalCredential;
  }): Promise<AuthResolution | undefined>;
}

export interface OAuthAuthMethod {
  kind: "oauth";
  id: string;   // e.g. "oauth"
  name: string; // "Anthropic (Claude Pro/Max)"

  login(callbacks: AuthLoginCallbacks): Promise<OAuthCredential>;

  resolve(input: {
    model: Model<Api>;
    ctx: ProviderAuthContext;
    credential?: OAuthCredential;
  }): Promise<AuthResolution | undefined>;
}

export type AuthMethod = ApiKeyAuthMethod | OAuthAuthMethod;

export interface AuthResolution {
  auth: ModelAuth;
  /** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
  source?: string;
  /** Present when the method refreshed/updated the credential; Models persists it via the store. */
  credential?: Credential;
}

export interface ProviderAuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>; // supports leading ~
}
```

There is no `usesCallbackServer` flag. With `prompt()/notify()` callbacks the flow self-describes at runtime: a flow that runs a callback server issues a `manual_code` prompt racing the server and aborts the prompt when the callback wins. The UI needs no static foreknowledge.

### Credentials

```ts
export interface LocalCredential {
  type: "local";
  key?: string;
  metadata?: Record<string, string>; // e.g. Cloudflare accountId/gatewayId
}

export interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
}

export type Credential = LocalCredential | OAuthCredential;
```

`LocalCredential.metadata` exists for providers like Cloudflare that store non-key values (account id, gateway id) alongside or instead of a key. The method's `resolve()` merges per field: `credential.key ?? env("CLOUDFLARE_API_TOKEN")`, `credential.metadata?.accountId ?? env("CLOUDFLARE_ACCOUNT_ID")`, etc.

### Credential store

The app injects storage; `pi-ai` ships an in-memory default.

```ts
export interface CredentialStore {
  get(providerId: string, methodId: string): Promise<Credential | undefined>;
  set(providerId: string, methodId: string, credential: Credential): Promise<void>;
  delete(providerId: string, methodId: string): Promise<void>;
}
```

coding-agent later implements this over AuthStorage. Login/logout orchestration is app-owned: the app calls `method.login(callbacks)` and persists the returned credential itself. `Models` only *reads* the store during resolution, and *writes* refreshed credentials when `resolve()` returns an updated one (OAuth token refresh).

### Resolution policy (fixed)

`Models.getAuth(model)` resolves with a fixed policy. Precedence, highest first:

```txt
1. explicit request auth (stream options apiKey/headers) — merged per-field on top, in stream()
2. methods with a stored credential, in provider auth list order
3. methods resolving without a credential (ambient/env), in provider auth list order
```

Two-pass over `provider.auth`:

- Pass 1: for each method with a credential in the store, call `resolve({ model, ctx, credential })`; first non-undefined resolution wins.
- Pass 2: for each method, call `resolve({ model, ctx })`; first non-undefined resolution wins.

So an explicit login (stored credential) beats ambient env vars regardless of list order; list order breaks ties. Per-field merging *within* one method (stored key + env account id) happens inside that method's `resolve()`.

If a resolution carries an updated `credential`, `Models` persists it via the store before returning.

### Login callbacks

One interface serves api-key and OAuth login:

```ts
export interface AuthLoginCallbacks {
  signal?: AbortSignal;

  prompt(prompt: AuthPrompt, options?: { signal?: AbortSignal }): Promise<string>;
  notify(event: AuthEvent): void;
}

export type AuthPrompt =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string };

export type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
```

`prompt()` returns the entered/selected string (`select` returns the option id). Flows race a `manual_code` prompt against a callback server by passing a per-prompt abort signal and aborting when the callback wins.

### OAuth implementation target

OAuth must not force Node-only code (`node:http`, `node:crypto`) into browser bundles. Keep OAuth lazy; the provider factory decides which implementation to attach:

```ts
export type OAuthTarget = "node" | "web" | false;

export interface AnthropicProviderOptions {
  oauth?: OAuthTarget; // default false
}

export function anthropicProvider(options: AnthropicProviderOptions = {}): Provider {
  return createProvider({
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: [
      ...(options.oauth === "node"
        ? [lazyOAuthMethod({
            id: "oauth",
            name: "Anthropic (Claude Pro/Max)",
            load: () => import("../utils/oauth/anthropic.ts").then((m) => m.anthropicOAuthMethod),
          })]
        : []),
      envApiKeyMethod({ id: "api-key", name: "Anthropic API key", env: ["ANTHROPIC_API_KEY"] }),
    ],
    models: ANTHROPIC_MODELS,
    api: anthropicMessagesApi(),
  });
}
```

- Individual factories default to `oauth: false`.
- `builtinModels({ oauth: "node" })` for pi CLI/coding-agent.
- `"web"` is reserved; web flows (sitegeist-style: Web Crypto PKCE, auth tab, extension tab APIs watching the localhost redirect, fetch token exchange, device-code polling for Copilot) are a follow-up. Until implemented, passing `"web"` throws at login time with a clear message.

`lazyOAuthMethod()` wraps a dynamically imported `OAuthAuthMethod` so provider definitions can advertise OAuth without importing the implementation:

```ts
export function lazyOAuthMethod(input: {
  id: string;
  name: string;
  load: () => Promise<OAuthAuthMethod>;
}): OAuthAuthMethod;
```

The existing flows in `src/utils/oauth/` (anthropic, openai-codex, github-copilot) are adapted to `OAuthAuthMethod` with the new callbacks, staying Node-targeted and lazy-loaded.

## Provider wrappers and models.json

`models.json` is a provider wrapper layer. It does not mutate providers in place:

```ts
function withProviderOverrides(base: Provider, overrides: ProviderOverrides): Provider {
  return {
    ...base,
    name: overrides.name ?? base.name,
    baseUrl: overrides.baseUrl ?? base.baseUrl,
    headers: mergeHeaders(base.headers, overrides.headers),

    async getModels(options) {
      const models = await base.getModels(options);
      return applyModelOverrides(models, overrides.models);
    },

    stream: base.stream,
    streamSimple: base.streamSimple,
  };
}
```

This composes with dynamic providers because `getModels()` delegates to the base source.

Request-auth config from models.json (`$ENV`, `!command`, inline keys) remains app-owned sidecar state, surfaced either as explicit request auth or as a custom `ApiKeyAuthMethod` the app prepends to the wrapped provider's auth list.

## Custom providers: createProvider()

One helper builds providers from parts; it handles both single-API and mixed-API providers:

```ts
export function createProvider(input: {
  id: string;
  name?: string;                 // default: id
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: readonly AuthMethod[];  // default: []
  models:
    | readonly Model<Api>[]
    | ((options?: { forceRefresh?: boolean }) => Promise<readonly Model<Api>[]>);
  /** Single implementation, or map keyed by model.api for mixed-API providers. */
  api: ProviderStreams | Record<string, ProviderStreams>;
}): Provider;
```

- Single `api`: all models stream through it.
- Map `api`: `stream()`/`streamSimple()` dispatch on `model.api`; unknown api produces a stream error.

Mixed-API custom providers must be supported (opencode Go/Zen-style providers expose models backed by different APIs under one provider id).

Built-in provider factories use `createProvider()` internally. models.json custom providers map onto it directly:

```json
{
  "providers": {
    "my-openai-proxy": {
      "api": "openai-completions",
      "baseUrl": "https://proxy.example/v1",
      "models": [ ... ]
    }
  }
}
```

## Compat entrypoint

`@earendil-works/pi-ai/compat` preserves the old global API surface until the coding-agent migration deletes it. New code never imports it.

Old semantics being preserved: global `stream()` dispatched purely on `model.api` via the api-registry, with env API key injection. The compat module reproduces this:

- Lazily creates a default `Models` singleton from `builtinModels({ oauth: "node" })` on first use.
- `stream/complete/streamSimple/completeSimple(model, ctx, opts)`: look up `getProvider(model.provider)`; if found, route through the singleton (auth resolution included). If not found (custom models.json/extension models), fall back to api-dispatch through a hidden `createProvider()` map containing all builtin API implementations plus anything registered via compat `registerApiProvider()`.
- `registerApiProvider()/unregisterApiProviders()` feed that fallback dispatch map. `api-registry.ts` dies as a real mechanism.
- Sync `getModel/getModels/getProviders` become deprecated aliases of `getBuiltinModel/getBuiltinModels/getBuiltinProviders` (they were always pure generated-catalog reads — verified: nothing ever mutated the old `modelRegistry`).
- Re-exports `setBedrockProviderModule` from the bedrock lazy wrapper.
- `getEnvApiKey`/`env-api-keys.ts` stays available from compat only; provider auth methods own env lookup in the new design.

coding-agent switches imports of these symbols from `@earendil-works/pi-ai` to `@earendil-works/pi-ai/compat` (import-path-only change) and is otherwise untouched until the ModelManager migration.

## Builtin static helpers

Typed, sync, generated-catalog-only helpers live with the catalogs (exported from `providers/all`):

```ts
getBuiltinModel(provider, id)   // sync, typed overloads from generated catalog
getBuiltinModels(provider)      // sync
getBuiltinProviders()           // sync
```

Runtime lookup is always the async instance API: `await models.getModel(...)`.

Generated catalogs are split per provider (`providers/<id>.models.ts`) by updating `packages/ai/scripts/generate-models.ts`. If the generator change turns out too large for this pass, splitting may be deferred; `providers/all` and provider factories may temporarily import the monolithic `models.generated.ts`, relying on `sideEffects: false` for pruning.

## Tree-shaking and lazy imports

Rules:

1. Main `@earendil-works/pi-ai` import is core-only.
2. Provider modules import their catalog, auth helpers, and lazy API wrappers only.
3. Lazy API wrappers dynamically import real API implementations.
4. Real API implementations import SDK dependencies.
5. OAuth implementations are selected by factory option (`oauth: "node" | "web" | false`) and lazy-loaded; provider metadata never eagerly imports Node-only OAuth code.
6. `providers/all` may import all provider metadata, but no eager SDK imports.
7. Provider modules are side-effect-free; importing a provider does not register anything globally.
8. `package.json` sets `sideEffects: false`.

Exports map sketch:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./compat": "./dist/compat.js",
    "./providers/all": "./dist/providers/all.js",
    "./providers/openai": "./dist/providers/openai.js",
    "./providers/anthropic": "./dist/providers/anthropic.js",
    "./providers/*": "./dist/providers/*.js",
    "./api/*": "./dist/api/*.js"
  }
}
```

Browser smoke check (`scripts/check-browser-smoke.mjs`) must keep passing: bundling the core entrypoint (and any non-node provider entrypoint) must not pull `node:http`/`node:crypto`.

## AgentHarness integration

`AgentHarness` receives a `Models` instance.

- `AgentHarnessOptions.models` is required.
- The harness does not snapshot `Models` into turn state.
- Request path calls `this.models.streamSimple(model, context, options)`; same for compaction/branch-summarization paths.
- Request path never calls async `models.getModel()` to canonicalize; if model metadata needs refresh, the app updates the selected model before starting a turn.
- Harness tests build `createModels()` and install the faux provider (`fauxProvider()` factory from `providers/faux`).

## coding-agent next phase (not this pass)

coding-agent builds providers in layers and binds them per session:

```txt
built-in providers (builtinModels)
-> models.json provider wrappers / custom providers (createProvider)
-> extension provider wrappers/additions
```

```ts
sessionModels.clearProviders();
for (const provider of layeredProviders) sessionModels.setProvider(provider);
```

coding-agent owns: AuthStorage-backed `CredentialStore`, models.json auth sidecar (`$ENV`, `!command`), command execution policy, provider status labels (from `AuthResolution.source`), login/logout UI (driving `method.login()` with `prompt()/notify()`), extension lifecycle, provider-management slash commands.

Until then, the only coding-agent changes in this pass are:

- construct a `Models` instance for `AgentHarness` (builtins + legacy api-dispatch fallback bridging `ModelRegistry` custom providers)
- switch old-global imports to `@earendil-works/pi-ai/compat`
- adapt the login dialog to `prompt()/notify()` callbacks (thin UI adapter; replaces the `usesCallbackServer` special-casing)

## Implementation TODOs

Check items off as they land. Keep this list current; it is the working state for resumed sessions.

### Phase 1 — core types/runtime

- [ ] Rename `types.ts` `Provider` alias to `ProviderId`; fix call sites.
- [ ] Add `ApiOptionsMap` and `ApiStreamOptions<TApi>` to `types.ts` (type-only imports).
- [ ] New `models.ts`: `Provider` interface, `AuthMethod` union (`ApiKeyAuthMethod`/`OAuthAuthMethod`), `LocalCredential`/`OAuthCredential`/`Credential`, `CredentialStore` (+ in-memory default), `AuthResolution`, `ProviderAuthContext`, `ModelAuth`, `ModelsError` + codes.
- [ ] `Models`/`MutableModels`/`createModels({ credentials? })` with provider map, async `getModel(s)` (per-provider failure isolation), `getAuth` (two-pass fixed policy, persists refreshed credentials), `stream/complete/streamSimple/completeSimple` with per-field auth merge.
- [ ] Keep metadata helpers: `calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `modelsAreEqual`.

### Phase 2 — `src/api/`

- [ ] Move stream implementations from `src/providers/` to `src/api/`, renamed by API id (`anthropic.ts` -> `api/anthropic-messages.ts`, etc.).
- [ ] Normalize each implementation module to export exactly `stream` and `streamSimple`.
- [ ] Move shared helpers (`openai-responses-shared`, `google-shared`, `transform-messages`, `openai-prompt-cache`, `github-copilot-headers`) to `src/api/`.
- [ ] Extract `lazyStream()`/`lazyApi()` into `src/api/lazy.ts`.
- [ ] Add `*-lazy.ts` wrappers per API; bedrock keeps node-only import trick and `setBedrockProviderModule()`.
- [ ] Delete `providers/register-builtins.ts`.

### Phase 3 — provider factories + catalogs

- [ ] Auth helpers in `src/auth/`: `envApiKeyMethod()`, `lazyOAuthMethod()`, `OAuthTarget`, `AuthLoginCallbacks`/`AuthPrompt`/`AuthEvent`.
- [ ] `createProvider()` (single + mixed `api` map, dispatch on `model.api`).
- [ ] Per-provider factories under `src/providers/` for all built-in catalog providers, `oauth` factory options where applicable.
- [ ] `providers/all.ts`: `builtinModels({ oauth? })`, `getBuiltinModel/getBuiltinModels/getBuiltinProviders`.
- [ ] Faux provider factory (`providers/faux.ts`) for tests.
- [ ] Split generated catalogs per provider via `scripts/generate-models.ts` (`providers/<id>.models.ts`) — or record explicitly that this is deferred.

### Phase 4 — OAuth adaptation

- [ ] Adapt `utils/oauth/anthropic.ts`, `openai-codex.ts`, `github-copilot.ts` to `OAuthAuthMethod` + `prompt()/notify()`.
- [ ] Remove `usesCallbackServer`; callback-server flows race a `manual_code` prompt instead.
- [ ] `oauth: "web"` reserved: throws at login with clear message.

### Phase 5 — packaging

- [ ] `index.ts` core-only (no catalogs, no provider factories, no OAuth, no compat).
- [ ] `compat.ts`: default builtin singleton, `stream/complete/streamSimple/completeSimple` with api-dispatch fallback, `registerApiProvider`/`unregisterApiProviders`, deprecated `getModel/getModels/getProviders` aliases, `setBedrockProviderModule` re-export, `getEnvApiKey`.
- [ ] Subpath exports map; `sideEffects: false`.
- [ ] Browser smoke + shrinkwrap checks green.

### Phase 6 — AgentHarness

- [ ] `AgentHarnessOptions.models` required; harness stream path uses `models.streamSimple()`.
- [ ] Compaction/branch-summarization paths use the harness `Models` instance.
- [ ] Harness tests use `createModels()` + faux provider.

### Phase 7 — coding-agent bridge (minimal)

- [ ] Construct `Models` for the harness (builtins + legacy api-dispatch fallback for ModelRegistry custom providers).
- [ ] Switch old-global imports to `@earendil-works/pi-ai/compat`.
- [ ] Login dialog adapter for `prompt()/notify()` callbacks.

### Phase 8 — wrap-up

- [ ] Update/add tests; run affected suites (`./test.sh` or per-package vitest).
- [ ] `packages/ai/CHANGELOG.md`: `### Breaking Changes` entry with a migration guide (old global `stream/streamSimple/complete/completeSimple`, `getModel/getModels/getProviders`, `registerApiProvider`, `Provider` -> `ProviderId` rename, OAuth callback changes; old API -> `createModels()`/provider factories or `/compat` as interim).
- [ ] `packages/coding-agent/CHANGELOG.md`: `### Breaking Changes` entry with a migration guide for extension authors who work directly with pi-ai through coding-agent (e.g. custom providers via `registerApiProvider`, model access, login/auth hooks): what changed, what to import now, compat timeline.
- [ ] `packages/agent/CHANGELOG.md`: `### Breaking Changes` entry for required `AgentHarnessOptions.models`.
- [ ] `npm run check` clean.

### Deferred / follow-ups

- [ ] Web OAuth implementations (sitegeist-style) behind `oauth: "web"`.
- [ ] coding-agent `ModelRegistry` -> session `ModelManager` migration; delete `/compat`.
- [ ] Images API registry redesign (untouched in this pass).

## Error behavior

`undefined` means not found or not configured. Real failures reject or become stream errors.

```ts
export type ModelsErrorCode =
  | "model_source"      // provider getModels() failed
  | "model_validation"  // model object invalid
  | "provider"          // unknown provider, dispatch failure
  | "stream"            // stream setup failure
  | "auth"              // auth resolution failure
  | "oauth";            // oauth login/refresh failure
```

- `Models.stream()` produces stream errors (error event + error result) for async setup failures; it does not throw after returning the stream.
- `Models.getModels()` with no provider filter isolates per-provider source failures so one dynamic provider failure does not prevent listing others.
