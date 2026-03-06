import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isContainedIn, validateRealPath } from "../../path-utils.ts";
import { validateServerConfig } from "../../servers/manager.ts";
import { syncSchedules } from "../../skills/manager.ts";
import type { ExecutorDeps, ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

const DIR_MAPPINGS: Array<{
  prefix: string;
  dir: "notes" | "skills" | "scripts" | "servers";
  readOnly?: boolean;
}> = [
  { prefix: "data/notes/", dir: "notes" },
  { prefix: "skills/", dir: "skills" },
  { prefix: "scripts/", dir: "scripts" },
  { prefix: "servers/", dir: "servers" },
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
  for (const { prefix, dir, readOnly } of DIR_MAPPINGS) {
    if (clean.startsWith(prefix)) {
      const baseDir = deps.dirs[dir];
      const abs = path.resolve(baseDir, clean.slice(prefix.length));
      if (!isContainedIn(abs, baseDir)) return null;
      return { abs, dir, baseDir, ...(readOnly ? { mode: "ro" as const } : {}) };
    }
  }
  // Check extra dirs
  for (const extra of deps.dirs.extra) {
    const prefix = `${extra.name}/`;
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
  const extras = deps.dirs.extra.map((d) => `${d.name}/`);
  return [...builtins, ...extras].join(", ");
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
    absPath: deps.dirs[m.dir],
  }));
  for (const extra of deps.dirs.extra) {
    dirs.push({ prefix: `${extra.name}/`, absPath: extra.absPath });
  }
  return dirs;
}

/** Resolve a user-supplied directory name to a single SearchDir[], or return an error string. */
function resolveSearchDir(name: string, deps: ExecutorDeps): SearchDir[] | string {
  const clean = name.replace(/^\.?\//, "").replace(/\/$/, "");
  const mapping = DIR_MAPPINGS.find((m) => m.prefix.replace(/\/$/, "") === clean);
  if (mapping) return [{ prefix: mapping.prefix, absPath: deps.dirs[mapping.dir] }];
  const extra = deps.dirs.extra.find((d) => d.name === clean);
  if (extra) return [{ prefix: `${extra.name}/`, absPath: extra.absPath }];
  const valid = [
    ...DIR_MAPPINGS.map((m) => m.prefix.replace(/\/$/, "")),
    ...deps.dirs.extra.map((d) => d.name),
  ];
  return `Error: directory must be ${valid.join(", ")}`;
}

/** Convert an absolute path from rg output back to agent-relative form. */
function absToRelative(abs: string, dirs: SearchDir[]): string | null {
  for (const { prefix, absPath } of dirs) {
    if (abs === absPath || abs.startsWith(`${absPath}/`)) {
      const rel = abs.slice(absPath.length + 1);
      return rel ? prefix + rel : prefix.replace(/\/$/, "");
    }
  }
  return null;
}

/** Replace leading absolute path in an rg output line with agent-relative form. */
function transformOutputLine(line: string, dirs: SearchDir[]): string {
  for (const { prefix, absPath } of dirs) {
    if (line.startsWith(`${absPath}/`)) {
      return prefix + line.slice(absPath.length + 1);
    }
  }
  return line;
}

/** Run ripgrep with given args. Returns {stdout, error}. Exit 1 = no matches (empty stdout). */
function runRg(args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      "rg",
      args,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout });
        // Exit code 1 = no matches; check .status (set by child_process on non-zero exit)
        const exitCode = (err as any).status as number | undefined;
        if (exitCode === 1) return resolve({ stdout: "" });
        resolve({ stdout: "", error: `Error running rg: ${stderr || err.message}` });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Declarative side-effect hooks for write_file / delete_file
// ---------------------------------------------------------------------------

interface DirHook {
  validate?: (absPath: string, baseDir: string, content: string) => string | null;
  onWrite?: (absPath: string, deps: ExecutorDeps) => Promise<void>;
  onDelete?: (absPath: string, deps: ExecutorDeps) => Promise<void>;
}

const DIR_HOOKS: Record<string, DirHook> = {
  skills: {
    onWrite: async (_, deps) => {
      await syncSchedules(deps.absurd, deps.dirs.skills);
    },
    onDelete: async (_, deps) => {
      await syncSchedules(deps.absurd, deps.dirs.skills);
    },
  },
  scripts: {
    onWrite: async (abs) => {
      await fs.chmod(abs, 0o755);
    },
  },
  servers: {
    validate: (abs, baseDir, content) => {
      if (!abs.endsWith(".json")) return "Error: server configs must be .json files";
      if (path.dirname(abs) !== baseDir)
        return "Error: server configs must be top-level files in servers/";
      const v = validateServerConfig(content);
      if (!v.ok) return `Error: invalid server config: ${v.error}`;
      return null;
    },
    onWrite: async (_, deps) => {
      if (deps.reloadMcp) await deps.reloadMcp();
    },
    onDelete: async (_, deps) => {
      if (deps.reloadMcp) await deps.reloadMcp();
    },
  },
};

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
      const escapeErr = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escapeErr) return escapeErr;
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
      const escapeErr = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escapeErr) return escapeErr;

      const hook = DIR_HOOKS[resolved.dir];
      if (hook?.validate) {
        const err = hook.validate(resolved.abs, resolved.baseDir, content);
        if (err) return err;
      }

      await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
      await fs.writeFile(resolved.abs, content, "utf-8");

      if (hook?.onWrite) await hook.onWrite(resolved.abs, deps);
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
      const {
        pattern,
        directory,
        limit: rawLimit,
      } = input as {
        pattern: string;
        directory?: string;
        limit?: number;
      };
      const cap = rawLimit ?? 200;

      const allDirs = getAllowedDirs(deps);
      const dirs = directory ? resolveSearchDir(directory, deps) : allDirs;
      if (typeof dirs === "string") return dirs; // error message

      // --no-ignore: agent-managed dirs typically lack .gitignore; extra dirs need full traversal
      const args = [
        "--files",
        "--glob",
        pattern,
        "--no-ignore",
        "--",
        ...dirs.map((d) => d.absPath),
      ];
      const { stdout, error } = await runRg(args);
      if (error) return error;
      if (!stdout.trim()) return "(no matches found)";
      const lines = stdout.trim().split("\n");
      const mapped = lines.flatMap((line) => {
        const rel = absToRelative(line, allDirs);
        return rel ? [rel] : [];
      });
      if (mapped.length === 0) return "(no matches found)";
      const truncated = mapped.length > cap;
      const result = mapped.slice(0, cap).join("\n");
      return truncated
        ? `${result}\n\n(truncated — ${mapped.length} total, showing first ${cap})`
        : result;
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

      const allDirs = getAllowedDirs(deps);
      const dirs = directory ? resolveSearchDir(directory, deps) : allDirs;
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
      const lines = stdout.trimEnd().split("\n");
      const mapped = lines.map((line) => transformOutputLine(line, allDirs));
      const truncated = mapped.length > cap;
      const result = mapped.slice(0, cap).join("\n");
      return truncated
        ? `${result}\n\n(truncated — ${mapped.length} total, showing first ${cap})`
        : result;
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
      const escapeErr = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escapeErr) return escapeErr;
      try {
        await fs.unlink(resolved.abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(file not found)";
        throw err;
      }
      const hook = DIR_HOOKS[resolved.dir];
      if (hook?.onDelete) await hook.onDelete(resolved.abs, deps);
      return `File deleted: ${filePath}`;
    },
  },
];
