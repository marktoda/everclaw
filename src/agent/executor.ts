// src/agent/executor.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import { TimeoutError } from "absurd-sdk";
import type { Pool } from "pg";
import { getState, setState } from "../memory/state.js";
import { listSkills, syncSchedules } from "../skills/manager.js";
import { runScript, listTools } from "../scripts/runner.js";
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
}

/** Writable base directories the agent is allowed to access. */
function resolvePath(input: string, deps: ExecutorDeps): { abs: string; dir: "notes" | "skills" | "tools" } | null {
  const clean = input.replace(/^\.?\//, "");
  let abs: string;
  let dir: "notes" | "skills" | "tools";
  if (clean.startsWith("data/notes/")) {
    abs = path.resolve(deps.notesDir, clean.slice("data/notes/".length));
    dir = "notes";
    if (!abs.startsWith(deps.notesDir + path.sep) && abs !== deps.notesDir) return null;
  } else if (clean.startsWith("skills/")) {
    abs = path.resolve(deps.skillsDir, clean.slice("skills/".length));
    dir = "skills";
    if (!abs.startsWith(deps.skillsDir + path.sep) && abs !== deps.skillsDir) return null;
  } else if (clean.startsWith("tools/")) {
    abs = path.resolve(deps.toolsDir, clean.slice("tools/".length));
    dir = "tools";
    if (!abs.startsWith(deps.toolsDir + path.sep) && abs !== deps.toolsDir) return null;
  } else {
    return null;
  }
  return { abs, dir };
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
        const result = await deps.absurd.spawn(input.task_name, input.params);
        return `Task spawned: ${input.task_name} (ID: ${result.taskID})`;
      }

      case "cancel_task":
        await deps.absurd.cancelTask(input.task_id);
        return `Task ${input.task_id} cancelled.`;

      case "list_tasks": {
        const qn = deps.queueName;
        if (!/^[a-z_][a-z0-9_]*$/i.test(qn)) return "Error: invalid queue name";
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

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
