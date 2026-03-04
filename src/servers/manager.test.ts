import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock node:fs/promises                                              */
/* ------------------------------------------------------------------ */

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

/* ------------------------------------------------------------------ */
/*  Import under test (after mocks)                                    */
/* ------------------------------------------------------------------ */

import { listServerConfigs } from "./manager.ts";

/* ================================================================== */
/*  listServerConfigs                                                  */
/* ================================================================== */

describe("listServerConfigs", () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    mockReadFile.mockReset();
  });

  it("reads .json files and returns ServerConfig objects", async () => {
    mockReaddir.mockResolvedValue(["weather.json", "calendar.json"]);
    mockReadFile
      .mockResolvedValueOnce(
        JSON.stringify({ command: "node", args: ["weather.js"], description: "Weather" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ command: "python", args: ["cal.py"] }),
      );

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({
      name: "weather",
      command: "node",
      args: ["weather.js"],
      description: "Weather",
    });
    expect(configs[1]).toEqual({
      name: "calendar",
      command: "python",
      args: ["cal.py"],
    });
  });

  it("skips non-.json files", async () => {
    mockReaddir.mockResolvedValue(["readme.md", "notes.txt", "good.json"]);
    mockReadFile.mockResolvedValue(JSON.stringify({ command: "echo" }));

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("good");
    // readFile should only be called once (for good.json)
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("returns [] when directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const configs = await listServerConfigs("/nonexistent");

    expect(configs).toEqual([]);
  });

  it("skips files with invalid JSON", async () => {
    mockReaddir.mockResolvedValue(["bad.json", "good.json"]);
    mockReadFile
      .mockResolvedValueOnce("not json {{{")
      .mockResolvedValueOnce(JSON.stringify({ command: "echo" }));

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("good");
  });

  it("skips files missing the command field", async () => {
    mockReaddir.mockResolvedValue(["nocommand.json", "hascommand.json"]);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ description: "no command here" }))
      .mockResolvedValueOnce(JSON.stringify({ command: "ls" }));

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("hascommand");
  });
});
