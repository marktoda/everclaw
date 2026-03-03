import * as fs from "fs/promises";
import * as path from "path";
import { syncSchedules } from "../../skills/manager.ts";
import { defineTool } from "./types.ts";
import type { ToolHandler, ExecutorDeps } from "./types.ts";

/** Check that a resolved path stays within a base directory. */
function isContainedIn(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

const DIR_MAPPINGS: Array<{ prefix: string; dirKey: keyof Pick<ExecutorDeps, "notesDir" | "skillsDir" | "toolsDir">; dir: "notes" | "skills" | "tools" }> = [
  { prefix: "data/notes/", dirKey: "notesDir", dir: "notes" },
  { prefix: "skills/", dirKey: "skillsDir", dir: "skills" },
  { prefix: "tools/", dirKey: "toolsDir", dir: "tools" },
];

/** Writable base directories the agent is allowed to access. */
function resolvePath(input: string, deps: ExecutorDeps): { abs: string; dir: "notes" | "skills" | "tools" } | null {
  const clean = input.replace(/^\.?\//, "");
  for (const { prefix, dirKey, dir } of DIR_MAPPINGS) {
    if (clean.startsWith(prefix)) {
      const abs = path.resolve(deps[dirKey], clean.slice(prefix.length));
      if (!isContainedIn(abs, deps[dirKey])) return null;
      return { abs, dir };
    }
  }
  return null;
}

export const fileTools: ToolHandler[] = [
  {
    def: defineTool("read_file", "Read a file from a writable directory (data/notes/, skills/, tools/).", {
      path: { type: "string", description: "Relative path within a writable directory (e.g. 'data/notes/profile.md', 'skills/morning-check.md')" },
    }, ["path"]),
    async execute(input, deps) {
      const { path: filePath } = input as { path: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
      try {
        return await fs.readFile(resolved.abs, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(file not found)";
        throw err;
      }
    },
  },
  {
    def: defineTool("write_file", "Write or overwrite a file. Side effects: writes to skills/ trigger schedule sync, writes to tools/ auto chmod +x.", {
      path: { type: "string", description: "Relative path within a writable directory" },
      content: { type: "string", description: "Full file content" },
    }, ["path", "content"]),
    async execute(input, deps) {
      const { path: filePath, content } = input as { path: string; content: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
      await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
      await fs.writeFile(resolved.abs, content, "utf-8");
      if (resolved.dir === "tools") {
        await fs.chmod(resolved.abs, 0o755);
      }
      if (resolved.dir === "skills") {
        await syncSchedules(deps.absurd, deps.skillsDir, deps.recipientId);
      }
      return `File written: ${input.path}`;
    },
  },
  {
    def: defineTool("list_files", "List files in a writable directory.", {
      directory: { type: "string", description: "Directory to list: 'data/notes', 'skills', or 'tools'" },
    }, ["directory"]),
    async execute(input, deps) {
      const { directory } = input as { directory: string };
      const dir = directory.replace(/^\.?\//, "");
      let absDir: string;
      if (dir === "data/notes" || dir === "data/notes/") absDir = deps.notesDir;
      else if (dir === "skills" || dir === "skills/") absDir = deps.skillsDir;
      else if (dir === "tools" || dir === "tools/") absDir = deps.toolsDir;
      else return `Error: directory must be data/notes, skills, or tools`;
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
    def: defineTool("delete_file", "Delete a file. Side effects: deletes in skills/ trigger schedule sync.", {
      path: { type: "string", description: "Relative path within a writable directory" },
    }, ["path"]),
    async execute(input, deps) {
      const { path: filePath } = input as { path: string };
      const resolved = resolvePath(filePath, deps);
      if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
      try {
        await fs.unlink(resolved.abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(file not found)";
        throw err;
      }
      if (resolved.dir === "skills") {
        await syncSchedules(deps.absurd, deps.skillsDir, deps.recipientId);
      }
      return `File deleted: ${filePath}`;
    },
  },
];
