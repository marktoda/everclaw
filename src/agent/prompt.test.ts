import { describe, it, expect } from "vitest";
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
});
