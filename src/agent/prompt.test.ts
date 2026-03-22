import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt.ts";

const base = {
  pinnedNotes: "",
  availableNotes: [] as string[],
  skills: [] as any[],
  tools: [] as any[],
};

describe("buildSystemPrompt", () => {
  it("includes base instructions", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("personal AI assistant");
  });

  it("includes pinned notes", () => {
    const p = buildSystemPrompt({ ...base, pinnedNotes: "Name: Alice" });
    expect(p).toContain("## Your Notes");
    expect(p).toContain("Name: Alice");
  });

  it("omits Your Notes section when empty", () => {
    const p = buildSystemPrompt(base);
    expect(p).not.toContain("## Your Notes");
  });

  it("lists available notes by filename", () => {
    const p = buildSystemPrompt({
      ...base,
      availableNotes: ["slc-travel-guide.md", "research.md"],
    });
    expect(p).toContain("## Available Notes");
    expect(p).toContain("- data/notes/slc-travel-guide.md");
    expect(p).toContain("- data/notes/research.md");
  });

  it("omits Available Notes section when empty", () => {
    const p = buildSystemPrompt(base);
    expect(p).not.toContain("Available Notes");
  });

  it("truncates pinned notes over budget with warning", () => {
    const longNotes = "x".repeat(10000);
    const p = buildSystemPrompt({ ...base, pinnedNotes: longNotes, pinnedNotesBudget: 8192 });
    expect(p).toContain("## Your Notes");
    expect(p).not.toContain("x".repeat(10000));
    expect(p).toContain("pinned notes exceed");
  });

  it("includes skill summaries", () => {
    const p = buildSystemPrompt({
      ...base,
      skills: [{ name: "todo", description: "Manage TODOs", schedule: "0 9 * * *" }],
    });
    expect(p).toContain("todo");
    expect(p).toContain("Manage TODOs");
  });

  it("includes date", () => {
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("includes workflow capabilities", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("Workflow Capabilities");
    expect(p).toContain("sleep_for");
    expect(p).toContain("spawn_workflow");
    expect(p).toContain("spawn_skill");
    expect(p).toContain("send_message");
    expect(p).toContain("pending-action");
  });

  it("renders tool scripts with descriptions", () => {
    const p = buildSystemPrompt({
      ...base,
      tools: [{ name: "search-flights", description: "Search for flights" }],
    });
    expect(p).toContain("**search-flights**: Search for flights");
  });

  it("renders tool scripts without descriptions as plain names", () => {
    const p = buildSystemPrompt({ ...base, tools: [{ name: "bare-script" }] });
    expect(p).toContain("- bare-script");
    expect(p).not.toContain("**bare-script**");
  });

  it("includes MCP server summaries with guidance", () => {
    const p = buildSystemPrompt({
      ...base,
      mcpServers: [{ name: "github", description: "GitHub tools" }],
    });
    expect(p).toContain("MCP Servers");
    expect(p).toContain("github");
    expect(p).toContain("GitHub tools");
    expect(p).toContain("external integrations");
    expect(p).toContain("scripts");
  });

  it("omits MCP section when no servers configured", () => {
    const p = buildSystemPrompt({ ...base, mcpServers: [] });
    expect(p).not.toContain("MCP Servers");
  });

  it("includes extra directories with mode indicators", () => {
    const p = buildSystemPrompt({
      ...base,
      extraDirs: [
        { name: "vaults", mode: "ro" as const, absPath: "/mnt/vaults" },
        { name: "projects", mode: "rw" as const, absPath: "/mnt/projects" },
      ],
    });
    expect(p).toContain("vaults/");
    expect(p).toContain("read-only");
    expect(p).toContain("projects/");
    expect(p).toContain("read-write");
  });

  it("includes MCP server discovery instructions", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("search_servers");
    expect(p).toContain("approval");
  });

  it("omits extra directories section when none configured", () => {
    const p = buildSystemPrompt({ ...base, extraDirs: [] });
    expect(p).not.toContain("Extra Directories");
  });

  it("includes notes tier descriptions in tool instructions", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("data/notes/pinned/");
    expect(p).toContain("data/notes/temp/");
    expect(p).toContain("Agent scratch space");
  });

  it("includes cron expression for skills with a schedule", () => {
    const p = buildSystemPrompt({
      ...base,
      skills: [{ name: "daily-digest", description: "Send daily digest", schedule: "0 9 * * *" }],
    });
    expect(p).toContain("(scheduled: 0 9 * * *)");
  });

  it("omits schedule info for skills without a schedule field", () => {
    const p = buildSystemPrompt({
      ...base,
      skills: [{ name: "on-demand", description: "Run on demand" }],
    });
    expect(p).toContain("**on-demand**: Run on demand");
    expect(p).not.toContain("scheduled:");
  });

  it("renders extra directories in the prompt", () => {
    const p = buildSystemPrompt({
      ...base,
      extraDirs: [{ name: "docs", mode: "ro" as const, absPath: "/mnt/docs" }],
    });
    expect(p).toContain("Extra Directories");
    expect(p).toContain("docs/");
    expect(p).toContain("User-mounted directory");
  });

  it("renders MCP servers with descriptions", () => {
    const p = buildSystemPrompt({
      ...base,
      mcpServers: [
        { name: "github", description: "GitHub API tools" },
        { name: "slack", description: "Slack integration" },
      ],
    });
    expect(p).toContain("## MCP Servers");
    expect(p).toContain("**github**: GitHub API tools");
    expect(p).toContain("**slack**: Slack integration");
  });

  it("omits skills section when skills array is empty", () => {
    const p = buildSystemPrompt({ ...base, skills: [] });
    expect(p).not.toContain("Available Skills");
  });

  it("omits tool scripts section when tools array is empty", () => {
    const p = buildSystemPrompt({ ...base, tools: [] });
    expect(p).not.toContain("Available Tool Scripts");
  });
});
