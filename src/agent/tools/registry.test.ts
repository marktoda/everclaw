import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./index.ts";

// ---------------------------------------------------------------------------
// Mocks — all external I/O is stubbed so tests are fast and deterministic.
// ---------------------------------------------------------------------------

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn(),
  chmod: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("../../memory/state.ts", () => ({
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("../../skills/manager.ts", () => ({
  listSkills: vi.fn(),
  syncSchedules: vi.fn(),
}));

vi.mock("../../scripts/runner.ts", () => ({
  runScript: vi.fn(),
  listScripts: vi.fn(),
}));

// Import mocked modules so we can configure per-test return values.
import * as fs from "node:fs/promises";
import { TimeoutError } from "absurd-sdk";
import { getState, setState } from "../../memory/state.ts";
import { listScripts, runScript } from "../../scripts/runner.ts";
import { listSkills, syncSchedules } from "../../skills/manager.ts";

import { createToolRegistry } from "./index.ts";

// ---------------------------------------------------------------------------
// Helpers to build the deps / mock objects
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    absurd: {
      spawn: vi.fn(),
      cancelTask: vi.fn(),
      listSchedules: vi.fn().mockResolvedValue([]),
    } as any,
    pool: {
      query: vi.fn(),
    } as any,
    ctx: {
      sleepFor: vi.fn(),
      sleepUntil: vi.fn(),
      awaitEvent: vi.fn(),
      emitEvent: vi.fn(),
    } as any,
    queueName: "test_queue",
    recipientId: "telegram:42",
    notesDir: "/data/notes",
    skillsDir: "/data/skills",
    scriptsDir: "/data/scripts",
    serversDir: "/data/servers",
    scriptTimeout: 30,
    scriptEnv: {},
    startedAt: new Date("2025-01-01T00:00:00Z"),
    extraDirs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registry", () => {
  let deps: ExecutorDeps;
  let exec: (name: string, input: Record<string, any>) => Promise<string>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: realpath returns the input path (no symlinks)
    vi.mocked(fs.realpath as (p: string) => Promise<string>).mockImplementation(
      async (p) => p,
    );
    deps = makeDeps();
    const registry = createToolRegistry(deps);
    exec = registry.execute;
  });

  // =========================================================================
  // isContainedIn (tested indirectly via resolvePath + tool calls)
  // =========================================================================
  describe("isContainedIn / resolvePath path-safety", () => {
    it("accepts a file directly inside the notes directory", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("hello");
      const result = await exec("read_file", { path: "data/notes/foo.txt" });
      expect(fs.readFile).toHaveBeenCalledWith(path.resolve("/data/notes", "foo.txt"), "utf-8");
      expect(result).toBe("hello");
    });

    it("accepts a nested file inside notes", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("nested");
      await exec("read_file", { path: "data/notes/sub/deep/file.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/notes", "sub/deep/file.md"),
        "utf-8",
      );
    });

    it("rejects path traversal escaping notes via ../", async () => {
      const result = await exec("read_file", {
        path: "data/notes/../../etc/passwd",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("rejects path traversal with single ../", async () => {
      const result = await exec("read_file", {
        path: "data/notes/../secret",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("rejects a completely invalid prefix", async () => {
      const result = await exec("read_file", { path: "/etc/passwd" });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("rejects a prefix that is close but wrong", async () => {
      const result = await exec("read_file", { path: "data/other/f.txt" });
      expect(result).toMatch(/Error/);
    });

    it("rejects traversal from skills/ directory", async () => {
      const result = await exec("read_file", {
        path: "skills/../../../etc/shadow",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("rejects traversal from scripts/ directory", async () => {
      const result = await exec("read_file", {
        path: "scripts/../../secret",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("accepts files in the servers directory", async () => {
      vi.mocked(fs.readFile).mockResolvedValue('{"command":"npx"}');
      const result = await exec("read_file", { path: "servers/github.json" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/servers", "github.json"),
        "utf-8",
      );
      expect(result).toBe('{"command":"npx"}');
    });

    it("rejects paths that escape the servers directory", async () => {
      const result = await exec("read_file", {
        path: "servers/../../etc/passwd",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("handles leading ./ prefix by stripping it", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("ok");
      await exec("read_file", { path: "./data/notes/readme.md" });
      expect(fs.readFile).toHaveBeenCalledWith(path.resolve("/data/notes", "readme.md"), "utf-8");
    });

    it("handles leading / prefix by stripping it", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("ok");
      await exec("read_file", { path: "/data/notes/readme.md" });
      expect(fs.readFile).toHaveBeenCalledWith(path.resolve("/data/notes", "readme.md"), "utf-8");
    });
  });

  // =========================================================================
  // symlink escape protection (validateRealPath)
  // =========================================================================
  describe("symlink escape protection", () => {
    it("rejects read_file through a symlink that escapes the sandbox", async () => {
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValue(
        "/etc/passwd",
      );
      const result = await exec("read_file", { path: "data/notes/leaked.md" });
      expect(result).toMatch(/symlink/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("rejects write_file through a symlink that escapes the sandbox", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValue(
        "/etc/shadow",
      );
      const result = await exec("write_file", {
        path: "data/notes/evil.md",
        content: "payload",
      });
      expect(result).toMatch(/symlink/);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("rejects delete_file through a symlink that escapes the sandbox", async () => {
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValue(
        "/etc/important",
      );
      const result = await exec("delete_file", { path: "data/notes/target.md" });
      expect(result).toMatch(/symlink/);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it("allows read_file when realpath stays within the sandbox", async () => {
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValue(
        "/data/notes/safe.md",
      );
      vi.mocked(fs.readFile).mockResolvedValue("content");
      const result = await exec("read_file", { path: "data/notes/safe.md" });
      expect(result).toBe("content");
    });

    it("allows write when file does not exist and parent is contained", async () => {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockRejectedValueOnce(
        enoent,
      );
      // Parent check succeeds — parent is contained
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValueOnce(
        "/data/notes",
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      const result = await exec("write_file", {
        path: "data/notes/new.md",
        content: "hello",
      });
      expect(result).toBe("File written: data/notes/new.md");
    });

    it("rejects write when file does not exist but parent escapes", async () => {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockRejectedValueOnce(
        enoent,
      );
      // Parent resolves outside sandbox
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValueOnce(
        "/etc",
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      const result = await exec("write_file", {
        path: "data/notes/sub/new.md",
        content: "payload",
      });
      expect(result).toMatch(/symlink/);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // resolvePath — directory mappings
  // =========================================================================
  describe("resolvePath directory mappings", () => {
    it("maps data/notes/ to notesDir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("content");
      await exec("read_file", { path: "data/notes/test.txt" });
      expect(fs.readFile).toHaveBeenCalledWith(path.resolve("/data/notes", "test.txt"), "utf-8");
    });

    it("maps skills/ to skillsDir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("skill content");
      await exec("read_file", { path: "skills/my-skill.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/skills", "my-skill.md"),
        "utf-8",
      );
    });

    it("maps scripts/ to scriptsDir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("tool content");
      await exec("read_file", { path: "scripts/my-tool.sh" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/scripts", "my-tool.sh"),
        "utf-8",
      );
    });
  });

  // =========================================================================
  // read_file
  // =========================================================================
  describe("read_file", () => {
    it("returns file content on success", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("file body");
      const result = await exec("read_file", { path: "data/notes/a.txt" });
      expect(result).toBe("file body");
    });

    it("returns '(file not found)' for ENOENT", async () => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fs.readFile).mockRejectedValue(err);
      const result = await exec("read_file", { path: "data/notes/missing.txt" });
      expect(result).toBe("(file not found)");
    });

    it("propagates non-ENOENT errors", async () => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      vi.mocked(fs.readFile).mockRejectedValue(err);
      await expect(exec("read_file", { path: "data/notes/noperm.txt" })).rejects.toThrow("EACCES");
    });

    it("returns error for invalid path", async () => {
      const result = await exec("read_file", { path: "invalid/path.txt" });
      expect(result).toMatch(/Error/);
    });
  });

  // =========================================================================
  // write_file
  // =========================================================================
  describe("write_file", () => {
    it("writes content and creates parent directories", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      const result = await exec("write_file", {
        path: "data/notes/sub/file.txt",
        content: "hello world",
      });
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.dirname(path.resolve("/data/notes", "sub/file.txt")),
        { recursive: true },
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.resolve("/data/notes", "sub/file.txt"),
        "hello world",
        "utf-8",
      );
      expect(result).toBe("File written: data/notes/sub/file.txt");
    });

    it("returns error for invalid path", async () => {
      const result = await exec("write_file", {
        path: "nowhere/file.txt",
        content: "x",
      });
      expect(result).toMatch(/Error/);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("rejects path traversal on write", async () => {
      const result = await exec("write_file", {
        path: "data/notes/../../etc/cron.d/evil",
        content: "payload",
      });
      expect(result).toMatch(/Error/);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("chmods to 0o755 when writing to scripts/", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "scripts/my-tool.sh",
        content: "#!/bin/bash\necho hi",
      });

      expect(fs.chmod).toHaveBeenCalledWith(path.resolve("/data/scripts", "my-tool.sh"), 0o755);
    });

    it("does NOT chmod when writing to notes/", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "data/notes/note.md",
        content: "# Note",
      });

      expect(fs.chmod).not.toHaveBeenCalled();
    });

    it("calls syncSchedules when writing to skills/", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(syncSchedules).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "skills/daily-report.md",
        content: "---\nschedule: 0 9 * * *\n---\nDo the report.",
      });

      expect(syncSchedules).toHaveBeenCalledWith(deps.absurd, "/data/skills", "telegram:42");
    });

    it("does NOT call syncSchedules when writing to scripts/", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "scripts/script.sh",
        content: "#!/bin/bash",
      });

      expect(syncSchedules).not.toHaveBeenCalled();
    });

    it("calls reloadMcp when writing to servers/", async () => {
      const reloadMcp = vi.fn().mockResolvedValue(undefined);
      deps = makeDeps({ reloadMcp });
      const registry = createToolRegistry(deps);
      exec = registry.execute;

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "servers/github.json",
        content: '{"command":"npx","args":["github-mcp"]}',
      });

      expect(reloadMcp).toHaveBeenCalledOnce();
    });

    it("does NOT call reloadMcp when writing to notes/", async () => {
      const reloadMcp = vi.fn().mockResolvedValue(undefined);
      deps = makeDeps({ reloadMcp });
      const registry = createToolRegistry(deps);
      exec = registry.execute;

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "data/notes/todo.md",
        content: "stuff",
      });

      expect(reloadMcp).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // list_files
  // =========================================================================
  describe("list_files", () => {
    it("lists files from notes directory", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["a.md", "b.txt"] as any);
      const result = await exec("list_files", { directory: "data/notes" });
      expect(result).toBe("a.md\nb.txt");
      expect(fs.readdir).toHaveBeenCalledWith("/data/notes");
    });

    it("lists files from skills directory", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["skill.md"] as any);
      const result = await exec("list_files", { directory: "skills" });
      expect(result).toBe("skill.md");
      expect(fs.readdir).toHaveBeenCalledWith("/data/skills");
    });

    it("lists files from scripts directory", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["tool.sh"] as any);
      const result = await exec("list_files", { directory: "scripts" });
      expect(result).toBe("tool.sh");
      expect(fs.readdir).toHaveBeenCalledWith("/data/scripts");
    });

    it("accepts trailing slash variants", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["x.md"] as any);
      const result = await exec("list_files", { directory: "data/notes/" });
      expect(result).toBe("x.md");
    });

    it("accepts leading ./ variant", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["x.md"] as any);
      const result = await exec("list_files", { directory: "./data/notes" });
      expect(result).toBe("x.md");
    });

    it("accepts leading / variant", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["x.md"] as any);
      const result = await exec("list_files", { directory: "/skills/" });
      expect(result).toBe("x.md");
    });

    it("returns error for invalid directory", async () => {
      const result = await exec("list_files", { directory: "other" });
      expect(result).toMatch(/Error/);
    });

    it("returns '(empty directory)' when no files", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      const result = await exec("list_files", { directory: "data/notes" });
      expect(result).toBe("(empty directory)");
    });

    it("returns '(directory does not exist)' on readdir error", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
      const result = await exec("list_files", { directory: "data/notes" });
      expect(result).toBe("(directory does not exist)");
    });
  });

  // =========================================================================
  // delete_file
  // =========================================================================
  describe("delete_file", () => {
    it("deletes a file and returns confirmation", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      const result = await exec("delete_file", {
        path: "data/notes/old.txt",
      });
      expect(fs.unlink).toHaveBeenCalledWith(path.resolve("/data/notes", "old.txt"));
      expect(result).toBe("File deleted: data/notes/old.txt");
    });

    it("returns '(file not found)' for ENOENT", async () => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fs.unlink).mockRejectedValue(err);
      const result = await exec("delete_file", {
        path: "data/notes/gone.txt",
      });
      expect(result).toBe("(file not found)");
    });

    it("propagates non-ENOENT errors", async () => {
      const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
      vi.mocked(fs.unlink).mockRejectedValue(err);
      await expect(exec("delete_file", { path: "data/notes/locked.txt" })).rejects.toThrow("EPERM");
    });

    it("returns error for invalid path", async () => {
      const result = await exec("delete_file", { path: "invalid/x" });
      expect(result).toMatch(/Error/);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it("rejects path traversal", async () => {
      const result = await exec("delete_file", {
        path: "data/notes/../../important",
      });
      expect(result).toMatch(/Error/);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it("calls syncSchedules when deleting from skills/", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(syncSchedules).mockResolvedValue(undefined);

      await exec("delete_file", { path: "skills/old-skill.md" });

      expect(syncSchedules).toHaveBeenCalledWith(deps.absurd, "/data/skills", "telegram:42");
    });

    it("does NOT call syncSchedules when deleting from notes/", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await exec("delete_file", { path: "data/notes/old.txt" });

      expect(syncSchedules).not.toHaveBeenCalled();
    });

    it("calls reloadMcp when deleting from servers/", async () => {
      const reloadMcp = vi.fn().mockResolvedValue(undefined);
      deps = makeDeps({ reloadMcp });
      const registry = createToolRegistry(deps);
      exec = registry.execute;

      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await exec("delete_file", { path: "servers/old-server.json" });

      expect(reloadMcp).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // get_state
  // =========================================================================
  describe("get_state", () => {
    it("returns JSON-stringified value when found", async () => {
      vi.mocked(getState).mockResolvedValue({ count: 5 });
      const result = await exec("get_state", {
        namespace: "ns",
        key: "counter",
      });
      expect(result).toBe(JSON.stringify({ count: 5 }));
      expect(getState).toHaveBeenCalledWith(deps.pool, "ns", "counter");
    });

    it("returns '(not set)' when null", async () => {
      vi.mocked(getState).mockResolvedValue(null);
      const result = await exec("get_state", {
        namespace: "ns",
        key: "missing",
      });
      expect(result).toBe("(not set)");
    });

    it("handles falsy but non-null values correctly", async () => {
      vi.mocked(getState).mockResolvedValue(0);
      const result = await exec("get_state", { namespace: "ns", key: "zero" });
      expect(result).toBe("0");
    });

    it("handles empty string value", async () => {
      vi.mocked(getState).mockResolvedValue("");
      const result = await exec("get_state", { namespace: "ns", key: "empty" });
      expect(result).toBe('""');
    });

    it("handles boolean false value", async () => {
      vi.mocked(getState).mockResolvedValue(false);
      const result = await exec("get_state", { namespace: "ns", key: "bool" });
      expect(result).toBe("false");
    });
  });

  // =========================================================================
  // set_state
  // =========================================================================
  describe("set_state", () => {
    it("saves state and returns confirmation", async () => {
      vi.mocked(setState).mockResolvedValue(undefined);
      const result = await exec("set_state", {
        namespace: "ns",
        key: "k",
        value: { x: 1 },
      });
      expect(result).toBe("State saved.");
      expect(setState).toHaveBeenCalledWith(deps.pool, "ns", "k", { x: 1 });
    });
  });

  // =========================================================================
  // get_status
  // =========================================================================
  describe("get_status", () => {
    it("returns formatted status summary", async () => {
      // Freeze Date.now so uptime is predictable
      const now = new Date("2025-01-01T00:05:00Z").getTime();
      vi.spyOn(Date, "now").mockReturnValue(now);

      vi.mocked(listSkills).mockResolvedValue([
        { name: "s1", description: "", filename: "s1.md" },
        { name: "s2", description: "", schedule: "* * * * *", filename: "s2.md" },
      ]);
      vi.mocked(listScripts).mockResolvedValue([{ name: "t1", path: "/data/scripts/t1.sh" }]);
      vi.mocked(deps.absurd.listSchedules).mockResolvedValue([{ scheduleName: "sched1" } as any]);
      vi.mocked(fs.readdir).mockResolvedValue(["n1.md", "n2.md", "n3.md"] as any);

      const result = await exec("get_status", {});

      expect(result).toContain("Uptime: 300s");
      expect(result).toContain("Notes: 3 files");
      expect(result).toContain("Skills: 2");
      expect(result).toContain("Scripts: 1");
      expect(result).toContain("Schedules: 1");
    });

    it("handles missing notes directory gracefully", async () => {
      const now = new Date("2025-01-01T00:00:10Z").getTime();
      vi.spyOn(Date, "now").mockReturnValue(now);

      vi.mocked(listSkills).mockResolvedValue([]);
      vi.mocked(listScripts).mockResolvedValue([]);
      vi.mocked(deps.absurd.listSchedules).mockResolvedValue([]);
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));

      const result = await exec("get_status", {});

      expect(result).toContain("Uptime: 10s");
      expect(result).toContain("Notes: 0 files");
    });
  });

  // =========================================================================
  // run_script
  // =========================================================================
  describe("run_script", () => {
    it("runs a matching tool and returns output", async () => {
      vi.mocked(listScripts).mockResolvedValue([
        { name: "weather", path: "/data/scripts/weather.sh" },
        { name: "calc", path: "/data/scripts/calc.py" },
      ]);
      vi.mocked(runScript).mockResolvedValue("sunny, 72F");

      const result = await exec("run_script", {
        name: "weather",
        input: { city: "NYC" },
      });

      expect(runScript).toHaveBeenCalledWith(
        "/data/scripts/weather.sh",
        JSON.stringify({ city: "NYC" }),
        30,
        {},
      );
      expect(result).toBe("sunny, 72F");
    });

    it("returns error when tool is not found", async () => {
      vi.mocked(listScripts).mockResolvedValue([{ name: "calc", path: "/data/scripts/calc.py" }]);

      const result = await exec("run_script", { name: "missing" });

      expect(result).toContain('Tool "missing" not found');
      expect(result).toContain("calc");
      expect(runScript).not.toHaveBeenCalled();
    });

    it("passes empty object when input is undefined", async () => {
      vi.mocked(listScripts).mockResolvedValue([{ name: "hello", path: "/data/scripts/hello.sh" }]);
      vi.mocked(runScript).mockResolvedValue("hi");

      await exec("run_script", { name: "hello" });

      expect(runScript).toHaveBeenCalledWith("/data/scripts/hello.sh", "{}", 30, {});
    });

    it("returns error when no tools exist", async () => {
      vi.mocked(listScripts).mockResolvedValue([]);

      const result = await exec("run_script", { name: "anything" });

      expect(result).toContain('Tool "anything" not found');
      expect(result).toContain("Available: ");
    });
  });

  // =========================================================================
  // sleep_for
  // =========================================================================
  describe("sleep_for", () => {
    it("calls ctx.sleepFor and returns confirmation", async () => {
      vi.mocked(deps.ctx.sleepFor).mockResolvedValue(undefined);

      const result = await exec("sleep_for", {
        step_name: "wait-step",
        seconds: 60,
      });

      expect(deps.ctx.sleepFor).toHaveBeenCalledWith("wait-step", 60);
      expect(result).toBe("Resumed after sleeping 60s.");
    });
  });

  // =========================================================================
  // sleep_until
  // =========================================================================
  describe("sleep_until", () => {
    it("calls ctx.sleepUntil with a Date and returns confirmation", async () => {
      vi.mocked(deps.ctx.sleepUntil).mockResolvedValue(undefined);

      const result = await exec("sleep_until", {
        step_name: "wake-step",
        wake_at: "2025-06-01T10:00:00Z",
      });

      expect(deps.ctx.sleepUntil).toHaveBeenCalledWith(
        "wake-step",
        new Date("2025-06-01T10:00:00Z"),
      );
      expect(result).toContain("Resumed");
      expect(result).toContain("It is now");
    });

    it("parses the wake_at string into a Date object", async () => {
      vi.mocked(deps.ctx.sleepUntil).mockResolvedValue(undefined);

      await exec("sleep_until", {
        step_name: "s",
        wake_at: "2025-12-25T00:00:00Z",
      });

      const callArg = vi.mocked(deps.ctx.sleepUntil).mock.calls[0][1];
      expect(callArg).toBeInstanceOf(Date);
      expect(callArg.toISOString()).toBe("2025-12-25T00:00:00.000Z");
    });
  });

  // =========================================================================
  // wait_for_event
  // =========================================================================
  describe("wait_for_event", () => {
    it("returns received payload on success", async () => {
      vi.mocked(deps.ctx.awaitEvent).mockResolvedValue({ msg: "hi" });

      const result = await exec("wait_for_event", {
        event_name: "user_reply",
        timeout_seconds: 300,
      });

      const parsed = JSON.parse(result);
      expect(parsed.received).toBe(true);
      expect(parsed.payload).toEqual({ msg: "hi" });
      expect(deps.ctx.awaitEvent).toHaveBeenCalledWith("user_reply", {
        timeout: 300,
      });
    });

    it("returns timed_out on TimeoutError", async () => {
      vi.mocked(deps.ctx.awaitEvent).mockRejectedValue(new TimeoutError("timed out"));

      const result = await exec("wait_for_event", {
        event_name: "user_reply",
        timeout_seconds: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.received).toBe(false);
      expect(parsed.timed_out).toBe(true);
    });

    it("propagates non-TimeoutError errors", async () => {
      vi.mocked(deps.ctx.awaitEvent).mockRejectedValue(new Error("SuspendTask"));

      await expect(
        exec("wait_for_event", {
          event_name: "ev",
          timeout_seconds: 5,
        }),
      ).rejects.toThrow("SuspendTask");
    });
  });

  // =========================================================================
  // emit_event
  // =========================================================================
  describe("emit_event", () => {
    it("emits event with payload", async () => {
      vi.mocked(deps.ctx.emitEvent).mockResolvedValue(undefined);

      const result = await exec("emit_event", {
        event_name: "task_done",
        payload: { status: "ok" },
      });

      expect(deps.ctx.emitEvent).toHaveBeenCalledWith("task_done", {
        status: "ok",
      });
      expect(result).toBe('Event "task_done" emitted.');
    });

    it("emits event with null payload when payload is omitted", async () => {
      vi.mocked(deps.ctx.emitEvent).mockResolvedValue(undefined);

      await exec("emit_event", { event_name: "ping" });

      expect(deps.ctx.emitEvent).toHaveBeenCalledWith("ping", null);
    });
  });

  // =========================================================================
  // spawn_task
  // =========================================================================
  describe("spawn_task", () => {
    it("spawns a task and returns its ID", async () => {
      vi.mocked(deps.absurd.spawn).mockResolvedValue({
        taskID: "abc-123",
        runID: "run-1",
        attempt: 1,
        created: true,
      });

      const result = await exec("spawn_task", {
        task_name: "my-task",
        params: { key: "val" },
      });

      expect(deps.absurd.spawn).toHaveBeenCalledWith("my-task", {
        key: "val",
        recipientId: "telegram:42",
      });
      expect(result).toBe("Task spawned: my-task (ID: abc-123)");
    });

    it("resolves recipientId 'current' to the executor's recipientId", async () => {
      vi.mocked(deps.absurd.spawn).mockResolvedValue({
        taskID: "def-456",
        runID: "run-2",
        attempt: 1,
        created: true,
      });

      await exec("spawn_task", {
        task_name: "workflow",
        params: { recipientId: "current", instructions: "do stuff" },
      });

      expect(deps.absurd.spawn).toHaveBeenCalledWith("workflow", {
        recipientId: "telegram:42",
        instructions: "do stuff",
      });
    });

    it("preserves an explicit recipientId", async () => {
      vi.mocked(deps.absurd.spawn).mockResolvedValue({
        taskID: "ghi-789",
        runID: "run-3",
        attempt: 1,
        created: true,
      });

      await exec("spawn_task", {
        task_name: "workflow",
        params: { recipientId: "telegram:99", instructions: "other" },
      });

      expect(deps.absurd.spawn).toHaveBeenCalledWith("workflow", {
        recipientId: "telegram:99",
        instructions: "other",
      });
    });
  });

  // =========================================================================
  // cancel_task
  // =========================================================================
  describe("cancel_task", () => {
    it("cancels a task and returns confirmation", async () => {
      vi.mocked(deps.absurd.cancelTask).mockResolvedValue(undefined);

      const result = await exec("cancel_task", { task_id: "task-xyz" });

      expect(deps.absurd.cancelTask).toHaveBeenCalledWith("task-xyz");
      expect(result).toBe("Task task-xyz cancelled.");
    });

    it("returns friendly message when task is not found", async () => {
      vi.mocked(deps.absurd.cancelTask).mockRejectedValue(
        new Error('Task "task-gone" not found in queue "assistant"'),
      );

      const result = await exec("cancel_task", { task_id: "task-gone" });

      expect(result).toBe(
        "Task task-gone not found (may have already completed or been cancelled).",
      );
    });

    it("rethrows unexpected errors", async () => {
      vi.mocked(deps.absurd.cancelTask).mockRejectedValue(new Error("db connection failed"));

      await expect(exec("cancel_task", { task_id: "task-x" })).rejects.toThrow(
        "db connection failed",
      );
    });
  });

  // =========================================================================
  // list_tasks
  // =========================================================================
  describe("list_tasks", () => {
    it("returns formatted active tasks with params summary", async () => {
      const wakeDate = new Date("2025-06-01T10:00:00Z");
      vi.mocked(deps.pool.query).mockResolvedValue({
        rows: [
          {
            task_name: "handle-message",
            task_id: "abcdefgh-1234-5678",
            params: { text: "hello", recipientId: "telegram:1" },
            run_state: "running",
            available_at: null,
          },
          {
            task_name: "handle-message",
            task_id: "12345678-abcd-efgh",
            params: { text: "Check ETH price every minute", recipientId: "telegram:1" },
            run_state: "sleeping",
            available_at: wakeDate,
          },
          {
            task_name: "workflow",
            task_id: "aabbccdd-1111-2222",
            params: { instructions: "Monitor prices", recipientId: "telegram:1" },
            run_state: "sleeping",
            available_at: null,
          },
          {
            task_name: "execute-skill",
            task_id: "eeffaabb-3333-4444",
            params: { skillName: "daily-check", recipientId: "telegram:1" },
            run_state: "running",
            available_at: null,
          },
        ],
      } as any);

      const result = await exec("list_tasks", {});

      expect(deps.pool.query).toHaveBeenCalledWith(expect.stringContaining("absurd.t_test_queue"));
      // Full task IDs shown
      expect(result).toContain("abcdefgh-1234-5678");
      expect(result).toContain("12345678-abcd-efgh");
      // Params summaries included
      expect(result).toContain('"hello"');
      expect(result).toContain('"Check ETH price every minute"');
      expect(result).toContain('"Monitor prices"');
      expect(result).toContain("skill=daily-check");
      expect(result).toContain("wakes=2025-06-01T10:00:00.000Z");
    });

    it("returns 'No active tasks.' when no rows", async () => {
      vi.mocked(deps.pool.query).mockResolvedValue({ rows: [] } as any);

      const result = await exec("list_tasks", {});

      expect(result).toBe("No active tasks.");
    });

    it("uses the correct queue name in SQL", async () => {
      vi.mocked(deps.pool.query).mockResolvedValue({ rows: [] } as any);

      await exec("list_tasks", {});

      const sql = vi.mocked(deps.pool.query).mock.calls[0][0] as string;
      expect(sql).toContain("absurd.t_test_queue");
      expect(sql).toContain("absurd.r_test_queue");
    });
  });

  // =========================================================================
  // web_search
  // =========================================================================
  describe("web_search", () => {
    let searchExec: (name: string, input: Record<string, any>) => Promise<string>;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const searchDeps = makeDeps({ searchApiKey: "brave-key-123" });
      const registry = createToolRegistry(searchDeps);
      searchExec = registry.execute;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns error when searchApiKey is not set", async () => {
      // Use the default exec (no searchApiKey in deps)
      const result = await exec("web_search", { query: "test" });
      expect(result).toContain("not configured");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns error for empty query", async () => {
      const result = await searchExec("web_search", { query: "   " });
      expect(result).toBe("Error: query is required");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("calls Brave API with correct URL, headers, and default count", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await searchExec("web_search", { query: "hello world" });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://api.search.brave.com/res/v1/web/search?q=hello%20world&count=5",
      );
      expect(opts.headers["X-Subscription-Token"]).toBe("brave-key-123");
      expect(opts.headers.Accept).toBe("application/json");
    });

    it("clamps count to max 20", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await searchExec("web_search", { query: "test", count: 100 });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("count=20");
    });

    it("returns formatted results", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
              { title: "Result 2", url: "https://example.com/2" },
            ],
          },
        }),
      });

      const result = await searchExec("web_search", { query: "test" });

      expect(result).toContain("**Result 1**");
      expect(result).toContain("https://example.com/1");
      expect(result).toContain("Desc 1");
      expect(result).toContain("**Result 2**");
      expect(result).toContain("https://example.com/2");
    });

    it("returns 'No results found.' when API returns empty results", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      const result = await searchExec("web_search", { query: "obscure query" });
      expect(result).toBe("No results found.");
    });

    it("returns 'No results found.' when web field is missing", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await searchExec("web_search", { query: "test" });
      expect(result).toBe("No results found.");
    });

    it("returns error message on non-200 response", async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 429 });

      const result = await searchExec("web_search", { query: "test" });
      expect(result).toBe("Error: search API returned 429");
    });

    it("uses AbortSignal.timeout for request", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await searchExec("web_search", { query: "test" });

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.signal).toBeDefined();
    });
  });

  // =========================================================================
  // Unknown tool
  // =========================================================================
  describe("unknown tool", () => {
    it("returns error message for unknown tool name", async () => {
      const result = await exec("nonexistent_tool", {});
      expect(result).toBe("Unknown tool: nonexistent_tool");
    });

    it("returns error message for empty tool name", async () => {
      const result = await exec("", {});
      expect(result).toBe("Unknown tool: ");
    });
  });

  // =========================================================================
  // isSuspending
  // =========================================================================
  describe("isSuspending", () => {
    it("returns true for sleep_for", () => {
      const registry = createToolRegistry(deps);
      expect(registry.isSuspending("sleep_for")).toBe(true);
    });

    it("returns true for sleep_until", () => {
      const registry = createToolRegistry(deps);
      expect(registry.isSuspending("sleep_until")).toBe(true);
    });

    it("returns true for wait_for_event", () => {
      const registry = createToolRegistry(deps);
      expect(registry.isSuspending("wait_for_event")).toBe(true);
    });

    it("returns false for non-suspending tools", () => {
      const registry = createToolRegistry(deps);
      expect(registry.isSuspending("read_file")).toBe(false);
      expect(registry.isSuspending("write_file")).toBe(false);
      expect(registry.isSuspending("spawn_task")).toBe(false);
    });

    it("returns false for unknown tools", () => {
      const registry = createToolRegistry(deps);
      expect(registry.isSuspending("nonexistent")).toBe(false);
    });
  });

  // =========================================================================
  // definitions
  // =========================================================================
  describe("definitions", () => {
    it("returns all 16 tool definitions", () => {
      const registry = createToolRegistry(deps);
      expect(registry.definitions.length).toBe(16);
    });

    it("includes expected tool names", () => {
      const registry = createToolRegistry(deps);
      const names = registry.definitions.map((d) => d.name);
      expect(names).toContain("read_file");
      expect(names).toContain("write_file");
      expect(names).toContain("list_files");
      expect(names).toContain("delete_file");
      expect(names).toContain("get_state");
      expect(names).toContain("set_state");
      expect(names).toContain("get_status");
      expect(names).toContain("run_script");
      expect(names).toContain("sleep_for");
      expect(names).toContain("sleep_until");
      expect(names).toContain("spawn_task");
      expect(names).toContain("cancel_task");
      expect(names).toContain("list_tasks");
      expect(names).toContain("wait_for_event");
      expect(names).toContain("emit_event");
      expect(names).toContain("web_search");
    });
  });

  // =========================================================================
  // extra directories
  // =========================================================================
  describe("extra directories", () => {
    let depsWithExtra: ExecutorDeps;
    let execExtra: (name: string, input: Record<string, any>) => Promise<string>;

    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockImplementation(
        async (p) => p,
      );
      depsWithExtra = makeDeps({
        extraDirs: [
          { name: "vaults", mode: "ro", absPath: "/mnt/vaults" },
          { name: "projects", mode: "rw", absPath: "/mnt/projects" },
        ],
      });
      const registry = createToolRegistry(depsWithExtra);
      execExtra = registry.execute;
    });

    it("read_file resolves paths in an extra dir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("vault content");
      const result = await execExtra("read_file", { path: "vaults/note.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/mnt/vaults", "note.md"),
        "utf-8",
      );
      expect(result).toBe("vault content");
    });

    it("read_file works in rw extra dir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("project file");
      const result = await execExtra("read_file", { path: "projects/readme.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/mnt/projects", "readme.md"),
        "utf-8",
      );
      expect(result).toBe("project file");
    });

    it("write_file rejects writes to read-only extra dir", async () => {
      const result = await execExtra("write_file", {
        path: "vaults/new.md",
        content: "test",
      });
      expect(result).toMatch(/read.only/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("write_file allows writes to rw extra dir", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      const result = await execExtra("write_file", {
        path: "projects/new.ts",
        content: "code",
      });
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.resolve("/mnt/projects", "new.ts"),
        "code",
        "utf-8",
      );
      expect(result).toContain("File written");
    });

    it("delete_file rejects deletes in read-only extra dir", async () => {
      const result = await execExtra("delete_file", { path: "vaults/old.md" });
      expect(result).toMatch(/read.only/i);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it("delete_file allows deletes in rw extra dir", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      const result = await execExtra("delete_file", { path: "projects/old.ts" });
      expect(fs.unlink).toHaveBeenCalled();
      expect(result).toContain("File deleted");
    });

    it("list_files lists an extra dir", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["a.md", "b.md"] as any);
      const result = await execExtra("list_files", { directory: "vaults" });
      expect(fs.readdir).toHaveBeenCalledWith("/mnt/vaults");
      expect(result).toBe("a.md\nb.md");
    });

    it("rejects path traversal from extra dir", async () => {
      const result = await execExtra("read_file", {
        path: "vaults/../../etc/passwd",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("rejects symlink escape from extra dir", async () => {
      vi.mocked(fs.realpath as (p: string) => Promise<string>).mockResolvedValue(
        "/etc/passwd",
      );
      const result = await execExtra("read_file", { path: "vaults/sneaky.md" });
      expect(result).toMatch(/symlink/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("write_file in rw extra dir does NOT trigger schedule sync or chmod", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      await execExtra("write_file", { path: "projects/test.sh", content: "#!/bin/bash" });
      expect(fs.chmod).not.toHaveBeenCalled();
      expect(syncSchedules).not.toHaveBeenCalled();
    });

    it("delete_file in rw extra dir does NOT trigger schedule sync or MCP reload", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      await execExtra("delete_file", { path: "projects/old.ts" });
      expect(syncSchedules).not.toHaveBeenCalled();
      // reloadMcp is undefined in default deps, so no call possible — just verify no error
    });

    it("read_file resolves nested paths in extra dir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("deep content");
      const result = await execExtra("read_file", { path: "vaults/sub/deep/file.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/mnt/vaults", "sub/deep/file.md"),
        "utf-8",
      );
      expect(result).toBe("deep content");
    });

    it("list_files error message includes extra dir names", async () => {
      const result = await execExtra("list_files", { directory: "nonexistent" });
      expect(result).toContain("vaults");
      expect(result).toContain("projects");
      expect(result).toContain("data/notes");
    });

    it("list_files returns empty message for empty extra dir", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      const result = await execExtra("list_files", { directory: "vaults" });
      expect(result).toBe("(empty directory)");
    });

    it("list_files returns not-exist message for missing extra dir", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
      const result = await execExtra("list_files", { directory: "vaults" });
      expect(result).toBe("(directory does not exist)");
    });
  });

  // =========================================================================
  // MCP integration
  // =========================================================================
  describe("MCP integration", () => {
    const mcpDef = {
      name: "mcp_github_list_repos",
      description: "List GitHub repos",
      input_schema: {
        type: "object" as const,
        properties: { org: { type: "string" } },
        required: ["org"],
      },
    };

    function makeMcp() {
      return {
        definitions: () => [mcpDef],
        execute: vi.fn().mockResolvedValue("mcp result"),
      };
    }

    it("includes MCP tool definitions alongside built-in tools", () => {
      const mcp = makeMcp();
      const registry = createToolRegistry(deps, mcp);
      const names = registry.definitions.map((d) => d.name);
      expect(names).toContain("read_file");
      expect(names).toContain("mcp_github_list_repos");
      expect(registry.definitions.length).toBe(17);
    });

    it("routes MCP tool calls to the MCP source execute", async () => {
      const mcp = makeMcp();
      const registry = createToolRegistry(deps, mcp);
      const result = await registry.execute("mcp_github_list_repos", { org: "acme" });
      expect(mcp.execute).toHaveBeenCalledWith("mcp_github_list_repos", { org: "acme" });
      expect(result).toBe("mcp result");
    });

    it("still routes built-in tools to built-in handlers", async () => {
      const mcp = makeMcp();
      const registry = createToolRegistry(deps, mcp);
      vi.mocked(fs.readFile).mockResolvedValue("hello");
      const result = await registry.execute("read_file", { path: "data/notes/foo.txt" });
      expect(result).toBe("hello");
      expect(mcp.execute).not.toHaveBeenCalled();
    });

    it("MCP tools are never suspending", () => {
      const mcp = makeMcp();
      const registry = createToolRegistry(deps, mcp);
      expect(registry.isSuspending("mcp_github_list_repos")).toBe(false);
    });

    it("returns Unknown tool when no MCP source and tool not found", async () => {
      const registry = createToolRegistry(deps);
      const result = await registry.execute("mcp_github_list_repos", {});
      expect(result).toBe("Unknown tool: mcp_github_list_repos");
    });
  });
});
