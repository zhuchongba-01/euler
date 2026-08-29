import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { activityMonitor } from "./activity.ts";
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
import { isBochaAvailable, searchWithBocha } from "./bocha.ts";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import { isBrightDataAvailable, searchWithBrightData } from "./brightdata.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { isDuckDuckGoAvailable, searchWithDuckDuckGo } from "./duckduckgo.ts";
import { runEulerSearchRoute } from "./euler-config.ts";
import { isExaAvailable, searchWithExa, searchWithExaMcp } from "./exa.ts";
import { isFirecrawlAvailable, searchWithFirecrawl } from "./firecrawl.ts";
import { isGeminiAdcAvailable } from "./gemini-adc.ts";
import {
	fetchGeminiApi,
	getApiKey,
	getVersionedApiBase,
	isGatewayConfigured,
	isGeminiApiAvailable,
	redactGeminiApiResponse,
} from "./gemini-api.ts";
import { getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { isJinaSearchAvailable, searchWithJina } from "./jina-search.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isKimiSearchAvailable, searchWithKimi } from "./kimi-search.ts";
import { isOllamaAvailable, searchWithOllama } from "./ollama.ts";
import {
	isCurrentModelHostedSearchEligible,
	isOpenAISearchAvailable,
	searchWithCurrentModelOpenAI,
	searchWithOpenAI,
} from "./openai-search.ts";
import { isParallelAvailable, searchWithParallel } from "./parallel.ts";
import { isParallelMcpAvailable, searchWithParallelMcp } from "./parallel-mcp.ts";
import {
	isPerplexityAvailable,
	type SearchOptions,
	type SearchResponse,
	type SearchResult,
	searchWithPerplexity,
} from "./perplexity.ts";
import { isQueritAvailable, searchWithQuerit } from "./querit.ts";
import { isSearch1APIAvailable, searchWithSearch1API } from "./search1api.ts";
import { isSearchinfinityAvailable, searchWithSearchinfinity } from "./searchinfinity.ts";
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
import { isSerpBaseAvailable, searchWithSerpBase } from "./serpbase.ts";
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
import { isSerperAvailable, searchWithSerper } from "./serper.ts";
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
import { isTinyFishAvailable, searchWithTinyFish } from "./tinyfish.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { isValyuAvailable, searchWithValyu } from "./valyu.ts";
import { isXaiSearchAvailable, searchWithXai } from "./xai-search.ts";

export const RESOLVED_SEARCH_PROVIDERS = [
	"openai",
	"brave",
	"parallel",
	"parallel-mcp",
	"tinyfish",
	"search1api",
	"searchinfinity",
	"querit",
	"tavily",
	"firecrawl",
	"jina",
	"searxng",
	"duckduckgo",
	"perplexity",
	"gemini",
	"kimi",
	"exa",
	"serpdive",
	"kagi",
	"ollama",
	"anysearch",
	"xai",
	"brightdata",
	"serpbase",
	"serper",
	"valyu",
	"bocha",
] as const;
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;

export type ResolvedSearchProvider = (typeof RESOLVED_SEARCH_PROVIDERS)[number];
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export interface ProviderSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface ProviderSearchFailure {
	provider: ResolvedSearchProvider;
	error: string;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider | "all";
	providerResponses?: ProviderSearchResponse[];
	providerErrors?: ProviderSearchFailure[];
}

const CONFIG_PATH = getWebSearchConfigPath();
const DEFAULT_SEARCH_MODEL = "gemini-3.6-flash";
// Explicit-only providers (Parallel MCP, DuckDuckGo, Kimi, AnySearch, xAI, Bright Data, SerpBase, Serper, Valyu) are deliberately absent:
// `all` must never fan out to an opt-in or paid provider without the user asking for it.
const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = [
	"searxng",
	"openai",
	"exa",
	"brave",
	"parallel",
	"tinyfish",
	"search1api",
	"searchinfinity",
	"querit",
	"tavily",
	"firecrawl",
	"jina",
	"serpdive",
	"kagi",
	"ollama",
	"perplexity",
	"gemini",
	"bocha",
];
type SearchConfig = {
	searchProvider: SearchProviderSelection;
	searchModel?: string;
};

let cachedSearchConfig: SearchConfig | null = null;

function getSearchConfig(): SearchConfig {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto" };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const searchModel = normalizeSearchModel(raw.searchModel);
	cachedSearchConfig = {
		searchProvider: normalizeSearchProviderSelection(
			raw.searchProvider ?? raw.provider,
			`provider in ${CONFIG_PATH}`,
		),
		...(searchModel ? { searchModel } : {}),
	};
	return cachedSearchConfig;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeResolvedProviderList(value: unknown, label: string): ResolvedSearchProvider[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	const providers: ResolvedSearchProvider[] = [];
	for (const provider of value) {
		const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!RESOLVED_SEARCH_PROVIDERS.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} contains an invalid provider: ${String(provider)}`);
		}
		if (providers.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} must not contain duplicates: ${normalized}`);
		}
		providers.push(normalized as ResolvedSearchProvider);
	}
	return providers;
}

