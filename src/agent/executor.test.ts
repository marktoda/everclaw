import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import * as path from "path";

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
}));

vi.mock("../memory/state.js", () => ({
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("../skills/manager.js", () => ({
  listSkills: vi.fn(),
  syncSchedules: vi.fn(),
}));

vi.mock("../scripts/runner.js", () => ({
  runScript: vi.fn(),
  listTools: vi.fn(),
}));

// Import mocked modules so we can configure per-test return values.
import * as fs from "fs/promises";
import { getState, setState } from "../memory/state.js";
import { listSkills, syncSchedules } from "../skills/manager.js";
import { runScript, listTools } from "../scripts/runner.js";
import { TimeoutError } from "absurd-sdk";

import { createExecutor } from "./executor.js";

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
    chatId: 42,
    notesDir: "/data/notes",
    skillsDir: "/data/skills",
    toolsDir: "/data/tools",
    scriptTimeout: 30,
    startedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executor", () => {
  let deps: ExecutorDeps;
  let exec: (name: string, input: Record<string, any>) => Promise<string>;

  beforeEach(() => {
    vi.resetAllMocks();
    deps = makeDeps();
    exec = createExecutor(deps);
  });

  // =========================================================================
  // isContainedIn (tested indirectly via resolvePath + tool calls)
  // =========================================================================
  describe("isContainedIn / resolvePath path-safety", () => {
    it("accepts a file directly inside the notes directory", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("hello");
      const result = await exec("read_file", { path: "data/notes/foo.txt" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/notes", "foo.txt"),
        "utf-8",
      );
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

    it("rejects traversal from tools/ directory", async () => {
      const result = await exec("read_file", {
        path: "tools/../../secret",
      });
      expect(result).toMatch(/Error/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("handles leading ./ prefix by stripping it", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("ok");
      await exec("read_file", { path: "./data/notes/readme.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/notes", "readme.md"),
        "utf-8",
      );
    });

    it("handles leading / prefix by stripping it", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("ok");
      await exec("read_file", { path: "/data/notes/readme.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/notes", "readme.md"),
        "utf-8",
      );
    });
  });

  // =========================================================================
  // resolvePath — directory mappings
  // =========================================================================
  describe("resolvePath directory mappings", () => {
    it("maps data/notes/ to notesDir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("content");
      await exec("read_file", { path: "data/notes/test.txt" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/notes", "test.txt"),
        "utf-8",
      );
    });

    it("maps skills/ to skillsDir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("skill content");
      await exec("read_file", { path: "skills/my-skill.md" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/skills", "my-skill.md"),
        "utf-8",
      );
    });

    it("maps tools/ to toolsDir", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("tool content");
      await exec("read_file", { path: "tools/my-tool.sh" });
      expect(fs.readFile).toHaveBeenCalledWith(
        path.resolve("/data/tools", "my-tool.sh"),
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
      await expect(
        exec("read_file", { path: "data/notes/noperm.txt" }),
      ).rejects.toThrow("EACCES");
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

    it("chmods to 0o755 when writing to tools/", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "tools/my-tool.sh",
        content: "#!/bin/bash\necho hi",
      });

      expect(fs.chmod).toHaveBeenCalledWith(
        path.resolve("/data/tools", "my-tool.sh"),
        0o755,
      );
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

      expect(syncSchedules).toHaveBeenCalledWith(
        deps.absurd,
        "/data/skills",
        42,
      );
    });

    it("does NOT call syncSchedules when writing to tools/", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);

      await exec("write_file", {
        path: "tools/script.sh",
        content: "#!/bin/bash",
      });

      expect(syncSchedules).not.toHaveBeenCalled();
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

    it("lists files from tools directory", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["tool.sh"] as any);
      const result = await exec("list_files", { directory: "tools" });
      expect(result).toBe("tool.sh");
      expect(fs.readdir).toHaveBeenCalledWith("/data/tools");
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
      expect(fs.unlink).toHaveBeenCalledWith(
        path.resolve("/data/notes", "old.txt"),
      );
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
      await expect(
        exec("delete_file", { path: "data/notes/locked.txt" }),
      ).rejects.toThrow("EPERM");
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

      expect(syncSchedules).toHaveBeenCalledWith(
        deps.absurd,
        "/data/skills",
        42,
      );
    });

    it("does NOT call syncSchedules when deleting from notes/", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await exec("delete_file", { path: "data/notes/old.txt" });

      expect(syncSchedules).not.toHaveBeenCalled();
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
      vi.mocked(listTools).mockResolvedValue([
        { name: "t1", path: "/data/tools/t1.sh" },
      ]);
      vi.mocked(deps.absurd.listSchedules).mockResolvedValue([
        { scheduleName: "sched1" } as any,
      ]);
      vi.mocked(fs.readdir).mockResolvedValue(["n1.md", "n2.md", "n3.md"] as any);

      const result = await exec("get_status", {});

      expect(result).toContain("Uptime: 300s");
      expect(result).toContain("Notes: 3 files");
      expect(result).toContain("Skills: 2");
      expect(result).toContain("Tools: 1");
      expect(result).toContain("Schedules: 1");
    });

    it("handles missing notes directory gracefully", async () => {
      const now = new Date("2025-01-01T00:00:10Z").getTime();
      vi.spyOn(Date, "now").mockReturnValue(now);

      vi.mocked(listSkills).mockResolvedValue([]);
      vi.mocked(listTools).mockResolvedValue([]);
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
      vi.mocked(listTools).mockResolvedValue([
        { name: "weather", path: "/data/tools/weather.sh" },
        { name: "calc", path: "/data/tools/calc.py" },
      ]);
      vi.mocked(runScript).mockResolvedValue("sunny, 72F");

      const result = await exec("run_script", {
        name: "weather",
        input: { city: "NYC" },
      });

      expect(runScript).toHaveBeenCalledWith(
        "/data/tools/weather.sh",
        JSON.stringify({ city: "NYC" }),
        30,
      );
      expect(result).toBe("sunny, 72F");
    });

    it("returns error when tool is not found", async () => {
      vi.mocked(listTools).mockResolvedValue([
        { name: "calc", path: "/data/tools/calc.py" },
      ]);

      const result = await exec("run_script", { name: "missing" });

      expect(result).toContain('Tool "missing" not found');
      expect(result).toContain("calc");
      expect(runScript).not.toHaveBeenCalled();
    });

    it("passes empty object when input is undefined", async () => {
      vi.mocked(listTools).mockResolvedValue([
        { name: "hello", path: "/data/tools/hello.sh" },
      ]);
      vi.mocked(runScript).mockResolvedValue("hi");

      await exec("run_script", { name: "hello" });

      expect(runScript).toHaveBeenCalledWith(
        "/data/tools/hello.sh",
        "{}",
        30,
      );
    });

    it("returns error when no tools exist", async () => {
      vi.mocked(listTools).mockResolvedValue([]);

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
      vi.mocked(deps.ctx.awaitEvent).mockRejectedValue(
        new TimeoutError("timed out"),
      );

      const result = await exec("wait_for_event", {
        event_name: "user_reply",
        timeout_seconds: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.received).toBe(false);
      expect(parsed.timed_out).toBe(true);
    });

    it("propagates non-TimeoutError errors", async () => {
      vi.mocked(deps.ctx.awaitEvent).mockRejectedValue(
        new Error("SuspendTask"),
      );

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
      });
      expect(result).toBe("Task spawned: my-task (ID: abc-123)");
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
  });

  // =========================================================================
  // list_tasks
  // =========================================================================
  describe("list_tasks", () => {
    it("returns formatted active tasks", async () => {
      const wakeDate = new Date("2025-06-01T10:00:00Z");
      vi.mocked(deps.pool.query).mockResolvedValue({
        rows: [
          {
            task_name: "agent-loop",
            task_id: "abcdefgh-1234-5678",
            run_state: "running",
            available_at: null,
          },
          {
            task_name: "check-email",
            task_id: "12345678-abcd-efgh",
            run_state: "sleeping",
            available_at: wakeDate,
          },
        ],
      } as any);

      const result = await exec("list_tasks", {});

      expect(deps.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("absurd.t_test_queue"),
      );
      expect(result).toContain("agent-loop");
      expect(result).toContain("abcdefgh...");
      expect(result).toContain("state=running");
      expect(result).toContain("check-email");
      expect(result).toContain("state=sleeping");
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
});
