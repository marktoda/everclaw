import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();
const mockChmod = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  chmod: (...args: any[]) => mockChmod(...args),
}));

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

const mockValidateRealPath = vi.fn();
vi.mock("../../path-utils.ts", () => ({
  isContainedIn: (child: string, parent: string) =>
    child === parent || child.startsWith(`${parent}/`),
  validateRealPath: (...args: any[]) => mockValidateRealPath(...args),
}));

const mockSyncSchedules = vi.fn();
vi.mock("../../skills/manager.ts", () => ({
  syncSchedules: (...args: any[]) => mockSyncSchedules(...args),
}));

const mockValidateServerConfig = vi.fn();
vi.mock("../../servers/manager.ts", () => ({
  validateServerConfig: (...args: any[]) => mockValidateServerConfig(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import { fileTools } from "./files.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tool(name: string) {
  const t = fileTools.find((t) => t.def.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    dirs: {
      notes: "/app/data/notes",
      skills: "/app/skills",
      scripts: "/app/scripts",
      servers: "/app/servers",
      extra: [],
    },
    absurd: {} as any,
    pool: {} as any,
    ctx: {} as any,
    chatId: "telegram:123",
    startedAt: new Date(),
    queueName: "default",
    scriptTimeout: 30_000,
    scriptEnv: {},
    allowedChatIds: new Set(),
    ...overrides,
  } as ExecutorDeps;
}

function makeDepsWithExtra(
  extra: ExecutorDeps["dirs"]["extra"],
  overrides: Partial<ExecutorDeps> = {},
): ExecutorDeps {
  return makeDeps({
    dirs: {
      notes: "/app/data/notes",
      skills: "/app/skills",
      scripts: "/app/scripts",
      servers: "/app/servers",
      extra,
    },
    ...overrides,
  });
}

function mockRgSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, stdout, "");
  });
}

function mockRgNoMatches() {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(Object.assign(new Error("no matches"), { status: 1 }), "", "");
  });
}

function mockRgError(message: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(Object.assign(new Error("rg failed"), { status: 2 }), "", message);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockValidateRealPath.mockResolvedValue(null);
});

// ===========================================================================
// read_file
// ===========================================================================

