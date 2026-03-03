import { TimeoutError } from "absurd-sdk";
import { defineTool } from "./types.ts";
import type { ToolHandler } from "./types.ts";

export const orchestrationTools: ToolHandler[] = [
  {
    def: defineTool("sleep_for", "Suspend this task for a duration. Your worker slot is released; you resume exactly where you left off. Use for polling loops or delayed follow-ups.", {
      step_name: { type: "string", description: "Unique name for this sleep point (e.g. 'check-3'). Must be unique across the task." },
      seconds: { type: "number", description: "Seconds to sleep" },
    }, ["step_name", "seconds"]),
    suspends: true,
    async execute(input, deps) {
      await deps.ctx.sleepFor(input.step_name, input.seconds);
      return `Resumed after sleeping ${input.seconds}s.`;
    },
  },
  {
    def: defineTool("sleep_until", "Suspend until a specific time. Use for reminders or 'do this tomorrow' patterns.", {
      step_name: { type: "string", description: "Unique name for this sleep point" },
      wake_at: { type: "string", description: "ISO 8601 datetime (e.g. '2024-03-15T17:00:00Z')" },
    }, ["step_name", "wake_at"]),
    suspends: true,
    async execute(input, deps) {
      const wakeAt = new Date(input.wake_at);
      await deps.ctx.sleepUntil(input.step_name, wakeAt);
      return `Resumed. It is now ${new Date().toISOString()}.`;
    },
  },
  {
    def: defineTool("spawn_task", "Spawn an independent sub-task that runs in the background. The spawned task has NO access to your current conversation — only the instructions you provide.", {
      task_name: { type: "string", description: "Task type: 'execute-skill', 'send-message', or 'workflow'" },
      params: { type: "object", description: "Task parameters (for 'workflow': {instructions}, for 'send-message': {text}, for 'execute-skill': {skillName}). chatId is auto-injected." },
    }, ["task_name", "params"]),
    async execute(input, deps) {
      const params = { ...input.params };
      if (params.chatId === "current" || params.chatId == null) {
        params.chatId = deps.chatId;
      }
      const result = await deps.absurd.spawn(input.task_name, params);
      return `Task spawned: ${input.task_name} (ID: ${result.taskID})`;
    },
  },
  {
    def: defineTool("cancel_task", "Cancel a running or sleeping task.", {
      task_id: { type: "string", description: "Task ID to cancel (from list_tasks or spawn_task result)" },
    }, ["task_id"]),
    async execute(input, deps) {
      try {
        await deps.absurd.cancelTask(input.task_id);
        return `Task ${input.task_id} cancelled.`;
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          return `Task ${input.task_id} not found (may have already completed or been cancelled).`;
        }
        throw err;
      }
    },
  },
  {
    def: defineTool("list_tasks", "List active and sleeping tasks. Use to discover running workflows, check status, or find tasks to cancel.", {}),
    async execute(_input, deps) {
      const qn = deps.queueName; // validated at config load time
      const result = await deps.pool.query(
        `SELECT t.task_id, t.task_name, t.params, t.state, r.state as run_state, r.available_at
         FROM absurd.t_${qn} t
         JOIN absurd.r_${qn} r ON r.run_id = t.last_attempt_run
         WHERE t.state IN ('running', 'sleeping', 'pending')
         ORDER BY t.enqueue_at DESC LIMIT 20`
      );
      if (result.rows.length === 0) return "No active tasks.";
      return result.rows.map((r: any) => {
        const params = r.params ?? {};
        const summary = params.text
          ? ` "${params.text.slice(0, 80)}${params.text.length > 80 ? "..." : ""}"`
          : params.instructions
            ? ` "${params.instructions.slice(0, 80)}${params.instructions.length > 80 ? "..." : ""}"`
            : params.skillName
              ? ` skill=${params.skillName}`
              : "";
        return `- ${r.task_name} (${r.task_id}) state=${r.run_state}${summary}` +
          (r.available_at ? ` wakes=${new Date(r.available_at).toISOString()}` : "");
      }).join("\n");
    },
  },
  {
    def: defineTool("wait_for_event", "Suspend until a named event is emitted by another task. Events are one-shot latches. Use for task-to-task coordination, NOT for waiting on user replies.", {
      event_name: { type: "string", description: "Event name to wait for (e.g. 'done:{taskId}')" },
      timeout_seconds: { type: "number", description: "Optional timeout in seconds" },
    }, ["event_name"]),
    suspends: true,
    async execute(input, deps) {
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
    },
  },
  {
    def: defineTool("emit_event", "Emit a named event that wakes any tasks waiting on it.", {
      event_name: { type: "string", description: "Event name to emit" },
      payload: { description: "Optional JSON payload delivered to waiters" },
    }, ["event_name"]),
    async execute(input, deps) {
      await deps.ctx.emitEvent(input.event_name, input.payload ?? null);
      return `Event "${input.event_name}" emitted.`;
    },
  },
];
