import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncSchedules } from "../../skills/manager.ts";
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
}> = [
  { prefix: "data/notes/", dirKey: "notesDir", dir: "notes" },
  { prefix: "skills/", dirKey: "skillsDir", dir: "skills" },
  { prefix: "scripts/", dirKey: "scriptsDir", dir: "scripts" },
  { prefix: "servers/", dirKey: "serversDir", dir: "servers" },
];

/** Writable base directories the agent is allowed to access. */
function resolvePath(
  input: string,
  deps: ExecutorDeps,
): { abs: string; dir: "notes" | "skills" | "scripts" | "servers"; baseDir: string } | null {
  const clean = input.replace(/^\.?\//, "");
  for (const { prefix, dirKey, dir } of DIR_MAPPINGS) {
    if (clean.startsWith(prefix)) {
      const baseDir = deps[dirKey];
      const abs = path.resolve(baseDir, clean.slice(prefix.length));
      if (!isContainedIn(abs, baseDir)) return null;
      return { abs, dir, baseDir };
    }
  }
  return null;
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

export const fileTools: ToolHandler[] = [
  {
    def: defineTool(
      "read_file",
      "Read a file from a writable directory (data/notes/, skills/, scripts/, servers/).",
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
      if (!resolved) return `Error: path must start with data/notes/, skills/, scripts/, or servers/`;
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
      "Write or overwrite a file. Side effects: writes to skills/ trigger schedule sync, writes to scripts/ auto chmod +x, writes to servers/ trigger MCP server reload.",
      {
        path: { type: "string", description: "Relative path within a writable directory" },
        content: { type: "string", description: "Full file content" },
      },
      ["path", "content"],
    ),
    async execute(input, deps) {
      const { path: filePath, content } = input as { path: string; content: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with data/notes/, skills/, scripts/, or servers/`;
      await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
      const escape = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escape) return escape;
      await fs.writeFile(resolved.abs, content, "utf-8");
      if (resolved.dir === "scripts") {
        await fs.chmod(resolved.abs, 0o755);
      }
      if (resolved.dir === "skills") {
        await syncSchedules(deps.absurd, deps.skillsDir, deps.recipientId);
      }
      if (resolved.dir === "servers") {
        await deps.reloadMcp?.();
      }
      return `File written: ${input.path}`;
    },
  },
  {
    def: defineTool(
      "list_files",
      "List files in a writable directory.",
      {
        directory: {
          type: "string",
          description: "Directory to list: 'data/notes', 'skills', 'scripts', or 'servers'",
        },
      },
      ["directory"],
    ),
    async execute(input, deps) {
      const { directory } = input as { directory: string };
      const dir = directory.replace(/^\.?\//, "").replace(/\/$/, "");
      const mapping = DIR_MAPPINGS.find((m) => m.prefix.replace(/\/$/, "") === dir);
      if (!mapping) return `Error: directory must be data/notes, skills, scripts, or servers`;
      const absDir = deps[mapping.dirKey];
      try {
        const entries = await fs.readdir(absDir);
        if (entries.length === 0) return "(empty directory)";
        return entries.join("\n");
      } catch {
        return "(directory does not exist)";
      }
    },
  },
  {
    def: defineTool(
      "delete_file",
      "Delete a file. Side effects: deletes in skills/ trigger schedule sync, deletes in servers/ trigger MCP server reload.",
      {
        path: { type: "string", description: "Relative path within a writable directory" },
      },
      ["path"],
    ),
    async execute(input, deps) {
      const { path: filePath } = input as { path: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with data/notes/, skills/, scripts/, or servers/`;
      const escape = await validateRealPath(resolved.abs, resolved.baseDir);
      if (escape) return escape;
      try {
        await fs.unlink(resolved.abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(file not found)";
        throw err;
      }
      if (resolved.dir === "skills") {
        await syncSchedules(deps.absurd, deps.skillsDir, deps.recipientId);
      }
      if (resolved.dir === "servers") {
        await deps.reloadMcp?.();
      }
      return `File deleted: ${filePath}`;
    },
  },
];
