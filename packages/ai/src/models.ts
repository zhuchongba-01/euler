import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./auth/types.ts";
import { MODELS } from "./models.generated.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	KnownProvider,
	Model,
	ModelThinkingLevel,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/**
 * A provider is the concrete runtime unit. It owns id/name/base metadata,
 * auth methods, model listing, and stream behavior.
 *
 * `TApi` lets concrete provider factories declare which APIs their models
 * use (e.g. `openaiProvider(): Provider<"openai-responses" | "openai-completions">`),
 * giving typed model lists to direct factory users. Inside a `Models`
 * collection providers are held as `Provider<Api>`.
 */
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: Record<string, string>;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Every provider has auth
	 * semantics — even providers with only ambient credentials (env vars, AWS
	 * profiles, ADC files) and keyless local servers provide `apiKey` auth
	 * whose `resolve()` reports whether the provider is configured.
	 * `Models.getAuth()` returns undefined when the provider is unconfigured.
	 */
	readonly auth: ProviderAuth;

	/**
	 * List models. Async and side-effect-free discovery only; provider-specific
	 * model lifecycle (load/unload) belongs in app commands.
	 */
	getModels(options?: { forceRefresh?: boolean }): Promise<readonly Model<TApi>[]> | readonly Model<TApi>[];

	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * Runtime collection of providers plus auth application and stream
 * convenience. Providers own stream behavior; `Models` resolves auth and
 * delegates each request to the provider that owns the model.
 */
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/**
	 * List models from one provider or all providers. Best-effort aggregation:
	 * provider source failures yield the models that did list (empty for a
	 * single failing provider). Apps that need the failure call
	 * `getProvider(id).getModels()` directly.
	 */
	getModels(options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;
	getModels(provider?: string, options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;

	/**
	 * Runtime model lookup. Dynamic model lists are typed as `Model<Api>`;
	 * narrow with the `hasApi()` type guard.
	 */
	getModel(provider: string, id: string, options?: { forceRefresh?: boolean }): Promise<Model<Api> | undefined>;

	/**
	 * Resolve request auth for a model. Includes a source label for status UI.
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * when api-key resolution or the credential store fails. Request paths
	 * surface rejections as stream errors; status/availability UIs catch them
	 * and render "needs re-login" instead of treating them as unconfigured.
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

export interface CreateModelsOptions {
	credentials?: CredentialStore;
	authContext?: AuthContext;
}

class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	async getModels(
		providerOrOptions?: string | { forceRefresh?: boolean },
		maybeOptions?: { forceRefresh?: boolean },
	): Promise<readonly Model<Api>[]> {
		const provider = typeof providerOrOptions === "string" ? providerOrOptions : undefined;
		const options = typeof providerOrOptions === "string" ? maybeOptions : providerOrOptions;

		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return await entry.getModels(options);
			} catch {
				return [];
			}
		}

		// Async wrapper turns sync throws from ill-behaved providers into rejections.
		const results = await Promise.allSettled(
			Array.from(this.providers.values(), async (entry) => entry.getModels(options)),
		);
		const models: Model<Api>[] = [];
		for (const result of results) {
			if (result.status === "fulfilled") models.push(...result.value);
		}
		return models;
	}

	async getModel(provider: string, id: string, options?: { forceRefresh?: boolean }): Promise<Model<Api> | undefined> {
		const models = await this.getModels(provider, options);
		return models.find((model) => model.id === id);
	}

	async getAuth(model: Model<Api>): Promise<AuthResult | undefined> {
		const provider = this.providers.get(model.provider);
		if (!provider) return undefined;

		// A stored credential owns the provider: ambient/env is consulted only
		// when nothing is stored. No silent env fallback after a failed refresh
		// or for a credential type without a matching handler.
		const stored = await this.readCredential(provider.id);
		if (stored) {
			if (stored.type === "oauth" && provider.auth.oauth) {
				return this.resolveOAuth(provider.id, provider.auth.oauth, stored);
			}
			if (stored.type === "api-key" && provider.auth.apiKey) {
				return this.resolveApiKey(provider.auth.apiKey, model, stored);
			}
			return undefined;
		}

		// Ambient (env vars, AWS profiles, ADC files).
		return provider.auth.apiKey ? this.resolveApiKey(provider.auth.apiKey, model, undefined) : undefined;
	}

	/**
	 * OAuth resolution with double-checked locking (same pattern as today's
	 * AuthStorage): valid tokens cost zero locks; expired tokens lock,
	 * re-check expiry under the lock, refresh once globally, and persist the
	 * rotated credential before release.
	 */
	private async resolveOAuth(
		providerId: string,
		oauth: OAuthAuth,
		stored: OAuthCredential,
	): Promise<AuthResult | undefined> {
		let credential = stored;

		if (Date.now() >= credential.expires) {
			// Optimistic check said expired; the authoritative check runs under the lock.
			let post: Credential | undefined;
			try {
				post = await this.credentials.modify(providerId, async (current) => {
					if (current?.type !== "oauth") return undefined; // logged out meanwhile
					if (Date.now() < current.expires) return undefined; // another process/request refreshed
					try {
						return await oauth.refresh(current);
					} catch (error) {
						throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
					}
				});
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
			}
			if (post?.type !== "oauth") return undefined; // logged out meanwhile
			credential = post;
		}

		try {
			return { auth: await oauth.toAuth(credential), source: "OAuth" };
		} catch (error) {
			throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
		}
	}

	private async resolveApiKey(
		apiKey: ApiKeyAuth,
		model: Model<Api>,
		credential: ApiKeyCredential | undefined,
	): Promise<AuthResult | undefined> {
		try {
			return await apiKey.resolve({ model, ctx: this.authContext, credential });
		} catch (error) {
			throw new ModelsError("auth", `API key auth failed for provider ${model.provider}`, { cause: error });
		}
	}

	private async readCredential(providerId: string): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private async applyAuth<TOptions extends StreamOptions>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: TOptions | undefined }> {
		const resolution = await this.getAuth(model);
		const auth = resolution?.auth;
		if (!auth) return { requestModel: model, requestOptions: options };

		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

		// Explicit request options win per-field; headers merge per header.
		const apiKey = options?.apiKey ?? auth.apiKey;
		const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
		const requestOptions = { ...options, apiKey, headers } as TOptions;

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options as StreamOptions | undefined);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions);
		});
	}

	async completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	models:
		| readonly Model<TApi>[]
		| ((options?: { forceRefresh?: boolean }) => Promise<readonly Model<TApi>[]> | readonly Model<TApi>[]);
	/** Single implementation, or map keyed by `model.api` for mixed-API providers. */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all models;
 * an `api` map dispatches on `model.api`, and a model whose api has no entry
 * produces a stream error.
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const { models } = input;
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	return {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: typeof models === "function" ? (options) => models(options) : () => models,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = await models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
