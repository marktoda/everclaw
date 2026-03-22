import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchTools } from "./search.ts";
import type { ExecutorDeps } from "./types.ts";

const webSearch = searchTools[0];
const searchServers = searchTools[1];

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return { searchApiKey: undefined, ...overrides } as ExecutorDeps;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("web_search", () => {
  it("returns error when API key is not set", async () => {
    const result = await webSearch.execute({ query: "test" }, makeDeps());
    expect(result).toBe("Error: web search not configured (BRAVE_SEARCH_API_KEY not set)");
  });

  it("returns error for empty query", async () => {
    const result = await webSearch.execute({ query: "  " }, makeDeps({ searchApiKey: "key" }));
    expect(result).toBe("Error: query is required");
  });

  it("returns error on non-200 response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: false, status: 429 } as Response);
    const result = await webSearch.execute({ query: "test" }, makeDeps({ searchApiKey: "key" }));
    expect(result).toBe("Error: search API returned 429");
  });

  it("returns formatted results on success", async () => {
    const body = {
      web: {
        results: [
          { title: "Result One", url: "https://one.com", description: "First result" },
          { title: "Result Two", url: "https://two.com" },
        ],
      },
    };
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);

    const result = await webSearch.execute({ query: "test" }, makeDeps({ searchApiKey: "key" }));
    expect(result).toContain("**Result One**");
    expect(result).toContain("https://one.com");
    expect(result).toContain("First result");
    expect(result).toContain("**Result Two**");
    expect(result).toContain("https://two.com");
  });

  it("returns no results message when results array is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ web: { results: [] } }),
    } as Response);
    const result = await webSearch.execute({ query: "obscure" }, makeDeps({ searchApiKey: "key" }));
    expect(result).toBe("No results found.");
  });
});

describe("search_servers", () => {
  it("returns error on non-200 registry response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: false, status: 500 } as Response);
    const result = await searchServers.execute({ query: "github" }, makeDeps());
    expect(result).toBe("Error: MCP registry returned 500");
  });

  it("returns no servers message when results are empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ servers: [] }),
    } as Response);
    const result = await searchServers.execute({ query: "nonexistent" }, makeDeps());
    expect(result).toBe('No servers found matching "nonexistent".');
  });

  it("returns formatted server list with npm install commands", async () => {
    const body = {
      servers: [
        {
          name: "github-server",
          description: "GitHub integration",
          packages: [
            { registryType: "npm", identifier: "@mcp/github", transport: { type: "stdio" } },
          ],
        },
        {
          name: "bare-server",
          description: "No packages",
        },
      ],
    };
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);

    const result = await searchServers.execute({ query: "github" }, makeDeps());
    expect(result).toContain('Found 2 server(s) matching "github"');
    expect(result).toContain("1. github-server");
    expect(result).toContain("GitHub integration");
    expect(result).toContain("Install: npx -y @mcp/github");
    expect(result).toContain("Transport: stdio");
    expect(result).toContain("2. bare-server");
  });

  it("returns error message on fetch failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));
    const result = await searchServers.execute({ query: "test" }, makeDeps());
    expect(result).toBe("Error: failed to query MCP registry: network error");
  });
});