export function normalizeSearchProviderSelection(value: unknown, label = "provider"): SearchProviderSelection {
	if (Array.isArray(value)) return normalizeResolvedProviderList(value, label);
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return SEARCH_PROVIDERS.includes(normalized as SearchProvider) ? (normalized as SearchProvider) : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProviderSelection;
	includeContent?: boolean;
	extensionContext?: ExtensionContext;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	strictErrors: boolean,
): Promise<SearchResponse | null> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		if (apiResult) return apiResult;
	} catch (err) {
		if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
		errors.push(`Gemini API: ${errorMessage(err)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		if (webResult) return webResult;
		const diagnostic = getGeminiWebAvailabilityDiagnostic();
		if (diagnostic) errors.push(`Gemini Web: ${diagnostic}`);
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini Web: ${errorMessage(err)}`);
	}

	if (strictErrors && errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	return null;
}

async function searchWithResolvedProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
	useCurrentModel = false,
): Promise<AttributedSearchResponse> {
	if (provider === "openai") {
		const result = useCurrentModel
			? await searchWithCurrentModelOpenAI(query, options, options.extensionContext)
			: await searchWithOpenAI(query, options, options.extensionContext);
		return { ...result, provider };
	}
	if (provider === "brave") return { ...(await searchWithBrave(query, options)), provider };
	if (provider === "parallel") return { ...(await searchWithParallel(query, options)), provider };
	if (provider === "parallel-mcp") return { ...(await searchWithParallelMcp(query, options)), provider };
	if (provider === "tinyfish") return { ...(await searchWithTinyFish(query, options)), provider };
	if (provider === "search1api") return { ...(await searchWithSearch1API(query, options)), provider };
	if (provider === "searchinfinity") return { ...(await searchWithSearchinfinity(query, options)), provider };
	if (provider === "querit") return { ...(await searchWithQuerit(query, options)), provider };
	if (provider === "tavily") return { ...(await searchWithTavily(query, options)), provider };
	if (provider === "firecrawl") return { ...(await searchWithFirecrawl(query, options)), provider };
	if (provider === "jina") return { ...(await searchWithJina(query, options)), provider };
	if (provider === "serpdive") return { ...(await searchWithSerpdive(query, options)), provider };
	if (provider === "kagi") return { ...(await searchWithKagi(query, options)), provider };
	if (provider === "bocha") return { ...(await searchWithBocha(query, options)), provider };
	if (provider === "ollama") return { ...(await searchWithOllama(query, options)), provider };
	if (provider === "anysearch") return { ...(await searchWithAnySearch(query, options)), provider };
	if (provider === "xai") return { ...(await searchWithXai(query, options, options.extensionContext)), provider };
	if (provider === "brightdata") return { ...(await searchWithBrightData(query, options)), provider };
	if (provider === "serpbase") return { ...(await searchWithSerpBase(query, options)), provider };
	if (provider === "serper") return { ...(await searchWithSerper(query, options)), provider };
	if (provider === "valyu") return { ...(await searchWithValyu(query, options)), provider };
	if (provider === "perplexity") return { ...(await searchWithPerplexity(query, options)), provider };
	if (provider === "searxng") return { ...(await searchWithSearXNG(query, options)), provider };
	if (provider === "duckduckgo") return { ...(await searchWithDuckDuckGo(query, options)), provider };
	if (provider === "kimi") return { ...(await searchWithKimi(query, options, options.extensionContext)), provider };
	if (provider === "gemini") {
		const result = await searchWithGemini(query, options, true);
		if (result) return { ...result, provider };
		throw new Error(
			"Gemini search unavailable. Either:\n" +
				`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
				"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
				'  3. Set geminiAuth to "adc" in web-search.json with a Google Cloud ADC + project/location\n' +
				"  4. Sign into gemini.google.com in a supported Chromium-based browser",
		);
	}
	const result = await searchWithExa(query, options);
	if (result) return { ...result, provider };
	throw new Error("Exa search returned no results.");
}

async function isResolvedProviderAvailable(
	provider: ResolvedSearchProvider,
	options: FullSearchOptions,
	useCurrentModel = false,
): Promise<boolean> {
	if (provider === "openai") {
		return useCurrentModel
			? isCurrentModelHostedSearchEligible(options.extensionContext)
			: isOpenAISearchAvailable(options.extensionContext);
	}
	if (provider === "brave") return isBraveAvailable();
	if (provider === "parallel") return isParallelAvailable();
	if (provider === "parallel-mcp") return isParallelMcpAvailable();
	if (provider === "tinyfish") return isTinyFishAvailable();
	if (provider === "search1api") return isSearch1APIAvailable();
	if (provider === "searchinfinity") return isSearchinfinityAvailable();
	if (provider === "querit") return isQueritAvailable();
	if (provider === "tavily") return isTavilyAvailable();
	if (provider === "firecrawl") return isFirecrawlAvailable();
	if (provider === "jina") return isJinaSearchAvailable();
	if (provider === "serpdive") return isSerpdiveAvailable();
	if (provider === "kagi") return isKagiAvailable();
	if (provider === "bocha") return isBochaAvailable();
	if (provider === "ollama") return isOllamaAvailable();
	if (provider === "anysearch") return isAnySearchAvailable();
	if (provider === "xai") return isXaiSearchAvailable(options.extensionContext);
	if (provider === "brightdata") return isBrightDataAvailable();
	if (provider === "serpbase") return isSerpBaseAvailable();
	if (provider === "serper") return isSerperAvailable();
	if (provider === "valyu") return isValyuAvailable();
	if (provider === "perplexity") return isPerplexityAvailable();
	if (provider === "searxng") return isSearXNGAvailable();
	if (provider === "duckduckgo") return isDuckDuckGoAvailable();
	if (provider === "gemini") return isGeminiApiAvailable() || (await isGeminiWebOptionallyAvailable());
	if (provider === "kimi") return isKimiSearchAvailable(options.extensionContext);
	return isExaAvailable();
}

async function isGeminiWebOptionallyAvailable(): Promise<boolean> {
	try {
		return !!(await isGeminiWebAvailable());
	} catch {
		return false;
	}
}

function providerLabel(provider: ResolvedSearchProvider): string {
	if (provider === "openai") return "OpenAI";
	if (provider === "parallel-mcp") return "Parallel MCP";
	if (provider === "tinyfish") return "TinyFish";
	if (provider === "search1api") return "Search1API";
	if (provider === "searchinfinity") return "Searchinfinity";
	if (provider === "querit") return "Querit";
	if (provider === "firecrawl") return "Firecrawl";
	if (provider === "serpdive") return "SERPdive";
	if (provider === "searxng") return "SearXNG";
	if (provider === "duckduckgo") return "DuckDuckGo";
	if (provider === "kagi") return "Kagi";
	if (provider === "bocha") return "Bocha";
	if (provider === "kimi") return "Kimi";
	if (provider === "ollama") return "Ollama";
	if (provider === "xai") return "xAI";
	if (provider === "brightdata") return "Bright Data";
	if (provider === "serpbase") return "SerpBase";
	if (provider === "serper") return "Serper";
	if (provider === "valyu") return "Valyu";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

async function searchWithAllProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Promise<AttributedSearchResponse> {
	if (provider !== "gemini") return searchWithResolvedProvider(provider, query, options);
	const result = await searchWithGeminiApi(query, options);
	if (result) return { ...result, provider };
	throw new Error("Gemini API search returned no results.");
}

async function searchWithProviders(
	query: string,
	options: FullSearchOptions,
	selectedProviders?: ResolvedSearchProvider[],
): Promise<AttributedSearchResponse> {
	const providers =
		selectedProviders ??
		(
			await Promise.all(
				ALL_SEARCH_PROVIDERS.map(async (provider) => ({
					provider,
					available:
						provider === "gemini" ? isGeminiApiAvailable() : await isResolvedProviderAvailable(provider, options),
				})),
			)
		)
			.filter((entry) => entry.available)
			.map((entry) => entry.provider);
	if (providers.length === 0) {
		throw new Error(
			'No configured search provider available for provider "all". Parallel MCP, DuckDuckGo, Kimi, AnySearch, xAI, Bright Data, SerpBase, Serper, and Valyu are excluded.',
		);
	}

	const settled = await Promise.allSettled(
		providers.map((provider) =>
			selectedProviders
				? searchWithResolvedProvider(provider, query, options)
				: searchWithAllProvider(provider, query, options),
		),
	);
	if (options.signal?.aborted) throw new Error("Aborted");

	const successes: AttributedSearchResponse[] = [];
	const failures: Array<{ provider: ResolvedSearchProvider; error: string }> = [];
	for (let index = 0; index < settled.length; index++) {
		const outcome = settled[index];
		if (outcome.status === "fulfilled") {
			successes.push(outcome.value);
		} else {
			failures.push({ provider: providers[index], error: errorMessage(outcome.reason) });
		}
	}
	if (successes.length === 0) {
		const label = selectedProviders ? "Selected-provider" : "All-provider";
		throw new Error(
			`${label} search failed:\n  - ${failures.map(({ provider, error }) => `${providerLabel(provider)}: ${error}`).join("\n  - ")}`,
		);
	}

	const results: SearchResult[] = [];
	const seenResultUrls = new Set<string>();
	const inlineContent: NonNullable<SearchResponse["inlineContent"]> = [];
	const seenInlineUrls = new Set<string>();
	for (const response of successes) {
		for (const result of response.results) {
			if (seenResultUrls.has(result.url)) continue;
			seenResultUrls.add(result.url);
			results.push(result);
		}
		for (const content of response.inlineContent ?? []) {
			if (seenInlineUrls.has(content.url)) continue;
			seenInlineUrls.add(content.url);
			inlineContent.push(content);
		}
	}

	const answerSections = successes.map(
		(response) =>
			`## ${providerLabel(response.provider as ResolvedSearchProvider)}\n\n${response.answer || "(No answer text returned.)"}`,
	);
	if (failures.length > 0) {
		answerSections.push(
			`## Provider errors\n\n${failures.map(({ provider, error }) => `- **${providerLabel(provider)}:** ${error}`).join("\n")}`,
		);
	}

	return {
		provider: "all",
		answer: answerSections.join("\n\n"),
		results,
		providerResponses: successes as ProviderSearchResponse[],
		...(failures.length > 0 ? { providerErrors: failures } : {}),
		...(inlineContent.length > 0 ? { inlineContent } : {}),
	};
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider =
		options.provider === undefined || options.provider === "auto" ? config.searchProvider : options.provider;
	if (Array.isArray(provider)) {
		return searchWithProviders(query, options, normalizeResolvedProviderList(provider, "provider"));
	}
	if (provider === "all") return searchWithProviders(query, options);
	if (provider !== "auto") return searchWithResolvedProvider(provider, query, options);
	return runEulerSearchRoute("auto", async (candidate) => {
		if (candidate !== "exa") {
			return searchWithResolvedProvider(candidate as ResolvedSearchProvider, query, options);
		}
		const result = await searchWithExaMcp(query, options);
		if (result) return { ...result, provider: "exa" };
		throw new Error("Exa MCP search returned no results.");
	});
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const requestSignal = AbortSignal.any([AbortSignal.timeout(120000), ...(options.signal ? [options.signal] : [])]);
	const apiKey = isGeminiAdcAvailable() ? null : await getApiKey(requestSignal);
	if (!apiKey && !isGatewayConfigured() && !isGeminiAdcAvailable()) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;
		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetchGeminiApi(
			`${getVersionedApiBase()}/models/${model}:generateContent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: requestSignal,
			},
			apiKey,
		);

		if (!res.ok) {
			const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await res.json()) as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer =
			data.candidates?.[0]?.content?.parts
				?.map((p) => p.text)
				.filter(Boolean)
				.join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			signal: options.signal,
			timeoutMs: 120000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter((d) => !d.startsWith("-"));
		const excludes = options.domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
