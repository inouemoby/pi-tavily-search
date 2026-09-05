import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_MAX_RESULTS = 20;
const DEFAULT_MAX_IMAGES = 20;
const MAX_IMAGES = 100;

const imageSearchSchema = Type.Object({
  query: Type.String({
    description: "Image search query. Be specific, for example: '鸣潮 官方角色立绘'.",
    minLength: 1,
  }),
  search_depth: Type.Optional(
    Type.Union([
      Type.Literal("basic"),
      Type.Literal("advanced"),
    ], {
      description:
        "Tavily search depth. Defaults to basic. Use advanced only when basic results are insufficient.",
      default: "basic",
    }),
  ),
  max_results: Type.Optional(
    Type.Integer({
      description:
        "Maximum Tavily source results. Tavily allows up to 20; defaults to 20 for both basic and advanced search.",
      minimum: 1,
      maximum: TAVILY_MAX_RESULTS,
      default: TAVILY_MAX_RESULTS,
    }),
  ),
  max_images: Type.Optional(
    Type.Integer({
      description:
        "Maximum image URL pairs returned by the tool. Defaults to 20; use a smaller value to keep context compact.",
      minimum: 1,
      maximum: MAX_IMAGES,
      default: DEFAULT_MAX_IMAGES,
    }),
  ),
});

type ImageSearchParams = Static<typeof imageSearchSchema>;

type TavilyImage = {
  url?: unknown;
  title?: unknown;
};

type TavilyResult = {
  url?: unknown;
  title?: unknown;
  images?: TavilyImage[];
};

type TavilyResponse = {
  images?: TavilyImage[];
  results?: TavilyResult[];
};

type ImagePair = {
  image_url: string;
  page_url: string;
};

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function comparableTitle(value: unknown): string {
  return typeof value === "string"
    ? value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim()
    : "";
}

function addPair(pairs: ImagePair[], seen: Set<string>, image: unknown, page: unknown): void {
  const imageUrl = httpUrl(image);
  const pageUrl = httpUrl(page);
  if (!imageUrl || !pageUrl || seen.has(imageUrl)) return;
  seen.add(imageUrl);
  pairs.push({ image_url: imageUrl, page_url: pageUrl });
}

function extractImagePairs(data: TavilyResponse, maxImages: number): ImagePair[] {
  const results = Array.isArray(data.results) ? data.results : [];
  const pairs: ImagePair[] = [];
  const seen = new Set<string>();

  // Tavily's top-level images are the most relevant images for the query. Their
  // response does not include a page URL, so resolve it from the matching result
  // title or from a result-level image entry before returning it.
  const topImages = Array.isArray(data.images) ? data.images : [];
  for (const image of topImages) {
    if (pairs.length >= maxImages) break;
    const imageUrl = httpUrl(image?.url);
    if (!imageUrl) continue;

    const matchingResult = results.find((result) => {
      const imageTitle = comparableTitle(image?.title);
      const resultTitle = comparableTitle(result.title);
      return imageTitle.length > 0 && resultTitle.length > 0 &&
        (imageTitle === resultTitle || imageTitle.includes(resultTitle) || resultTitle.includes(imageTitle));
    });

    const matchingImageResult = results.find((result) =>
      Array.isArray(result.images) && result.images.some((resultImage) => resultImage?.url === imageUrl),
    );

    addPair(pairs, seen, imageUrl, matchingResult?.url ?? matchingImageResult?.url);
  }

  // Fill remaining slots with page images whose source page URL is explicit in
  // the result object. The page text/content is intentionally discarded.
  for (const result of results) {
    if (pairs.length >= maxImages) break;
    const pageUrl = httpUrl(result.url);
    if (!pageUrl || !Array.isArray(result.images)) continue;
    for (const image of result.images) {
      if (pairs.length >= maxImages) break;
      addPair(pairs, seen, image?.url, pageUrl);
    }
  }

  return pairs;
}

// A placeholder is needed for Pi's legacy provider registration to expose the
// provider in `/login`, while Tavily itself is never used as an LLM model.
const loginOnlyModel = {
  id: "login-required",
  name: "Login required — use /login tavily",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
};

export default function (pi: ExtensionAPI) {
  pi.registerProvider("tavily", {
    name: "Tavily",
    baseUrl: "https://api.tavily.com",
    apiKey: "$TAVILY_API_KEY",
    api: "openai-completions",
    models: [loginOnlyModel],
  });

  pi.registerTool({
    name: "tavily_image_search",
    label: "Tavily Image Search",
    description:
      "Search images with Tavily and return only image URLs plus their corresponding source page URLs. Never return webpage text, snippets, descriptions, or raw content. Defaults to Tavily basic search with its maximum of 20 source results; advanced search is available when explicitly requested.",
    promptSnippet: "Search images with Tavily; return image URLs and source page URLs only",
    promptGuidelines: [
      "Use this tool only for image search.",
      "The result contains only image_url and page_url pairs; do not fetch or summarize webpage content unless the user separately asks.",
      "search_depth defaults to basic. Use advanced only when basic results are insufficient.",
    ],
    parameters: imageSearchSchema,
    async execute(
      _toolCallId: string,
      params: ImageSearchParams,
      signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const auth = await ctx.modelRegistry.getAuth("tavily", { signal });
      const apiKey = auth?.auth.apiKey;
      if (!apiKey) {
        throw new Error("Tavily API key is not configured. Run /login tavily first.");
      }

      const searchDepth = params.search_depth ?? "basic";
      const maxResults = Math.min(params.max_results ?? TAVILY_MAX_RESULTS, TAVILY_MAX_RESULTS);
      const maxImages = Math.min(params.max_images ?? DEFAULT_MAX_IMAGES, MAX_IMAGES);

      const response = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: params.query,
          search_depth: searchDepth,
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: true,
          include_image_descriptions: false,
          include_favicon: false,
        }),
        signal,
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(`Tavily image search failed (${response.status}): ${message.slice(0, 500)}`);
      }

      const data = (await response.json()) as TavilyResponse;
      const images = extractImagePairs(data, maxImages);
      const output = JSON.stringify({
        query: params.query,
        search_depth: searchDepth,
        images,
      }, null, 2);

      return {
        content: [{ type: "text", text: output }],
        details: {
          query: params.query,
          search_depth: searchDepth,
          count: images.length,
          max_results: maxResults,
          max_images: maxImages,
        },
      };
    },
  });
}
