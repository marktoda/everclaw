# Workflow Patterns

Reference for common workflow patterns using durable primitives.

## Reminders

Use `sleep_until` for one-shot future actions. No state store needed.

```
User: "Remind me to call Mom at 5pm"
1. sleep_until("reminder-call-mom", "2024-03-15T17:00:00Z")
2. Task suspends, worker slot freed
3. At 5pm, task resumes
4. Send "Reminder: call Mom!"
5. Task completes
```

## Polling / Monitoring

Use `sleep_for` in a loop within one task. Increment step names.

```
User: "Check if example.com is back up, check every 30s"
1. run_script("fetch-url", {url: "https://example.com"})
2. If down: sleep_for("check-1", 30) → resume → check again with "check-2"
3. If up: send "example.com is back up!"
```

## Background Work

Use `spawn_task` so the user can keep chatting.

```
User: "Run a health check on all my services in the background"
1. spawn_task("workflow", {recipientId: "current", instructions: "Check health of..."})
2. Reply "Started background health check, I'll report back."
3. Current task completes, user keeps chatting
4. Background workflow runs independently, sends results when done
```

## User Confirmation

Ask question → save state → complete. Resume on next message.

```
User: "Delete all old log files"
1. Find 47 files, send "Found 47 old log files. Delete them all?"
2. set_state("workflow", "pending-action", {action: "delete-logs", files: [...]})
3. Task completes
4. User replies "yes" → new handle-message task
5. Check get_state("workflow", "pending-action") → get file list
6. Delete files, clear state, confirm
```

## Multi-Step Deployment

Combine tools for complex workflows.

```
User: "Deploy to staging, run tests, then deploy to prod"
1. run_script("deploy", {env: "staging"})
2. sleep_for("wait-staging-1", 30)
3. run_script("health-check", {env: "staging"}) → not ready
4. sleep_for("wait-staging-2", 30)
5. Health check passes → run_script("run-tests", {env: "staging"})
6. Tests pass → run_script("deploy", {env: "prod"})
7. Send "Deployment complete!"
```

## Event Coordination

Use events for task-to-task signaling. Name events with task IDs.

```
Parent task spawns child:
1. result = spawn_task("workflow", {recipientId: "current", instructions: "..."})
2. wait_for_event("done:${result.taskID}", timeout: 300)
3. Resume when child emits "done:{taskID}" with result payload

Child task signals completion:
1. Do work...
2. emit_event("done:{myTaskId}", {status: "success", data: ...})
```
