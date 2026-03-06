import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./types.ts";

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { browserTools, tokenize } from "./browser.ts";

const tool = browserTools[0];
const deps = {} as ExecutorDeps;

describe("tokenize", () => {
  it("splits simple words", () => {
    expect(tokenize("open https://example.com")).toEqual(["open", "https://example.com"]);
  });

  it("handles double-quoted strings", () => {
    expect(tokenize('fill @e3 "hello world"')).toEqual(["fill", "@e3", "hello world"]);
  });

  it("handles single-quoted strings", () => {
    expect(tokenize("fill @e3 'hello world'")).toEqual(["fill", "@e3", "hello world"]);
  });

  it("collapses multiple spaces", () => {
    expect(tokenize("click   @e1")).toEqual(["click", "@e1"]);
  });

  it("handles tabs", () => {
    expect(tokenize("get\ttext\t@e1")).toEqual(["get", "text", "@e1"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("handles quoted string at start", () => {
    expect(tokenize('"hello world"')).toEqual(["hello world"]);
  });

  it("handles single quotes inside double quotes", () => {
    expect(tokenize('fill @e3 "it\'s here"')).toEqual(["fill", "@e3", "it's here"]);
  });

  it("includes partial token on unclosed quote", () => {
    expect(tokenize('fill @e3 "unclosed')).toEqual(["fill", "@e3", "unclosed"]);
  });
});

describe("browser tool", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("has correct tool name", () => {
    expect(tool.def.name).toBe("browser");
  });

  it("is not a suspending tool", () => {
    expect(tool.suspends).toBeUndefined();
  });

  it("returns error for empty command", async () => {
    const result = await tool.execute({ command: "" }, deps);
    expect(result).toBe("Error: command is required");
  });

  it("returns error for whitespace-only command", async () => {
    const result = await tool.execute({ command: "   " }, deps);
    expect(result).toBe("Error: command is required");
  });

  it("calls execFile with tokenized args", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "page loaded", "");
    });
    const result = await tool.execute({ command: "open https://example.com" }, deps);
    expect(mockExecFile).toHaveBeenCalledWith(
      "agent-browser",
      ["open", "https://example.com"],
      expect.objectContaining({ timeout: 30_000, maxBuffer: 1024 * 1024 }),
      expect.any(Function),
    );
    expect(result).toBe("page loaded");
  });

  it("returns stderr when stdout is empty", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "", "some warning");
    });
    const result = await tool.execute({ command: "snapshot" }, deps);
    expect(result).toBe("some warning");
  });

  it("returns fallback when both stdout and stderr are empty", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "", "");
    });
    const result = await tool.execute({ command: "close" }, deps);
    expect(result).toBe("(no output)");
  });

  it("returns install hint on ENOENT", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err = Object.assign(new Error("not found"), { code: "ENOENT" });
      cb(err, "", "");
    });
    const result = await tool.execute({ command: "open https://example.com" }, deps);
    expect(result).toContain("not installed");
    expect(result).toContain("npm install -g agent-browser");
  });

  it("returns timeout error when killed", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err = Object.assign(new Error("timed out"), { killed: true });
      cb(err, "", "");
    });
    const result = await tool.execute({ command: "open https://slow.site" }, deps);
    expect(result).toContain("timed out");
    expect(result).toContain("30s");
  });

  it("returns stderr on generic error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err = Object.assign(new Error("exit code 1"), { stderr: "element not found" });
      cb(err, "", "element not found");
    });
    const result = await tool.execute({ command: "click @e99" }, deps);
    expect(result).toContain("element not found");
  });
});
