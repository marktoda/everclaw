import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncSchedules } from "../../skills/manager.ts";
import { validateServerConfig } from "../../servers/manager.ts";
import type { ExecutorDeps, ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

/** Check that a resolved path stays within a base directory. */
function isContainedIn(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

const DIR_MAPPINGS: Array<{
  prefix: string;
  dirKey: keyof Pick<ExecutorDeps, "notesDir" | "skillsDir" | "scriptsDir" | "serversDir">;
  dir: "notes" | "skills" | "scripts" | "servers";
  readOnly?: boolean;
}> = [
  { prefix: "data/notes/", dirKey: "notesDir", dir: "notes" },
  { prefix: "skills/", dirKey: "skillsDir", dir: "skills" },
  { prefix: "scripts/", dirKey: "scriptsDir", dir: "scripts" },
  { prefix: "servers/", dirKey: "serversDir", dir: "servers" },
];

interface ResolvedPath {
  abs: string;
  dir: string;
  baseDir: string;
  mode?: "ro" | "rw";
}

/** Writable base directories the agent is allowed to access. */
function resolvePath(input: string, deps: ExecutorDeps): ResolvedPath | null {
  const clean = input.replace(/^\.?\//, "");
  // Check built-in dirs first
  for (const { prefix, dirKey, dir, readOnly } of DIR_MAPPINGS) {
    if (clean.startsWith(prefix)) {
      const baseDir = deps[dirKey];
      const abs = path.resolve(baseDir, clean.slice(prefix.length));
      if (!isContainedIn(abs, baseDir)) return null;
      return { abs, dir, baseDir, ...(readOnly ? { mode: "ro" as const } : {}) };
    }
  }
  // Check extra dirs
  for (const extra of deps.extraDirs) {
    const prefix = extra.name + "/";
    if (clean.startsWith(prefix)) {
      const abs = path.resolve(extra.absPath, clean.slice(prefix.length));
      if (!isContainedIn(abs, extra.absPath)) return null;
      return { abs, dir: extra.name, baseDir: extra.absPath, mode: extra.mode };
    }
  }
  return null;
}

function allDirPrefixes(deps: ExecutorDeps): string {
  const builtins = DIR_MAPPINGS.map((m) => m.prefix);
  const extras = deps.extraDirs.map((d) => `${d.name}/`);
  return [...builtins, ...extras].join(", ");
}

/** Verify that the real (symlink-resolved) path stays within the base directory. */
async function validateRealPath(abs: string, baseDir: string): Promise<string | null> {
  try {
    const real = await fs.realpath(abs);
    if (!isContainedIn(real, baseDir))
      return "Error: path escapes allowed directory via symlink";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist — check nearest existing ancestor
      try {
        const realParent = await fs.realpath(path.dirname(abs));
        if (!isContainedIn(realParent, baseDir))
          return "Error: path escapes allowed directory via symlink";
      } catch {
        // Parent doesn't exist either — will be created, safe
      }
    } else {
      throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers for glob_files / grep_files (ripgrep-backed)
// ---------------------------------------------------------------------------

interface SearchDir {
  prefix: string;
  absPath: string;
}

/** Get all allowed directories as {prefix, absPath} pairs. */
function getAllowedDirs(deps: ExecutorDeps): SearchDir[] {
  const dirs: SearchDir[] = DIR_MAPPINGS.map((m) => ({
    prefix: m.prefix,
    absPath: deps[m.dirKey],
  }));
  for (const extra of deps.extraDirs) {
    dirs.push({ prefix: extra.name + "/", absPath: extra.absPath });
  }
  return dirs;
}

/** Resolve a user-supplied directory name to a single SearchDir[], or return an error string. */
function resolveSearchDir(name: string, deps: ExecutorDeps): SearchDir[] | string {
  const clean = name.replace(/^\.?\//, "").replace(/\/$/, "");
  const mapping = DIR_MAPPINGS.find((m) => m.prefix.replace(/\/$/, "") === clean);
  if (mapping) return [{ prefix: mapping.prefix, absPath: deps[mapping.dirKey] }];
  const extra = deps.extraDirs.find((d) => d.name === clean);
  if (extra) return [{ prefix: extra.name + "/", absPath: extra.absPath }];
  const valid = [...DIR_MAPPINGS.map((m) => m.prefix.replace(/\/$/, "")), ...deps.extraDirs.map((d) => d.name)];
  return `Error: directory must be ${valid.join(", ")}`;
}

/** Convert an absolute path from rg output back to agent-relative form. */
function absToRelative(abs: string, dirs: SearchDir[]): string | null {
  for (const { prefix, absPath } of dirs) {
    if (abs === absPath || abs.startsWith(absPath + "/")) {
      const rel = abs.slice(absPath.length + 1);
      return rel ? prefix + rel : prefix.replace(/\/$/, "");
    }
  }
  return null;
}

/** Replace leading absolute path in an rg output line with agent-relative form. */
function transformOutputLine(line: string, dirs: SearchDir[]): string {
  for (const { prefix, absPath } of dirs) {
    if (line.startsWith(absPath + "/")) {
      return prefix + line.slice(absPath.length + 1);
    }
  }
  return line;
}

/** Run ripgrep with given args. Returns {stdout, error}. Exit 1 = no matches (empty stdout). */
function runRg(args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile("rg", args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout });
      // Exit code 1 = no matches; check .status (set by child_process on non-zero exit)
      const exitCode = (err as any).status as number | undefined;
      if (exitCode === 1) return resolve({ stdout: "" });
      resolve({ stdout: "", error: `Error running rg: ${stderr || err.message}` });
    });
  });
}

export const fileTools: ToolHandler[] = [
  {
    def: defineTool(
      "read_file",
      "Read a file from an accessible directory (data/notes/, skills/, scripts/, servers/).",
      {
        path: {
          type: "string",
          description:
            "Relative path within a writable directory (e.g. 'data/notes/profile.md', 'skills/morning-check.md', 'servers/github.json')",
        },
      },
      ["path"],
    ),
    async execute(input, deps) {
      const { path: filePath } = input as { path: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with ${allDirPrefixes(deps)}`;
      const escape = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escape) return escape;
      try {
        return await fs.readFile(resolved.abs, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(file not found)";
        throw err;
      }
    },
  },
  {
    def: defineTool(
      "write_file",
      "Write or overwrite a file. Side effects: writes to skills/ trigger schedule sync, writes to scripts/ auto chmod +x, writes to servers/ validate config and trigger MCP reload.",
      {
        path: { type: "string", description: "Relative path within a writable directory" },
        content: { type: "string", description: "Full file content" },
      },
      ["path", "content"],
    ),
    async execute(input, deps) {
      const { path: filePath, content } = input as { path: string; content: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with ${allDirPrefixes(deps)}`;
      if (resolved.mode === "ro") return `Error: ${resolved.dir}/ is read-only`;
      const escape = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escape) return escape;
      if (resolved.dir === "servers") {
        if (!filePath.endsWith(".json"))
          return "Error: server configs must be .json files";
        if (path.dirname(resolved.abs) !== resolved.baseDir)
          return "Error: server configs must be top-level files in servers/";
        const validation = validateServerConfig(content);
        if (!validation.ok) return `Error: invalid server config: ${validation.error}`;
      }
      await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
      await fs.writeFile(resolved.abs, content, "utf-8");
      if (resolved.dir === "scripts") {
        await fs.chmod(resolved.abs, 0o755);
      }
      if (resolved.dir === "skills") {
        await syncSchedules(deps.absurd, deps.skillsDir);
      }
      if (resolved.dir === "servers" && deps.reloadMcp) {
        await deps.reloadMcp();
      }
      return `File written: ${input.path}`;
    },
  },
  {
    def: defineTool(
      "glob_files",
      "Find files by name pattern (recursive). Searches all accessible directories unless restricted.",
      {
        pattern: {
          type: "string",
          description: "Glob pattern (e.g. '*.md', '**/*.test.ts')",
        },
        directory: {
          type: "string",
          description:
            "Restrict to one directory (e.g. 'vaults', 'data/notes', 'skills'). Omit to search all.",
        },
        limit: {
          type: "integer",
          description: "Max files to return (default 200)",
        },
      },
      ["pattern"],
    ),
    async execute(input, deps) {
      const { pattern, directory, limit: rawLimit } = input as {
        pattern: string;
        directory?: string;
        limit?: number;
      };
      const cap = rawLimit ?? 200;

      const dirs = directory ? resolveSearchDir(directory, deps) : getAllowedDirs(deps);
      if (typeof dirs === "string") return dirs; // error message

      // --no-ignore: agent-managed dirs typically lack .gitignore; extra dirs need full traversal
      const args = ["--files", "--glob", pattern, "--no-ignore", "--", ...dirs.map((d) => d.absPath)];
      const { stdout, error } = await runRg(args);
      if (error) return error;
      if (!stdout.trim()) return "(no matches found)";

      const allDirs = getAllowedDirs(deps);
      const lines = stdout.trim().split("\n");
      const mapped = lines.flatMap((line) => {
        const rel = absToRelative(line, allDirs);
        return rel ? [rel] : [];
      });
      if (mapped.length === 0) return "(no matches found)";
      const truncated = mapped.length > cap;
      const result = mapped.slice(0, cap).join("\n");
      return truncated ? `${result}\n\n(truncated — ${mapped.length} total, showing first ${cap})` : result;
    },
  },
  {
    def: defineTool(
      "grep_files",
      "Search file contents by regex. Returns matching lines with file paths and line numbers.",
      {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        directory: {
          type: "string",
          description:
            "Restrict to one directory (e.g. 'vaults', 'data/notes'). Omit to search all.",
        },
        glob: {
          type: "string",
          description: "File glob filter (e.g. '*.ts', '*.md')",
        },
        ignore_case: {
          type: "boolean",
          description: "Case-insensitive search (default false)",
        },
        context_lines: {
          type: "integer",
          description: "Lines of context before/after each match (default 0)",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            "Output format: 'content' (matching lines, default), 'files_with_matches' (file paths only), 'count' (match counts per file)",
        },
        limit: {
          type: "integer",
          description: "Max output lines/entries (default 100)",
        },
      },
      ["pattern"],
    ),
    async execute(input, deps) {
      const {
        pattern,
        directory,
        glob: fileGlob,
        ignore_case: ignoreCase,
        context_lines: contextLines,
        output_mode: outputMode,
        limit: rawLimit,
      } = input as {
        pattern: string;
        directory?: string;
        glob?: string;
        ignore_case?: boolean;
        context_lines?: number;
        output_mode?: string;
        limit?: number;
      };
      const cap = rawLimit ?? 100;

      const dirs = directory ? resolveSearchDir(directory, deps) : getAllowedDirs(deps);
      if (typeof dirs === "string") return dirs;

      const args: string[] = [];
      if (outputMode === "files_with_matches") args.push("-l");
      else if (outputMode === "count") args.push("-c");
      else args.push("-n");
      // --no-ignore: agent-managed dirs typically lack .gitignore; extra dirs need full traversal
      args.push("--no-heading", "--color", "never", "--no-ignore");
      if (ignoreCase) args.push("-i");
      if (contextLines && contextLines > 0) args.push("-C", String(contextLines));
      if (fileGlob) args.push("--glob", fileGlob);
      args.push("--", pattern, ...dirs.map((d) => d.absPath));

      const { stdout, error } = await runRg(args);
      if (error) return error;
      if (!stdout.trim()) return "(no matches found)";

      const allDirs = getAllowedDirs(deps);
      const lines = stdout.trimEnd().split("\n");
      const mapped = lines.map((line) => transformOutputLine(line, allDirs));
      const truncated = mapped.length > cap;
      const result = mapped.slice(0, cap).join("\n");
      return truncated ? `${result}\n\n(truncated — ${mapped.length} total, showing first ${cap})` : result;
    },
  },
  {
    def: defineTool(
      "delete_file",
      "Delete a file. Side effects: deletes in skills/ trigger schedule sync, deletes in servers/ trigger MCP reload.",
      {
        path: { type: "string", description: "Relative path within a writable directory" },
      },
      ["path"],
    ),
    async execute(input, deps) {
      const { path: filePath } = input as { path: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with ${allDirPrefixes(deps)}`;
      if (resolved.mode === "ro") return `Error: ${resolved.dir}/ is read-only`;
      const escape = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escape) return escape;
      try {
        await fs.unlink(resolved.abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(file not found)";
        throw err;
      }
      if (resolved.dir === "skills") {
        await syncSchedules(deps.absurd, deps.skillsDir);
      }
      if (resolved.dir === "servers" && deps.reloadMcp) {
        await deps.reloadMcp();
      }
      return `File deleted: ${filePath}`;
    },
  },
];
