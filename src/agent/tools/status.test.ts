import { describe, expect, it, vi } from "vitest";
import { statusTools } from "./status.ts";
import type { ExecutorDeps } from "./types.ts";

vi.mock("../../skills/manager.ts", () => ({
  listSkills: vi
    .fn()
    .mockResolvedValue([{ name: "greet", description: "Greet user", filename: "greet.md" }]),
}));

vi.mock("../../scripts/runner.ts", () => ({
  listScripts: vi.fn().mockResolvedValue([
    { name: "backup", path: "/scripts/backup.sh" },
    { name: "deploy", path: "/scripts/deploy.sh" },
  ]),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn().mockImplementation((dir: string) => {
    if (dir.endsWith("pinned")) return Promise.resolve(["profile.md", "prefs.md", ".gitkeep"]);
    return Promise.resolve(["todo.md", "ideas.md", "archive.txt"]);
  }),
}));

const tool = statusTools[0];

function makeDeps(): ExecutorDeps {
  return {
    startedAt: new Date(Date.now() - 120_000),
    dirs: {
      notes: "/data/notes",
      skills: "/skills",
      scripts: "/scripts",
      servers: "/servers",
      extra: [],
    },
    absurd: {
      listSchedules: vi
        .fn()
        .mockResolvedValue([{ scheduleName: "skill:greet", scheduleExpr: "0 9 * * *" }]),
    },
  } as unknown as ExecutorDeps;
}

describe("get_status", () => {
  it("returns formatted status with correct counts", async () => {
    const result = await tool.execute({}, makeDeps());
    const lines = result.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^Uptime: \d+s$/);
    expect(lines[1]).toBe("Pinned notes: 2 files");
    expect(lines[2]).toBe("Available notes: 2 files");
    expect(lines[3]).toBe("Skills: 1");
    expect(lines[4]).toBe("Scripts: 2");
    expect(lines[5]).toBe("Schedules: 1");
  });
});
