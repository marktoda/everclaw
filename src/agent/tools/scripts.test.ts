import { describe, expect, it, vi } from "vitest";
import { scriptTools } from "./scripts.ts";
import type { ExecutorDeps } from "./types.ts";

vi.mock("../../scripts/runner.ts", () => ({
  listScripts: vi.fn(),
  runScript: vi.fn(),
}));

import { listScripts, runScript } from "../../scripts/runner.ts";

const tool = scriptTools[0];

function makeDeps(): ExecutorDeps {
  return {
    dirs: {
      scripts: "/scripts",
      notes: "/notes",
      skills: "/skills",
      servers: "/servers",
      extra: [],
    },
    scriptTimeout: 30,
    scriptEnv: { MY_KEY: "val" },
  } as unknown as ExecutorDeps;
}

describe("run_script", () => {
  it("returns not found message when script does not exist", async () => {
    vi.mocked(listScripts).mockResolvedValue([{ name: "backup", path: "/scripts/backup.sh" }]);
    const result = await tool.execute({ name: "missing" }, makeDeps());
    expect(result).toBe('Tool "missing" not found. Available: backup');
  });

  it("returns script output on success", async () => {
    vi.mocked(listScripts).mockResolvedValue([{ name: "backup", path: "/scripts/backup.sh" }]);
    vi.mocked(runScript).mockResolvedValue("backup completed");
    const result = await tool.execute({ name: "backup", input: { target: "db" } }, makeDeps());
    expect(result).toBe("backup completed");
    expect(runScript).toHaveBeenCalledWith(
      "/scripts/backup.sh",
      JSON.stringify({ target: "db" }),
      30,
      { MY_KEY: "val" },
    );
  });

  it("returns script error message on failure", async () => {
    vi.mocked(listScripts).mockResolvedValue([{ name: "deploy", path: "/scripts/deploy.sh" }]);
    vi.mocked(runScript).mockRejectedValue(new Error("permission denied"));
    const result = await tool.execute({ name: "deploy" }, makeDeps());
    expect(result).toBe("Script error: permission denied");
  });
});
