import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isContainedIn, validateRealPath } from "./path-utils.ts";

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(),
}));

import * as fs from "node:fs/promises";

const mockRealpath = vi.mocked(fs.realpath);

describe("isContainedIn", () => {
  it("returns true for the same path", () => {
    expect(isContainedIn("/foo/bar", "/foo/bar")).toBe(true);
  });

  it("returns true for a child path", () => {
    expect(isContainedIn("/foo/bar/baz", "/foo/bar")).toBe(true);
  });

  it("returns false for a sibling path", () => {
    expect(isContainedIn("/foo/baz", "/foo/bar")).toBe(false);
  });

  it("returns false for .. traversal", () => {
    // After resolve, /foo/bar/../secret becomes /foo/secret which is not under /foo/bar
    const resolved = path.resolve("/foo/bar", "../secret");
    expect(isContainedIn(resolved, "/foo/bar")).toBe(false);
  });

  it("returns false when parent is a prefix but not a directory boundary", () => {
    // /foo/bar-extra should NOT be contained in /foo/bar
    expect(isContainedIn("/foo/bar-extra", "/foo/bar")).toBe(false);
  });
});

describe("validateRealPath", () => {
  it("returns error when symlink escapes allowed directory", async () => {
    mockRealpath.mockResolvedValueOnce("/outside/evil" as any);
    const result = await validateRealPath("/allowed/link", "/allowed");
    expect(result).toBe("Error: path escapes allowed directory via symlink");
  });

  it("returns null when real path is inside allowed directory", async () => {
    mockRealpath.mockResolvedValueOnce("/allowed/real/file" as any);
    const result = await validateRealPath("/allowed/link", "/allowed");
    expect(result).toBeNull();
  });

  it("checks parent when file does not exist (ENOENT) and parent is safe", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockRealpath.mockRejectedValueOnce(enoent);
    mockRealpath.mockResolvedValueOnce("/allowed/parent" as any);
    const result = await validateRealPath("/allowed/parent/newfile", "/allowed");
    expect(result).toBeNull();
  });

  it("returns error when file does not exist but parent escapes", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockRealpath.mockRejectedValueOnce(enoent);
    mockRealpath.mockResolvedValueOnce("/outside/evil" as any);
    const result = await validateRealPath("/allowed/parent/newfile", "/allowed");
    expect(result).toBe("Error: path escapes allowed directory via symlink");
  });

  it("returns null when both file and parent do not exist (ENOENT)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockRealpath.mockRejectedValueOnce(enoent);
    mockRealpath.mockRejectedValueOnce(new Error("parent gone"));
    const result = await validateRealPath("/allowed/a/b/newfile", "/allowed");
    expect(result).toBeNull();
  });

  it("propagates non-ENOENT errors", async () => {
    const permError = Object.assign(new Error("EACCES"), { code: "EACCES" });
    mockRealpath.mockRejectedValueOnce(permError);
    await expect(validateRealPath("/allowed/file", "/allowed")).rejects.toThrow("EACCES");
  });
});
