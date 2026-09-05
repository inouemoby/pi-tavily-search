# pi-tavily-search

A Pi extension that provides **image search only** through Tavily.

The `image_search` tool returns only pairs of:

```json
{
  "image_url": "https://...",
  "page_url": "https://..."
}
```

It intentionally discards Tavily page titles, snippets, content, raw content, favicons, and image descriptions before returning the tool result.

## Setup

Install the package in Pi:

```text
pi install git:github.com/inouemoby/pi-tavily-search
```

Then configure the provider interactively:

```text
/login tavily
```

Pi stores the API key in its normal credential store. Alternatively, set `TAVILY_API_KEY`.

## Tool parameters

- `query`: image search query
- `search_depth`: `basic` (default) or `advanced`
- `max_results`: Tavily source-result count, default and maximum `20`
- `max_images`: returned image/page pairs, default `20`, maximum `100`

The request always sets `include_images: true` and disables answer, raw-content, favicon, and image-description fields. The extension never calls `web_fetch`.

## Notes

Tavily's top-level image results do not always include their source page URL. The extension returns only images for which it can resolve a corresponding page URL, using the matching result title or result-level image entries. Duplicate image URLs are removed.

The `tavily` provider deliberately exposes only a login-required placeholder model. It exists so Pi's `/login` flow can store and resolve Tavily API keys; it is not an LLM provider.
