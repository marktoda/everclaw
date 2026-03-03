import type Anthropic from "@anthropic-ai/sdk";

export type ToolDef = Anthropic.Tool;

export function getTools(): ToolDef[] {
  return [
    // --- File Tools ---
    tool("read_file", "Read a file from a writable directory (data/notes/, skills/, tools/).", {
      path: { type: "string", description: "Relative path within a writable directory (e.g. 'data/notes/profile.md', 'skills/morning-check.md')" },
    }, ["path"]),

    tool("write_file", "Write or overwrite a file. Side effects: writes to skills/ trigger schedule sync, writes to tools/ auto chmod +x.", {
      path: { type: "string", description: "Relative path within a writable directory" },
      content: { type: "string", description: "Full file content" },
    }, ["path", "content"]),

    tool("list_files", "List files in a writable directory.", {
      directory: { type: "string", description: "Directory to list: 'data/notes', 'skills', or 'tools'" },
    }, ["directory"]),

    tool("delete_file", "Delete a file. Side effects: deletes in skills/ trigger schedule sync.", {
      path: { type: "string", description: "Relative path within a writable directory" },
    }, ["path"]),

    // --- State Tools ---
    tool("get_state", "Read a value from the state store.", {
      namespace: { type: "string", description: "Namespace (e.g. 'workflow', 'skill:name')" },
      key: { type: "string", description: "Key" },
    }, ["namespace", "key"]),

    tool("set_state", "Write a value to the state store.", {
      namespace: { type: "string", description: "Namespace" },
      key: { type: "string", description: "Key" },
      value: { description: "JSON value to store" },
    }, ["namespace", "key", "value"]),

    tool("get_status", "Get assistant uptime, file counts, and schedule count.", {}),

    // --- Script Tools ---
    tool("run_script", "Execute a tool script. Input is passed as JSON stdin.", {
      name: { type: "string", description: "Tool script name (without extension)" },
      input: { type: "object", description: "JSON input to pass to the script" },
    }, ["name"]),

    // --- Orchestration Tools ---
    tool("sleep_for", "Suspend this task for a duration. Your worker slot is released; you resume exactly where you left off. Use for polling loops or delayed follow-ups.", {
      step_name: { type: "string", description: "Unique name for this sleep point (e.g. 'check-3'). Must be unique across the task." },
      seconds: { type: "number", description: "Seconds to sleep" },
    }, ["step_name", "seconds"]),

    tool("sleep_until", "Suspend until a specific time. Use for reminders or 'do this tomorrow' patterns.", {
      step_name: { type: "string", description: "Unique name for this sleep point" },
      wake_at: { type: "string", description: "ISO 8601 datetime (e.g. '2024-03-15T17:00:00Z')" },
    }, ["step_name", "wake_at"]),

    tool("spawn_task", "Spawn an independent sub-task that runs in the background. The spawned task has NO access to your current conversation — only the instructions you provide.", {
      task_name: { type: "string", description: "Task type: 'execute-skill', 'send-message', or 'workflow'" },
      params: { type: "object", description: "Task parameters (for 'workflow': {chatId, instructions})" },
    }, ["task_name", "params"]),

    tool("cancel_task", "Cancel a running or sleeping task.", {
      task_id: { type: "string", description: "Task ID to cancel (from list_tasks or spawn_task result)" },
    }, ["task_id"]),

    tool("list_tasks", "List active and sleeping tasks. Use to discover running workflows, check status, or find tasks to cancel.", {}),

    tool("wait_for_event", "Suspend until a named event is emitted by another task. Events are one-shot latches. Use for task-to-task coordination, NOT for waiting on user replies.", {
      event_name: { type: "string", description: "Event name to wait for (e.g. 'done:{taskId}')" },
      timeout_seconds: { type: "number", description: "Optional timeout in seconds" },
    }, ["event_name"]),

    tool("emit_event", "Emit a named event that wakes any tasks waiting on it.", {
      event_name: { type: "string", description: "Event name to emit" },
      payload: { description: "Optional JSON payload delivered to waiters" },
    }, ["event_name"]),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[] = [],
): ToolDef {
  return {
    name,
    description,
    input_schema: { type: "object" as const, properties, required },
  };
}
