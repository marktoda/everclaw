import type { ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  transport?: { type?: string };
}

interface RegistryServer {
  name: string;
  description?: string;
  packages?: RegistryPackage[];
}

interface RegistryResponse {
  servers?: RegistryServer[];
  metadata?: { count?: number };
}

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
  {
    def: defineTool(
      "search_servers",
      "Search the official MCP server registry to find servers that provide tools for a given capability (e.g. 'github', 'postgres', 'slack'). Returns server names, descriptions, and install commands.",
      {
        query: { type: "string", description: "Search query (e.g. 'github', 'database', 'email')" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      ["query"],
    ),
    async execute(input, _deps) {
      const { query, limit: rawLimit } = input as { query: string; limit?: number };
      const q = query.trim();
      if (!q) return "Error: query is required";
      const limit = Math.min(rawLimit ?? 10, 20);

      const url = `${MCP_REGISTRY_URL}?search=${encodeURIComponent(q)}&limit=${limit}`;
      let data: RegistryResponse;
      try {
        const resp = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return `Error: MCP registry returned ${resp.status}`;
        data = (await resp.json()) as RegistryResponse;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: failed to query MCP registry: ${msg}`;
      }

      const servers = data.servers ?? [];
      if (servers.length === 0) return `No servers found matching "${q}".`;

      return (
        `Found ${servers.length} server(s) matching "${q}":\n\n` +
        servers
          .map((s, i) => {
            const lines = [`${i + 1}. ${s.name}`];
            if (s.description) lines.push(`   ${s.description}`);
            const pkg = s.packages?.[0];
            if (pkg?.registryType === "npm" && pkg.identifier) {
              lines.push(`   Install: npx -y ${pkg.identifier}`);
            }
            if (pkg?.transport?.type) {
              lines.push(`   Transport: ${pkg.transport.type}`);
            }
            return lines.join("\n");
          })
          .join("\n\n")
      );
    },
  },
];
