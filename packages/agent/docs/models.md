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
    openai-completions.lazy.ts
    openai-responses.ts
    openai-responses.lazy.ts
    openai-codex-responses.ts
    openai-codex-responses.lazy.ts
    azure-openai-responses.ts
    azure-openai-responses.lazy.ts
    anthropic-messages.ts
    anthropic-messages.lazy.ts
    google-generative-ai.ts
    google-generative-ai.lazy.ts
    google-vertex.ts
    google-vertex.lazy.ts
    mistral-conversations.ts
    mistral-conversations.lazy.ts
    bedrock-converse-stream.ts
    bedrock-converse-stream.lazy.ts
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

const models = builtinModels();
```

`providers/all` may import all provider metadata/catalogs. It still must not eagerly import SDK implementations; provider streams use lazy wrappers.

## Core runtime: Models

`Models` is a provider collection plus auth application and stream convenience. No stream registry, no auth resolver strategy object.

```ts
export function createModels(options?: {
  /** App-owned credential storage. Default: in-memory store. */
  credentials?: CredentialStore;
  /** Environment access for auth resolution (env vars, file existence). Default: process.env/node:fs backed; injectable for tests and non-Node hosts. */
  authContext?: AuthContext;
}): MutableModels;

export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;

  /** Best-effort aggregation: provider source failures yield the models that did list. */
  getModels(options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;
  getModels(provider?: string, options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;
  /** Dynamic lists are honestly Model<Api>; narrow with the hasApi() guard. */
  getModel(provider: string, id: string, options?: { forceRefresh?: boolean }): Promise<Model<Api> | undefined>;

  /**
   * Resolve request auth for a model. Includes source label for status UI.
   * Resolves undefined when the provider is unknown or unconfigured. Rejects
   * with ModelsError ("oauth" on refresh failure, "auth" on api-key/store
   * failure); status/availability UIs catch rejections and render
   * "needs re-login" instead of treating them as unconfigured.
   */
  getAuth(model: Model<Api>): Promise<AuthResult | undefined>;

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

`Provider` is generic over the APIs its models use. Concrete factories declare what they emit (`openaiProvider(): Provider<"openai-responses" | "openai-completions">`), giving typed model lists to direct factory users. A `Models` collection holds providers as `Provider<Api>`.

```ts
export interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;

  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;

  /**
   * Required: at least one of apiKey/oauth. Even ambient-credential providers
   * (env vars, AWS profiles, ADC) and keyless local servers provide apiKey
   * auth whose resolve() reports whether the provider is configured.
   * getAuth() returning undefined = not configured.
   */
  readonly auth: ProviderAuth;

  /** Sync return suits static catalogs; Models always exposes a Promise. */
  getModels(options?: { forceRefresh?: boolean }): Promise<readonly Model<TApi>[]> | readonly Model<TApi>[];

  stream<T extends TApi>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantMessageEventStream;

  streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
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

### Typed model narrowing

Runtime model lists are dynamic, so `models.getModel()`/`getModels()` honestly return `Model<Api>`. Typing improves at three points:

1. **`hasApi()` type guard** — runtime-checked narrowing for dynamic lookups (no blind casts):

   ```ts
   export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi>;

   const model = await models.getModel("anthropic", "claude-opus-4-7");
   if (model && hasApi(model, "anthropic-messages")) {
     // model: Model<"anthropic-messages">, stream options fully typed
   }
   ```

2. **`getBuiltinModel()`** — sync, generated-catalog lookup with typed overloads: `(provider, id) -> Model<exact-api-literal>`. The path for hardcoded known models.

3. **`Provider<TApi>` factories** — typed model lists when using a provider directly, without a `Models` collection.

Deliberately not done: tying `models.getModel(provider, ...)` to typed provider/model ids would require statically knowing which providers are installed in a mutable runtime collection. The harness path (`streamSimple` + `SimpleStreamOptions`) is API-agnostic and unaffected.

For comparison: Vercel AI SDK attaches the implementation to the model object, which dissolves dispatch typing but makes models non-serializable (no sessions/RPC/catalogs as plain data), and its `providerOptions` bag is `Record<string, JSON>` checked only by `satisfies` convention. Plain-data models + provider-owned behavior keeps stronger typing where it matters.

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

This makes the module itself satisfy `ProviderStreams`, so the lazy wrapper is one generic helper instead of bespoke per-API plumbing. `ProviderStreams` is the untyped dispatch shape (implementation modules export concretely typed functions, which would not be assignable to a generic method); per-API option typing lives on the modules themselves and on `Provider.stream()` via `ApiStreamOptions`:

```ts
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// src/api/lazy.ts
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams;

// src/api/anthropic-messages.lazy.ts
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
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";

export function openrouterProvider(): Provider {
  return createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
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

### Provider auth

`Provider.auth` has exactly two slots; real providers have at most one api-key path and at most one OAuth path, and the slot names carry the UI's oauth-vs-api-key split without a `kind` discriminant or method ids:

```ts
export interface ProviderAuth {
  apiKey?: ApiKeyAuth; // stored key/metadata + ambient env/files/ADC/IAM
  oauth?: OAuthAuth;   // login flow + refresh
}

export interface ApiKeyAuth {
  name: string; // "Anthropic API key"

  /** Interactive setup (prompt for key/metadata). Absent = ambient-only (env, ADC, IAM). */
  login?(callbacks: AuthLoginCallbacks): Promise<ApiKeyCredential>;

  /**
   * Resolve auth from the stored credential and/or ambient sources, merging
   * per field (credential.key ?? env("..."), metadata.accountId ?? env("...")).
   * undefined = not configured.
   */
  resolve(input: {
    model: Model<Api>;
    ctx: AuthContext;
    credential?: ApiKeyCredential;
  }): Promise<AuthResult | undefined>;
}

export interface OAuthAuth {
  name: string; // "Anthropic (Claude Pro/Max)"

  login(callbacks: AuthLoginCallbacks): Promise<OAuthCredential>;

  /** Exchange the refresh token. Network call; throws on failure (invalid_grant etc.). Runs under the store lock. */
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;

  /** Side-effect-free derivation of request auth from a valid credential. Covers Copilot-style per-credential baseUrl. Async so lazy wrappers can load the implementation. */
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

export interface AuthResult {
  auth: ModelAuth;
  /** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
  source?: string;
}

export interface AuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>; // supports leading ~
}
```

The OAuth split (`refresh` + `toAuth` instead of one `resolve`) matches the old `OAuthProviderInterface` (`refreshToken` + `getApiKey`) and lets `Models` own the locking pattern without closure gymnastics: refresh produces a credential, `toAuth` derives request auth from whatever credential ends up stored.

There is no `usesCallbackServer` flag. With `prompt()/notify()` callbacks the flow self-describes at runtime: a flow that runs a callback server issues a `manual_code` prompt racing the server and aborts the prompt when the callback wins. The UI needs no static foreknowledge.

### Credentials

One credential per provider, type-tagged — exactly the shape of today's auth.json (`type: "api_key" | "oauth"` per provider id):

```ts
export interface ApiKeyCredential {
  type: "api-key";
  key?: string;
  metadata?: Record<string, string>; // e.g. Cloudflare accountId/gatewayId
}

export interface OAuthCredential extends OAuthCredentials {
  type: "oauth"; // access, refresh, expires from OAuthCredentials
}

export type Credential = ApiKeyCredential | OAuthCredential;
```

`ApiKeyCredential.metadata` exists for providers like Cloudflare that store non-key values (account id, gateway id) alongside or instead of a key. `ApiKeyAuth.resolve()` merges per field: `credential.key ?? env("CLOUDFLARE_API_TOKEN")`, `credential.metadata?.accountId ?? env("CLOUDFLARE_ACCOUNT_ID")`, etc.

### Credential store

The app injects storage; `pi-ai` ships an in-memory default. Keyed by provider id, one credential per provider:

```ts
export interface CredentialStore {
  /** Read the stored credential, possibly expired. Display/status use; request auth comes from Models.getAuth(). */
  read(providerId: string): Promise<Credential | undefined>;

  /**
   * Serialized write — the only write path. fn sees the current credential
   * because correct writes (refresh, login-during-refresh) depend on it;
   * return the new credential, or undefined to leave the entry unchanged.
   * Mutual exclusion per provider id, cross-process too where the backing
   * store supports it (file lock). Resolves with the post-write credential.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;

  /** Remove (logout). Serialized against modify. */
  delete(providerId: string): Promise<void>;
}
```

There is deliberately no `set`: an unserialized write path invites read-modify-write races (login-during-refresh clobbering a fresh credential, double token refresh). Call sites:

```ts
await store.modify(pid, async () => credential);      // login: store this
await store.read(pid);                                // status UI ("logged in via OAuth")
await store.delete(pid);                               // logout
// refresh RMW happens inside Models.getAuth
```

Error semantics: `read` resolves `undefined` for missing entries; methods reject only on storage failure, and `Models` wraps such rejections in `ModelsError` code `"auth"`. Best-effort stores that serve an in-memory view and record persistence errors internally (today's AuthStorage behavior) are valid implementations.

### Resolution policy (fixed)

`Models.getAuth(model)` is a decision tree, not a loop. A stored credential owns the provider — ambient/env is consulted only when nothing is stored (AuthStorage parity: no silent env fallback after a failed refresh or for an unmatched credential type):

```ts
const stored = await store.read(provider.id);
if (stored) {
  if (stored.type === "oauth" && provider.auth.oauth) {
    const oauth = provider.auth.oauth;
    let credential = stored;
    if (Date.now() >= credential.expires) {                 // optimistic check, lock-free
      const post = await store.modify(provider.id, async (current) => {
        if (current?.type !== "oauth") return undefined;    // logged out meanwhile
        return Date.now() >= current.expires                // authoritative check, under lock
          ? oauth.refresh(current)                          // throws -> ModelsError("oauth")
          : undefined;                                      // another process/request refreshed
      });
      if (post?.type !== "oauth") return undefined;
      credential = post;
    }
    return { auth: await oauth.toAuth(credential), source: "OAuth" };
  }
  if (stored.type === "api-key" && provider.auth.apiKey) {
    return provider.auth.apiKey.resolve({ model, ctx, credential: stored });
  }
  return undefined; // stored credential without matching handler blocks ambient
}
return provider.auth.apiKey?.resolve({ model, ctx, credential: undefined }); // ambient
```

Properties:

- Double-checked locking, same as today's `refreshOAuthTokenWithLock`: valid tokens cost one `read` and zero locks; expired tokens lock, re-check under the lock, refresh once globally, persist before release.
- Explicit request auth (stream options `apiKey`/`headers`) is merged per-field on top in `stream()`, winning over everything.
- Refresh failure rejects with `ModelsError("oauth")`; the stored credential is untouched (preserved for retry). Request paths surface this as a stream error with the real cause ("run /login"); status/availability UIs catch the rejection and render "needs re-login" — documented contract on `getAuth`.

### Replacing AuthStorage

The end state for coding-agent: AuthStorage is deleted; its capabilities map onto a `CredentialStore` implementation plus composition.

Today's `getApiKey` priority and its new home:

| AuthStorage today | New design |
|---|---|
| runtime override (CLI `--api-key`) | `withRuntimeOverrides(store, overrides)` decorator: `read` returns the override as an `ApiKeyCredential`; never persisted |
| stored `api_key` (with `$ENV`/`!command` via `resolveConfigValue`) | stored `ApiKeyCredential`; config-value resolution happens at `read` in coding-agent's adapter/decorator (command execution stays app policy) |
| stored `oauth` + locked refresh, undefined on failure | `getAuth` decision tree above; failure rejects with cause instead of silently unconfiguring |
| env var (only when nothing stored) | ambient branch of `apiKey.resolve` |
| `fallbackResolver` (models.json custom providers) | gone — custom providers carry their own `auth.apiKey` |

```txt
FileCredentialStore        ports AuthStorage's lock backend: read = memory snapshot,
                           modify = withLockAsync(re-read, fn, merge-write), delete,
                           internal error recording (drainErrors equivalent)
└─ withConfigValues        $ENV / !command at read
   └─ withRuntimeOverrides --api-key
      └─ createModels({ credentials: store })

login/logout UI            provider.auth.{oauth,apiKey}.login(callbacks) + store.modify/delete
status UI                  store.read(pid) + getAuth try/catch ("needs /login" on rejection)
getOAuthProviders          presence of provider.auth.oauth across registered providers
```

### Login callbacks

One interface serves api-key and OAuth login:

```ts
export interface AuthLoginCallbacks {
  /** Aborts the whole login flow. Per-prompt cancellation uses AuthPrompt.signal. */
  signal?: AbortSignal;

  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** `signal` lets the flow cancel a pending prompt when an out-of-band event resolves the step. */
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
```

`prompt()` returns the entered/selected string (`select` returns the option id). Flows race a `manual_code` prompt against a callback server by setting `AuthPrompt.signal` and aborting the prompt when the callback wins.

### OAuth attachment

Providers that support OAuth always attach it. There is no factory toggle: the flow is lazy-loaded, so advertising OAuth costs nothing until `login()`/`refresh()` actually runs, and a host that never logs in never loads it.

```ts
export function anthropicProvider(): Provider {
  return createProvider({
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: {
      apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]),
      oauth: lazyOAuth({
        name: "Anthropic (Claude Pro/Max)",
        load: () => import("../utils/oauth/anthropic.ts").then((m) => m.anthropicOAuth),
      }),
    },
    models: ANTHROPIC_MODELS,
    api: anthropicMessagesApi(),
  });
}
```

`lazyOAuth()` wraps a dynamically imported `OAuthAuth` so provider definitions can advertise OAuth without importing the implementation (`toAuth` is async for exactly this reason):

```ts
export function lazyOAuth(input: {
  name: string;
  load: () => Promise<OAuthAuth>;
}): OAuthAuth;
```

OAuth must not force Node-only code (`node:http`, `node:crypto`) into browser bundles: the dynamic import inside `lazyOAuth()` uses the same bundler-opaque variable-specifier trick as the bedrock lazy wrapper. Browser hosts never trigger the load (no stored node OAuth credentials, no login flow). If web OAuth lands later (sitegeist proved feasibility: Web Crypto PKCE, auth tab, fetch token exchange, device-code polling), it is just a different `OAuthAuth` implementation — no reserved option values.

The existing flows in `src/utils/oauth/` (anthropic, openai-codex, github-copilot) are adapted to `OAuthAuth` (`login`/`refresh`/`toAuth`, replacing `login`/`refreshToken`/`getApiKey`/`modifyModels`) with the new callbacks, staying Node-targeted and lazy-loaded. Copilot's `modifyModels` baseUrl rewriting becomes `toAuth` returning `ModelAuth.baseUrl`.

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

Request-auth config from models.json (`$ENV`, `!command`, inline keys) remains app-owned sidecar state, surfaced either as explicit request auth or as a custom `ApiKeyAuth` the app sets on the wrapped provider's `auth.apiKey`.

## Custom providers: createProvider()

One helper builds providers from parts; it handles both single-API and mixed-API providers:

```ts
export function createProvider(input: {
  id: string;
  name?: string;                 // default: id
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: ProviderAuth;            // required, at least one of apiKey/oauth (no "no-auth" providers)
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

Old semantics being preserved: global `stream()` dispatched purely on `model.api` via the api-registry, with env API key injection. The compat module reproduces this exactly — it does not route through a `Models` collection, so compat consumers get zero behavioral drift (a `Models`-routed variant was considered and dropped: a model with a known provider id but a different api would dispatch wrong, and auth semantics would shift mid-migration). The harness `Models` instance (Phase 6/7) is where new-path streaming happens.

- `stream/complete/streamSimple/completeSimple(model, ctx, opts)`: api-dispatch via the api-registry plus `getEnvApiKey` injection, verbatim old behavior.
- The builtin api registration side effect moves from the root barrel into compat. It skips api ids that already have a registration, since compat may load after a test or extension registered an override. `registerApiProvider()/unregisterApiProviders()` keep feeding the registry; `resetApiProviders()` clears and re-registers builtins.
- Sync `getModel/getModels/getProviders` are deprecated aliases of `getBuiltinModel/getBuiltinModels/getBuiltinProviders` from `providers/all` (they were always pure generated-catalog reads — verified: nothing ever mutated the old `modelRegistry`).
- Re-exports the per-API lazy stream wrappers (incl. `setBedrockProviderModule`), `env-api-keys.ts`, and the image-generation registry/catalogs; none of these stay on the root barrel.
- `export * from "./index.ts"`: compat is a strict superset of the core entrypoint, so consumers switch a file's import path wholesale without symbol surgery.

coding-agent (and the interim agent package) switch imports of these symbols from `@earendil-works/pi-ai` to `@earendil-works/pi-ai/compat` (import-path-only change) and are otherwise untouched until the ModelManager migration.

Extension grace period: the coding-agent extension loader (jiti aliases + Bun `virtualModules`) resolves the `@earendil-works/pi-ai` ROOT specifier to the compat entrypoint. Existing user extensions using the old global API (`complete`, `getModel`, `registerApiProvider`, ...) keep working at runtime without changes; they break only when compat is removed at the ModelManager migration, with a migration guide in the changelog. Typechecking is the nudge: editors resolve the root to the slim core types, so extension sources that typecheck must import old globals from `/compat` — which is what the repo example extensions demonstrate.

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
5. OAuth implementations are always attached via `lazyOAuth()` and lazy-loaded behind a bundler-opaque dynamic import; provider metadata never eagerly imports Node-only OAuth code.
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

coding-agent owns: `FileCredentialStore` + decorators replacing AuthStorage (see "Replacing AuthStorage"), models.json auth sidecar (`$ENV`, `!command`), command execution policy, provider status labels (from `AuthResult.source`), login/logout UI (driving `auth.{apiKey,oauth}.login()` with `prompt()/notify()`), extension lifecycle, provider-management slash commands.

Until then, the only coding-agent changes in this pass are:

- construct a `Models` instance for `AgentHarness` (builtins + legacy api-dispatch fallback bridging `ModelRegistry` custom providers)
- switch old-global imports to `@earendil-works/pi-ai/compat`
- adapt the login dialog to `prompt()/notify()` callbacks (thin UI adapter; replaces the `usesCallbackServer` special-casing)

## Implementation TODOs

Check items off as they land. Keep this list current; it is the working state for resumed sessions.

### Phase 1 — core types/runtime

- [x] Rename `types.ts` `Provider` alias to `ProviderId`; fix call sites.
- [x] Add `ApiOptionsMap` and `ApiStreamOptions<TApi>` to `types.ts` (type-only imports).
- [x] New `models.ts`: `Provider<TApi>` interface, `hasApi()` guard, `ModelsError` + codes. Auth types live in `src/auth/types.ts` (`ProviderAuth` = `{ apiKey?, oauth? }`, credentials, `CredentialStore` (`read`/`modify`/`delete`, one credential per provider), `AuthResult`, `AuthContext`, `ModelAuth`, login callbacks), in-memory store in `src/auth/credential-store.ts`, default context in `src/auth/context.ts` (browser-safe node:fs trick), `lazyStream()` in `src/api/lazy.ts`.
- [x] `Models`/`MutableModels`/`createModels({ credentials?, authContext? })` with provider map, async `getModel(s)` (per-provider failure isolation), `getAuth` (decision tree, double-checked locked refresh), `stream/complete/streamSimple/completeSimple` with per-field auth merge. Tests: `packages/ai/test/models-runtime.test.ts`.
- [x] Keep metadata helpers: `calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `modelsAreEqual`.

### Phase 2 — `src/api/`

- [x] Move stream implementations from `src/providers/` to `src/api/`, renamed by API id (`anthropic.ts` -> `api/anthropic-messages.ts`, etc.).
- [x] Normalize each implementation module to export exactly `stream` and `streamSimple`.
- [x] Move shared helpers (`openai-responses-shared`, `google-shared`, `transform-messages`, `openai-prompt-cache`, `github-copilot-headers`, `cloudflare`, `simple-options`) to `src/api/`.
- [x] Extract `lazyStream()`/`lazyApi()` into `src/api/lazy.ts`.
- [x] Add `*.lazy.ts` wrappers per API; bedrock keeps node-only import trick and `setBedrockProviderModule()`.
- [x] Delete `providers/register-builtins.ts`. Interim until Phase 5 compat: builtin api-registry registration lives in `stream.ts`; lazy API wrappers are exported from the root barrel.

### Phase 3 — provider factories + catalogs

- [x] Auth helpers in `src/auth/helpers.ts`: `envApiKeyAuth()` (with secret-prompt `login`), `lazyOAuth()`. OAuth flow loads go through `utils/oauth/load.ts` (bundler-opaque dynamic import); the `OAuthAuth` exports it references land in Phase 4.
- [x] `createProvider()` in `models.ts` (single + mixed `api` map, dispatch on `model.api`, unknown api -> stream error).
- [x] Per-provider factories under `src/providers/` for all built-in catalog providers; OAuth attached via `lazyOAuth()` (anthropic, openai-codex, github-copilot); ambient `ApiKeyAuth` for amazon-bedrock (AWS env/profile) and google-vertex (key or ADC+project+location).
- [x] `providers/all.ts`: `builtinProviders()`, `builtinModels()`, `getBuiltinModel/getBuiltinModels/getBuiltinProviders` re-exports.
- [x] Faux provider factory (`fauxProvider()` in `providers/faux.ts`) for tests; legacy `registerFauxProvider()` kept until compat dies.
- [x] Split generated catalogs per provider via `scripts/generate-models.ts` (`providers/<id>.models.ts`); `models.generated.ts` becomes a generated aggregator.

### Phase 4 — OAuth adaptation

- [x] Adapt `utils/oauth/anthropic.ts`, `openai-codex.ts`, `github-copilot.ts` to `OAuthAuth` (`login`/`refresh`/`toAuth`) + `prompt()/notify()`; `modifyModels` baseUrl rewriting becomes `toAuth().baseUrl`. New exports (`anthropicOAuth`, `openaiCodexOAuth`, `githubCopilotOAuth`) sit next to the old `OAuthProviderInterface` objects, which survive until Phase 7.
- [x] No `usesCallbackServer` on `OAuthAuth`: callback-server flows race a `manual_code` prompt (aborted via `AuthPrompt.signal` once the flow settles). The old interface keeps its flag until it dies with compat.

### Phase 5 — packaging

- [x] `index.ts` core-only and side-effect free (no catalogs, no provider factories, no api-registry, no env-api-keys, no images, no OAuth, no compat). Typed catalog reads (`getBuiltin*`) implemented in `providers/all.ts`; `models.ts` no longer imports `models.generated.ts`.
- [x] `compat.ts`: superset of index + old api-dispatch globals, deprecated `getModel/getModels/getProviders` aliases, lazy api wrappers + `setBedrockProviderModule`, `getEnvApiKey`, images. Registration side effect lives here (skip-if-present).
- [x] Subpath exports map (`./compat`, `./providers/*`, `./api/*`); `sideEffects` array listing the effectful modules (`compat`, images registration) instead of `false`.
- [x] Browser smoke (entry now imports old globals from `/compat`) + shrinkwrap checks green. Internal old-global imports switched to `/compat` already (42 files in agent/coding-agent/examples; vitest configs alias `/compat` to src; spawn-CLI tests resolve workspace dist, so `packages/ai` + `packages/agent` dists were rebuilt).

### Phase 6 — AgentHarness

- [x] `AgentHarnessOptions.models` required (`readonly models` on the harness); the harness stream path uses `models.streamSimple()`. `StreamFn` redefined structurally (no compat type dependency); `Models.streamSimple` satisfies it.
- [x] Compaction/branch-summarization take the harness `Models` instance. `getApiKeyAndHeaders` is removed entirely — `Models` is the only auth path; per-request key resolution becomes provider auth on the collection. `compact()`/`generateSummary()`/`generateBranchSummary()` lose their explicit `apiKey`/`headers` parameters.
- [x] Harness tests use `createModels()` + `fauxProvider()` with unique per-fake provider ids; no global api-registry state, no unregister bookkeeping.

### Phase 7 — coding-agent bridge (minimal)

- [x] Switch old-global imports to `@earendil-works/pi-ai/compat` (landed with Phase 5; compat is a superset so the switch was path-only). Extension loader resolves the pi-ai root to compat as the runtime grace period.
- [x] Everything else originally sketched here is gated on coding-agent actually streaming through a `Models` instance — coding-agent's `AgentSession` drives the low-level `Agent` via `streamFn`, not the harness — and moved to Phase 9.

### Phase 8 — wrap-up

- [x] Update/add tests; run affected suites (tests landed with each phase; `./test.sh` green throughout).
- [x] `packages/ai/CHANGELOG.md`: `### Breaking Changes` with migration guide (compat entrypoint, `Provider` -> `ProviderId`, api module moves) + `### Added` for the new Models/provider/auth API.
- [x] `packages/coding-agent/CHANGELOG.md`: `### Changed` entry for extension authors — runtime unaffected (loader resolves the pi-ai root to compat), typecheck nudges to `/compat` or the new API; removal happens later with a migration guide.
- [x] `packages/agent/CHANGELOG.md`: `### Breaking Changes` for required `AgentHarnessOptions.models`, compaction signature changes, structural `StreamFn`.
- [x] `npm run check` clean.

### Phase 9 — ModelManager migration (separate pass, not started)

The big one: coding-agent moves off ModelRegistry/AuthStorage onto `Models` + `CredentialStore`, and compat dies. Ordering sketch:

- [ ] coding-agent constructs a `Models` instance per session: builtins (`builtinModels()`), models.json custom providers via `createProvider()` + `withProviderOverrides`, extension custom providers as real providers (legacy `registerApiProvider` extensions bridged by a catch-all api-dispatch provider until extensions migrate).
- [ ] `AgentSession` streams through that instance (directly or by adopting `AgentHarness`); `agent.streamFn` identity checks and env-key injection die.
- [ ] AuthStorage replaced per "Replacing AuthStorage": `FileCredentialStore` (ports the lock backend), `withConfigValues` (`$ENV`/`!command`), `withRuntimeOverrides` (`--api-key`); custom providers carry their own `ApiKeyAuth` (kills `fallbackResolver`).
- [ ] Login/logout/status UIs move to `ProviderAuth` (`OAuthAuth.login` + `prompt()/notify()` adapter in the login dialog); the old `pi-ai/oauth` registry and `OAuthProviderInterface` (incl. `usesCallbackServer`) are deleted.
- [ ] Cloudflare cleanup (gated on builtin streaming going through `Models.getAuth`): cloudflare factories' `ApiKeyAuth.resolve` reads key + `CLOUDFLARE_ACCOUNT_ID` (+ `CLOUDFLARE_GATEWAY_ID`) from credential metadata/env, substitutes the `{...}` placeholders in `model.baseUrl`, and returns `ModelAuth.baseUrl` (Copilot pattern); unconfigured ids report "not configured". `resolveCloudflareBaseUrl`/`isCloudflareProvider` drop out of `api/anthropic-messages.ts`, `api/openai-completions.ts`, `api/openai-responses.ts`.
- [ ] Move ALL internal `/compat` imports to the new API: every package's src, all tests, and the example extensions (examples then demonstrate the new API). Nothing inside the repo may import `/compat` at that point.
- [ ] Delete `/compat`, `api-registry.ts`, `env-api-keys.ts`, and the extension-loader root-to-compat alias. This is the extension-author breaking release; changelog carries the migration guide.

### Deferred / follow-ups

- [ ] Web OAuth implementations (sitegeist-style) as an alternative `OAuthAuth`.
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
- `Models.getModels()` is best-effort aggregation in all forms: provider source failures yield the models that did list (empty for a single failing provider). Apps that need the concrete failure call `getProvider(id).getModels()` directly.
- Auth resolution and credential store failures reject loudly (`ModelsError` codes `auth`/`oauth`); silent fallback to a different auth path after a failure risks billing surprises. A stored credential always blocks ambient/env fallback, including after a failed refresh.
- Status/availability UIs catch `getAuth` rejections and render "needs re-login"; they do not treat rejection as "unconfigured".
