import { describe, expect, it } from "vitest";
import { buildSystemPrompt, formatDateTime } from "./prompt.ts";

describe("formatDateTime", () => {
  it("formats a known date with day of week, readable date, time, and ISO", () => {
    // 2026-03-05T14:30:00Z is a Thursday
    const d = new Date("2026-03-05T14:30:00Z");
    const result = formatDateTime(d);
    expect(result).toBe("Thursday, March 5, 2026, 2:30 PM UTC (2026-03-05T14:30:00.000Z)");
  });

  it("handles midnight correctly", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const result = formatDateTime(d);
    expect(result).toContain("12:00 AM UTC");
    expect(result).toContain("Thursday");
  });
});

describe("buildSystemPrompt", () => {
  it("includes base instructions", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toContain("personal AI assistant");
  });

  it("includes notes", () => {
    const p = buildSystemPrompt({ notes: "Name: Alice", skills: [], tools: [] });
    expect(p).toContain("Name: Alice");
  });

  it("includes skill summaries", () => {
    const p = buildSystemPrompt({
      notes: "",
      skills: [{ name: "todo", description: "Manage TODOs", schedule: "0 9 * * *" }],
      tools: [],
    });
    expect(p).toContain("todo");
    expect(p).toContain("Manage TODOs");
  });

  it("includes date with day of week and timezone", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(p).toMatch(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/);
    expect(p).toContain("UTC");
  });

  it("includes workflow capabilities", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toContain("Workflow Capabilities");
    expect(p).toContain("sleep_for");
    expect(p).toContain("spawn_workflow");
    expect(p).toContain("spawn_skill");
    expect(p).toContain("send_message");
    expect(p).toContain("pending-action");
  });

  it("renders tool scripts with descriptions", () => {
    const p = buildSystemPrompt({
      notes: "",
      skills: [],
      tools: [{ name: "search-flights", description: "Search for flights" }],
    });
    expect(p).toContain("**search-flights**: Search for flights");
  });

  it("renders tool scripts without descriptions as plain names", () => {
    const p = buildSystemPrompt({
      notes: "",
      skills: [],
      tools: [{ name: "bare-script" }],
    });
    expect(p).toContain("- bare-script");
    expect(p).not.toContain("**bare-script**");
  });

  it("includes MCP server summaries with guidance", () => {
    const p = buildSystemPrompt({
      notes: "",
      skills: [],
      tools: [],
      mcpServers: [
        { name: "github", description: "GitHub tools" },
      ],
    });
    expect(p).toContain("MCP Servers");
    expect(p).toContain("github");
    expect(p).toContain("GitHub tools");
    expect(p).toContain("external integrations");
    expect(p).toContain("scripts");
  });

  it("omits MCP section when no servers configured", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [], mcpServers: [] });
    expect(p).not.toContain("MCP Servers");
  });

  it("includes extra directories with mode indicators", () => {
    const p = buildSystemPrompt({
      notes: "",
      skills: [],
      tools: [],
      extraDirs: [
        { name: "vaults", mode: "ro", absPath: "/mnt/vaults" },
        { name: "projects", mode: "rw", absPath: "/mnt/projects" },
      ],
    });
    expect(p).toContain("vaults/");
    expect(p).toContain("read-only");
    expect(p).toContain("projects/");
    expect(p).toContain("read-write");
  });

  it("includes MCP server discovery instructions", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toContain("search_servers");
    expect(p).toContain("approval");
  });

  it("omits extra directories section when none configured", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [], extraDirs: [] });
    expect(p).not.toContain("Extra Directories");
  });
});