describe("read_file", () => {
  const exec = (input: Record<string, unknown>, deps?: ExecutorDeps) =>
    tool("read_file").execute(input, deps ?? makeDeps());

  it("reads a file from data/notes/", async () => {
    mockReadFile.mockResolvedValue("hello world");
    const result = await exec({ path: "data/notes/profile.md" });
    expect(mockReadFile).toHaveBeenCalledWith("/app/data/notes/profile.md", "utf-8");
    expect(result).toBe("hello world");
  });

  it("reads a file from skills/", async () => {
    mockReadFile.mockResolvedValue("skill content");
    const result = await exec({ path: "skills/morning.md" });
    expect(mockReadFile).toHaveBeenCalledWith("/app/skills/morning.md", "utf-8");
    expect(result).toBe("skill content");
  });

  it("reads a file from scripts/", async () => {
    mockReadFile.mockResolvedValue("#!/bin/bash");
    const result = await exec({ path: "scripts/deploy.sh" });
    expect(mockReadFile).toHaveBeenCalledWith("/app/scripts/deploy.sh", "utf-8");
    expect(result).toBe("#!/bin/bash");
  });

  it("reads a file from servers/", async () => {
    mockReadFile.mockResolvedValue('{"command":"npx"}');
    const result = await exec({ path: "servers/github.json" });
    expect(mockReadFile).toHaveBeenCalledWith("/app/servers/github.json", "utf-8");
    expect(result).toBe('{"command":"npx"}');
  });

  it("returns error for paths outside allowed directories", async () => {
    const result = await exec({ path: "etc/passwd" });
    expect(result).toContain("Error: path must start with");
  });

  it("rejects path traversal via ../", async () => {
    // path.resolve will resolve data/notes/../../etc/passwd to /app/etc/passwd
    // which is not contained in /app/data/notes
    const result = await exec({ path: "data/notes/../../etc/passwd" });
    expect(result).toContain("Error:");
  });

  it("returns (file not found) for ENOENT", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const result = await exec({ path: "data/notes/missing.md" });
    expect(result).toBe("(file not found)");
  });

  it("propagates non-ENOENT errors", async () => {
    mockReadFile.mockRejectedValue(new Error("permission denied"));
    await expect(exec({ path: "data/notes/file.md" })).rejects.toThrow("permission denied");
  });

  it("returns error when symlink escapes base directory", async () => {
    mockValidateRealPath.mockResolvedValue("Error: path escapes allowed directory via symlink");
    const result = await exec({ path: "data/notes/evil-link.md" });
    expect(result).toBe("Error: path escapes allowed directory via symlink");
  });

  it("reads from extra dirs", async () => {
    mockReadFile.mockResolvedValue("vault content");
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
    const result = await exec({ path: "vaults/note.md" }, deps);
    expect(mockReadFile).toHaveBeenCalledWith("/mnt/vaults/note.md", "utf-8");
    expect(result).toBe("vault content");
  });

  it("strips leading ./ from path", async () => {
    mockReadFile.mockResolvedValue("content");
    await exec({ path: "./data/notes/file.md" });
    expect(mockReadFile).toHaveBeenCalledWith("/app/data/notes/file.md", "utf-8");
  });

  it("strips leading / from path", async () => {
    mockReadFile.mockResolvedValue("content");
    await exec({ path: "/data/notes/file.md" });
    expect(mockReadFile).toHaveBeenCalledWith("/app/data/notes/file.md", "utf-8");
  });
});

// ===========================================================================
// write_file
// ===========================================================================

