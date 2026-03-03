import type { ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

export const searchTools: ToolHandler[] = [
  {
    def: defineTool(
      "web_search",
      "Search the web using Brave Search. Returns titles, URLs, and descriptions.",
      {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (default 5, max 20)" },
      },
      ["query"],
    ),
    async execute(input, deps) {
      if (!deps.searchApiKey)
        return "Error: web search not configured (BRAVE_SEARCH_API_KEY not set)";
      const { query, count: rawCount } = input as { query: string; count?: number };
      const q = query.trim();
      if (!q) return "Error: query is required";
      const count = Math.min(rawCount ?? 5, 20);
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`;
      const resp = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": deps.searchApiKey,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return `Error: search API returned ${resp.status}`;
      const data = (await resp.json()) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      const results = data.web?.results ?? [];
      if (results.length === 0) return "No results found.";
      return results.map((r) => `**${r.title}**\n${r.url}\n${r.description ?? ""}`).join("\n\n");
    },
  },
];
