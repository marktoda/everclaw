import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt.ts";

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

  it("includes date", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("includes workflow capabilities", () => {
    const p = buildSystemPrompt({ notes: "", skills: [], tools: [] });
    expect(p).toContain("Workflow Capabilities");
    expect(p).toContain("sleep_for");
    expect(p).toContain("spawn_task");
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
});