describe("write_file", () => {
  const exec = (input: Record<string, unknown>, deps?: ExecutorDeps) =>
    tool("write_file").execute(input, deps ?? makeDeps());

  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockSyncSchedules.mockResolvedValue(undefined);
  });

  it("writes a file to data/notes/", async () => {
    const result = await exec({ path: "data/notes/todo.md", content: "buy milk" });
    expect(mockMkdir).toHaveBeenCalledWith("/app/data/notes", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith("/app/data/notes/todo.md", "buy milk", "utf-8");
    expect(result).toBe("File written: data/notes/todo.md");
  });

  it("creates parent directories recursively", async () => {
    await exec({ path: "data/notes/pinned/profile.md", content: "name: test" });
    expect(mockMkdir).toHaveBeenCalledWith("/app/data/notes/pinned", { recursive: true });
  });

  it("returns error for paths outside allowed directories", async () => {
    const result = await exec({ path: "etc/shadow", content: "bad" });
    expect(result).toContain("Error: path must start with");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects read-only extra dirs", async () => {
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
    const result = await exec({ path: "vaults/note.md", content: "test" }, deps);
    expect(result).toBe("Error: vaults/ is read-only");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("allows writes to read-write extra dirs", async () => {
    const deps = makeDepsWithExtra([{ name: "docs", mode: "rw", absPath: "/mnt/docs" }]);
    const result = await exec({ path: "docs/readme.md", content: "hello" }, deps);
    expect(mockWriteFile).toHaveBeenCalledWith("/mnt/docs/readme.md", "hello", "utf-8");
    expect(result).toBe("File written: docs/readme.md");
  });

  it("returns error when symlink escapes base directory", async () => {
    mockValidateRealPath.mockResolvedValue("Error: path escapes allowed directory via symlink");
    const result = await exec({ path: "data/notes/evil.md", content: "hack" });
    expect(result).toBe("Error: path escapes allowed directory via symlink");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // --- DIR_HOOKS: skills/ ---

  it("triggers schedule sync after writing to skills/", async () => {
    const deps = makeDeps();
    await exec({ path: "skills/morning.md", content: "---\nschedule: 0 8 * * *\n---" }, deps);
    expect(mockSyncSchedules).toHaveBeenCalledWith(deps.absurd, "/app/skills");
  });

  it("does NOT trigger schedule sync for data/notes/", async () => {
    await exec({ path: "data/notes/todo.md", content: "test" });
    expect(mockSyncSchedules).not.toHaveBeenCalled();
  });

  // --- DIR_HOOKS: scripts/ ---

  it("triggers chmod +x after writing to scripts/", async () => {
    await exec({ path: "scripts/deploy.sh", content: "#!/bin/bash" });
    expect(mockChmod).toHaveBeenCalledWith("/app/scripts/deploy.sh", 0o755);
  });

  it("does NOT trigger chmod for data/notes/", async () => {
    await exec({ path: "data/notes/todo.md", content: "test" });
    expect(mockChmod).not.toHaveBeenCalled();
  });

  // --- DIR_HOOKS: servers/ ---

  it("validates server config before writing", async () => {
    mockValidateServerConfig.mockReturnValue({ ok: false, error: "not valid JSON" });
    const result = await exec({ path: "servers/bad.json", content: "not json" });
    expect(result).toBe("Error: invalid server config: not valid JSON");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects non-.json files in servers/", async () => {
    const result = await exec({ path: "servers/readme.md", content: "test" });
    expect(result).toBe("Error: server configs must be .json files");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects nested files in servers/", async () => {
    mockValidateServerConfig.mockReturnValue({ ok: true, parsed: { command: "npx" } });
    const result = await exec({
      path: "servers/sub/nested.json",
      content: '{"command":"npx"}',
    });
    expect(result).toBe("Error: server configs must be top-level files in servers/");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("writes valid server config and triggers MCP reload", async () => {
    mockValidateServerConfig.mockReturnValue({ ok: true, parsed: { command: "npx" } });
    const reloadMcp = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ reloadMcp });
    const result = await exec({ path: "servers/github.json", content: '{"command":"npx"}' }, deps);
    expect(mockWriteFile).toHaveBeenCalled();
    expect(reloadMcp).toHaveBeenCalled();
    expect(result).toBe("File written: servers/github.json");
  });

  it("skips MCP reload when reloadMcp is not provided", async () => {
    mockValidateServerConfig.mockReturnValue({ ok: true, parsed: { command: "npx" } });
    const deps = makeDeps({ reloadMcp: undefined });
    const result = await exec({ path: "servers/github.json", content: '{"command":"npx"}' }, deps);
    expect(result).toBe("File written: servers/github.json");
  });
});

// ===========================================================================
// delete_file
// ===========================================================================

describe("delete_file", () => {
  const exec = (input: Record<string, unknown>, deps?: ExecutorDeps) =>
    tool("delete_file").execute(input, deps ?? makeDeps());

  beforeEach(() => {
    mockUnlink.mockResolvedValue(undefined);
    mockSyncSchedules.mockResolvedValue(undefined);
  });

  it("deletes a file", async () => {
    const result = await exec({ path: "data/notes/old.md" });
    expect(mockUnlink).toHaveBeenCalledWith("/app/data/notes/old.md");
    expect(result).toBe("File deleted: data/notes/old.md");
  });

  it("returns (file not found) for ENOENT", async () => {
    mockUnlink.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const result = await exec({ path: "data/notes/missing.md" });
    expect(result).toBe("(file not found)");
  });

  it("propagates non-ENOENT errors", async () => {
    mockUnlink.mockRejectedValue(new Error("permission denied"));
    await expect(exec({ path: "data/notes/file.md" })).rejects.toThrow("permission denied");
  });

  it("returns error for paths outside allowed directories", async () => {
    const result = await exec({ path: "etc/passwd" });
    expect(result).toContain("Error: path must start with");
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("rejects read-only extra dirs", async () => {
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
    const result = await exec({ path: "vaults/note.md" }, deps);
    expect(result).toBe("Error: vaults/ is read-only");
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("triggers schedule sync after deleting from skills/", async () => {
    const deps = makeDeps();
    await exec({ path: "skills/old.md" }, deps);
    expect(mockSyncSchedules).toHaveBeenCalledWith(deps.absurd, "/app/skills");
  });

  it("triggers MCP reload after deleting from servers/", async () => {
    const reloadMcp = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ reloadMcp });
    await exec({ path: "servers/old.json" }, deps);
    expect(reloadMcp).toHaveBeenCalled();
  });

  it("returns error when symlink escapes base directory", async () => {
    mockValidateRealPath.mockResolvedValue("Error: path escapes allowed directory via symlink");
    const result = await exec({ path: "data/notes/evil.md" });
    expect(result).toBe("Error: path escapes allowed directory via symlink");
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// glob_files
// ===========================================================================

describe("glob_files", () => {
  const exec = (input: Record<string, unknown>, deps?: ExecutorDeps) =>
    tool("glob_files").execute(input, deps ?? makeDeps());

  it("runs ripgrep with --files and returns relative paths", async () => {
    mockRgSuccess("/app/data/notes/todo.md\n/app/skills/morning.md\n");
    const result = await exec({ pattern: "*.md" });
    expect(result).toBe("data/notes/todo.md\nskills/morning.md");
  });

  it("returns (no matches found) when rg finds nothing", async () => {
    mockRgNoMatches();
    const result = await exec({ pattern: "*.xyz" });
    expect(result).toBe("(no matches found)");
  });

  it("returns error from rg on non-match failure", async () => {
    mockRgError("regex parse error");
    const result = await exec({ pattern: "[invalid" });
    expect(result).toContain("Error running rg");
  });

  it("restricts search to a specific directory", async () => {
    mockRgSuccess("/app/skills/morning.md\n");
    await exec({ pattern: "*.md", directory: "skills" });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("/app/skills");
    // Should not include other dirs
    expect(args).not.toContain("/app/data/notes");
  });

  it("returns error for invalid directory name", async () => {
    const result = await exec({ pattern: "*.md", directory: "invalid" });
    expect(result).toContain("Error: directory must be");
  });

  it("respects limit parameter", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `/app/data/notes/file${i}.md`);
    mockRgSuccess(`${lines.join("\n")}\n`);
    const result = await exec({ pattern: "*.md", limit: 3 });
    const outputLines = result.split("\n").filter((l) => l.length > 0 && !l.startsWith("("));
    expect(outputLines).toHaveLength(3);
    expect(result).toContain("truncated");
  });

  it("searches extra dirs when present", async () => {
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
    mockRgSuccess("/mnt/vaults/note.md\n");
    const result = await exec({ pattern: "*.md" }, deps);
    expect(result).toBe("vaults/note.md");
  });

  it("restricts to extra dir by name", async () => {
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
    mockRgSuccess("/mnt/vaults/note.md\n");
    await exec({ pattern: "*.md", directory: "vaults" }, deps);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("/mnt/vaults");
    expect(args).not.toContain("/app/data/notes");
  });

  it("filters out paths not in any allowed dir", async () => {
    // rg might return paths outside known dirs (shouldn't happen but defensive)
    mockRgSuccess("/app/data/notes/ok.md\n/unknown/path.md\n");
    const result = await exec({ pattern: "*.md" });
    expect(result).toBe("data/notes/ok.md");
  });
});

// ===========================================================================
// grep_files
// ===========================================================================

describe("grep_files", () => {
  const exec = (input: Record<string, unknown>, deps?: ExecutorDeps) =>
    tool("grep_files").execute(input, deps ?? makeDeps());

  it("runs ripgrep and returns content with relative paths", async () => {
    mockRgSuccess("/app/data/notes/todo.md:1:buy milk\n/app/skills/check.md:3:run test\n");
    const result = await exec({ pattern: "\\w+" });
    expect(result).toBe("data/notes/todo.md:1:buy milk\nskills/check.md:3:run test");
  });

  it("returns (no matches found) when nothing matches", async () => {
    mockRgNoMatches();
    const result = await exec({ pattern: "nonexistent" });
    expect(result).toBe("(no matches found)");
  });

  it("returns error from rg on failure", async () => {
    mockRgError("regex parse error");
    const result = await exec({ pattern: "[bad" });
    expect(result).toContain("Error running rg");
  });

  it("passes -i flag for case-insensitive search", async () => {
    mockRgSuccess("");
    await exec({ pattern: "test", ignore_case: true });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-i");
  });

  it("passes -C flag for context lines", async () => {
    mockRgSuccess("");
    await exec({ pattern: "test", context_lines: 2 });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-C");
    expect(args).toContain("2");
  });

  it("passes --glob for file pattern filtering", async () => {
    mockRgSuccess("");
    await exec({ pattern: "test", glob: "*.md" });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--glob");
    expect(args).toContain("*.md");
  });

  it("uses -l flag for files_with_matches output mode", async () => {
    mockRgSuccess("/app/data/notes/todo.md\n");
    const result = await exec({ pattern: "test", output_mode: "files_with_matches" });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-l");
    expect(result).toBe("data/notes/todo.md");
  });

  it("uses -c flag for count output mode", async () => {
    mockRgSuccess("/app/data/notes/todo.md:3\n");
    const result = await exec({ pattern: "test", output_mode: "count" });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-c");
    expect(result).toBe("data/notes/todo.md:3");
  });

  it("restricts search to a specific directory", async () => {
    mockRgSuccess("");
    await exec({ pattern: "test", directory: "skills" });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("/app/skills");
    expect(args).not.toContain("/app/data/notes");
  });

  it("returns error for invalid directory name", async () => {
    const result = await exec({ pattern: "test", directory: "invalid" });
    expect(result).toContain("Error: directory must be");
  });

  it("respects limit parameter", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `/app/data/notes/f${i}.md:1:match`);
    mockRgSuccess(`${lines.join("\n")}\n`);
    const result = await exec({ pattern: "match", limit: 3 });
    // Should have 3 content lines + truncation message
    expect(result).toContain("truncated");
    const contentLines = result.split("\n").filter((l) => !l.startsWith("(") && l.length > 0);
    expect(contentLines).toHaveLength(3);
  });

  it("searches extra dirs", async () => {
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "ro", absPath: "/mnt/vaults" }]);
    mockRgSuccess("/mnt/vaults/note.md:1:found\n");
    const result = await exec({ pattern: "found" }, deps);
    expect(result).toBe("vaults/note.md:1:found");
  });
});

// ===========================================================================
// Path containment edge cases
// ===========================================================================

describe("path containment", () => {
  it("rejects path traversal via ../ in read_file", async () => {
    const result = await tool("read_file").execute(
      { path: "data/notes/../../../etc/passwd" },
      makeDeps(),
    );
    expect(result).toContain("Error:");
  });

  it("rejects path traversal via ../ in write_file", async () => {
    const result = await tool("write_file").execute(
      { path: "skills/../../etc/shadow", content: "hack" },
      makeDeps(),
    );
    expect(result).toContain("Error:");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects path traversal via ../ in delete_file", async () => {
    const result = await tool("delete_file").execute(
      { path: "scripts/../../etc/hosts" },
      makeDeps(),
    );
    expect(result).toContain("Error:");
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("rejects extra dir path traversal", async () => {
    const deps = makeDepsWithExtra([{ name: "vaults", mode: "rw", absPath: "/mnt/vaults" }]);
    const result = await tool("read_file").execute({ path: "vaults/../../etc/passwd" }, deps);
    expect(result).toContain("Error:");
  });
});
