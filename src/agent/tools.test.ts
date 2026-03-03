import { describe, it, expect } from "vitest";
import { getTools } from "./tools.ts";

describe("getTools", () => {
  it("returns all 16 tools", () => {
    const tools = getTools();
    expect(tools).toHaveLength(16);
  });

  it("returns file tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("list_files");
    expect(names).toContain("delete_file");
  });

  it("returns state tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("get_state");
    expect(names).toContain("set_state");
    expect(names).toContain("get_status");
  });

  it("returns script tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("run_script");
  });

  it("returns web tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("web_search");
  });

  it("returns orchestration tools", () => {
    const names = getTools().map(t => t.name);
    expect(names).toContain("sleep_for");
    expect(names).toContain("sleep_until");
    expect(names).toContain("spawn_task");
    expect(names).toContain("cancel_task");
    expect(names).toContain("list_tasks");
    expect(names).toContain("wait_for_event");
    expect(names).toContain("emit_event");
  });

  it("each tool has proper schema", () => {
    for (const tool of getTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema.type).toBe("object");
    }
  });
});
