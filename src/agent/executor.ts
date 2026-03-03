// src/agent/executor.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import { TimeoutError } from "absurd-sdk";
import type { Pool } from "pg";
import { getState, setState } from "../memory/state.ts";
import { listSkills, syncSchedules } from "../skills/manager.ts";
import { runScript, listTools } from "../scripts/runner.ts";
import * as fs from "fs/promises";
import * as path from "path";

export interface ExecutorDeps {
  absurd: Absurd;
  pool: Pool;
  ctx: TaskContext;
  queueName: string;
  chatId: number;
  notesDir: string;
  skillsDir: string;
  toolsDir: string;
  scriptTimeout: number;
  startedAt: Date;
  searchApiKey?: string;
}

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

export function createExecutor(deps: ExecutorDeps) {
  return async (name: string, input: Record<string, any>): Promise<string> => {
    switch (name) {
      // --- File Tools ---
      case "read_file": {
        const resolved = resolvePath(input.path, deps);
        if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
        try {
          return await fs.readFile(resolved.abs, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") return "(file not found)";
          throw err;
        }
      }

      case "write_file": {
        const resolved = resolvePath(input.path, deps);
        if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
        await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
        await fs.writeFile(resolved.abs, input.content, "utf-8");
        // Side effects by directory
        if (resolved.dir === "tools") {
          await fs.chmod(resolved.abs, 0o755);
        }
        if (resolved.dir === "skills") {
          await syncSchedules(deps.absurd, deps.skillsDir, deps.chatId);
        }
        return `File written: ${input.path}`;
      }

      case "list_files": {
        const dir = (input.directory as string).replace(/^\.?\//, "");
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
      }

      case "delete_file": {
        const resolved = resolvePath(input.path, deps);
        if (!resolved) return `Error: path must start with data/notes/, skills/, or tools/`;
        try {
          await fs.unlink(resolved.abs);
        } catch (err: any) {
          if (err.code === "ENOENT") return "(file not found)";
          throw err;
        }
        if (resolved.dir === "skills") {
          await syncSchedules(deps.absurd, deps.skillsDir, deps.chatId);
        }
        return `File deleted: ${input.path}`;
      }

      // --- State Tools ---
      case "get_state": {
        const val = await getState(deps.pool, input.namespace, input.key);
        return val === null ? "(not set)" : JSON.stringify(val);
      }

      case "set_state":
        await setState(deps.pool, input.namespace, input.key, input.value);
        return "State saved.";

      case "get_status": {
        const uptime = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
        const skills = await listSkills(deps.skillsDir);
        const tools = await listTools(deps.toolsDir);
        const schedules = await deps.absurd.listSchedules();
        return [
          `Uptime: ${uptime}s`,
          `Notes: ${(await fs.readdir(deps.notesDir).catch(() => [])).length} files`,
          `Skills: ${skills.length}`,
          `Tools: ${tools.length}`,
          `Schedules: ${schedules.length}`,
        ].join("\n");
      }

      // --- Script Tools ---
      case "run_script": {
        const tools = await listTools(deps.toolsDir);
        const tool = tools.find(t => t.name === input.name);
        if (!tool) return `Tool "${input.name}" not found. Available: ${tools.map(t => t.name).join(", ")}`;
        return await runScript(tool.path, JSON.stringify(input.input ?? {}), deps.scriptTimeout);
      }

      // --- Orchestration Tools ---
      case "sleep_for":
        await deps.ctx.sleepFor(input.step_name, input.seconds);
        return `Resumed after sleeping ${input.seconds}s.`;

      case "sleep_until": {
        const wakeAt = new Date(input.wake_at);
        await deps.ctx.sleepUntil(input.step_name, wakeAt);
        return `Resumed. It is now ${new Date().toISOString()}.`;
      }

      case "wait_for_event": {
        try {
          const payload = await deps.ctx.awaitEvent(input.event_name, {
            timeout: input.timeout_seconds,
          });
          return JSON.stringify({ received: true, payload });
        } catch (err) {
          if (err instanceof TimeoutError) {
            return JSON.stringify({ received: false, timed_out: true });
          }
          throw err; // SuspendTask and other errors propagate
        }
      }

      case "emit_event":
        await deps.ctx.emitEvent(input.event_name, input.payload ?? null);
        return `Event "${input.event_name}" emitted.`;

      case "spawn_task": {
        const params = { ...input.params };
        // Resolve "current" or missing chatId to the executor's chatId
        if (params.chatId === "current" || params.chatId == null) {
          params.chatId = deps.chatId;
        }
        const result = await deps.absurd.spawn(input.task_name, params);
        return `Task spawned: ${input.task_name} (ID: ${result.taskID})`;
      }

      case "cancel_task":
        try {
          await deps.absurd.cancelTask(input.task_id);
          return `Task ${input.task_id} cancelled.`;
        } catch (err: any) {
          if (err.message?.includes("not found")) {
            return `Task ${input.task_id} not found (may have already completed or been cancelled).`;
          }
          throw err;
        }

      case "list_tasks": {
        const qn = deps.queueName; // validated at config load time
        const result = await deps.pool.query(
          `SELECT t.task_id, t.task_name, t.state, r.state as run_state, r.available_at
           FROM absurd.t_${qn} t
           JOIN absurd.r_${qn} r ON r.run_id = t.last_attempt_run
           WHERE t.state IN ('running', 'sleeping', 'pending')
           ORDER BY t.enqueue_at DESC LIMIT 20`
        );
        if (result.rows.length === 0) return "No active tasks.";
        return result.rows.map((r: any) =>
          `- ${r.task_name} (${r.task_id.slice(0, 8)}...) state=${r.run_state}` +
          (r.available_at ? ` wakes=${new Date(r.available_at).toISOString()}` : "")
        ).join("\n");
      }

      // --- Web Tools ---
      case "web_search": {
        if (!deps.searchApiKey) return "Error: web search not configured (BRAVE_SEARCH_API_KEY not set)";
        const q = (input.query as string).trim();
        if (!q) return "Error: query is required";
        const count = Math.min(input.count ?? 5, 20);
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`;
        const resp = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "X-Subscription-Token": deps.searchApiKey,
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return `Error: search API returned ${resp.status}`;
        const data = await resp.json() as any;
        const results = data.web?.results ?? [];
        if (results.length === 0) return "No results found.";
        return results.map((r: any) =>
          `**${r.title}**\n${r.url}\n${r.description ?? ""}`
        ).join("\n\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
