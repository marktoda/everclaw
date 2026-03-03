# Test Harness Design: Layered Test Pyramid

**Date**: 2026-03-02
**Status**: Approved

## Problem

Current tests (197 across 12 files) are pure unit tests with heavy mocking. They verify "does the code call the right mocks" but not "does the system actually work." Key gaps:

- No test validates that message arrays sent to Claude are API-valid
- No test wires real Postgres (history, state, list_tasks SQL)
- No test runs the agent loop with a real executor
- No test exercises Absurd task registration + worker claim/execute
- syncSchedules, readAllNotes, web_search, script error paths untested

## Approach: Three-Layer Pyramid

### Layer 1 — Contract Tests (fast, no Docker)

A `FakeAnthropic` class validates every `messages.create` call against the Anthropic API contract, then returns scripted responses.

**File**: `src/agent/contract.test.ts`

**Tests**:
- Fresh conversation produces valid first API call
- Reconstructed history with tool_use/tool_result is API-valid
- Orphaned tool_result at history window start is cleaned up
- Tool execution produces correctly paired tool_result
- Multiple parallel tool calls → all results in one user message with matching IDs
- 20-turn max → all 20 calls valid

### Layer 2 — Integration Tests (Testcontainers Postgres)

Wire real agent loop + executor + history + state + skills against real Postgres. Mock only Claude (via FakeAnthropic).

**File**: `src/agent/loop.integration.test.ts`

**Tests**:
- Full message round-trip: message → agent loop → history rows → query back → match what FakeAnthropic saw
- Tool execution with real files in temp dir (write → read → list → delete)
- State persistence across two agent loop invocations
- History reconstruction fidelity: first message triggers tool use, second message loads history, FakeAnthropic validates reconstructed messages
- Skill schedule sync: write skill with cron → Absurd schedule created, delete → removed
- Real script execution via temp dir

### Layer 3 — System Tests (real Absurd worker)

Register real task handlers, spawn tasks, let the worker claim and execute them.

**File**: `src/tasks/system.test.ts`

**Tests**:
- handle-message end-to-end: spawn → worker claims → agent loop → bot.sendMessage called
- send-message: spawn → worker claims → message sent
- execute-skill: write skill file → spawn → worker runs → FakeAnthropic receives skill content
- workflow: spawn with instructions → worker runs agent loop
- spawn_task from within agent: executor spawns real Absurd task → child task completes
- sleep_for / resume: task suspends → Absurd wakes at 0s → resumes and completes

## New Infrastructure

### Dependencies

```
devDependencies:
  testcontainers  — Postgres Docker container per test suite
```

### File Structure

```
src/
  test/
    harness.ts              — Postgres container, migrations, pool factory
    fake-anthropic.ts       — contract-validating scenario engine
    scenarios.ts            — reusable conversation scenarios
  agent/
    contract.test.ts        — Layer 1
    loop.integration.test.ts — Layer 2
  tasks/
    system.test.ts          — Layer 3
```

### Test Harness (`src/test/harness.ts`)

- `GenericContainer("postgres:17")` via testcontainers
- Runs `sql/001-absurd.sql` and `sql/002-assistant.sql`
- Creates Absurd instance + queue
- Exports `setupTestDb()` → `{ pool, absurd, teardown }`
- One container per suite (beforeAll/afterAll), unique chatId per test

### FakeAnthropic (`src/test/fake-anthropic.ts`)

Scenario-driven fake that validates every request:

1. **Message alternation**: user/assistant must alternate
2. **tool_result placement**: must follow assistant with matching tool_use
3. **No orphan tool_use**: every tool_use must have corresponding tool_result
4. **Content block shapes**: correct `type`, required fields present
5. **Required params**: model, max_tokens, system present
6. **No duplicate tool_use IDs**

Throws detailed error on violation showing the exact issue + full message array.

### Scenarios (`src/test/scenarios.ts`)

Pre-built scenarios:
- `SIMPLE_TEXT_REPLY` — single text response
- `SINGLE_TOOL_USE` — one tool call then text
- `MULTI_TOOL_PARALLEL` — multiple tools in one response
- `MULTI_TURN_TOOLS` — several tool rounds
- `TEXT_PLUS_TOOL` — text and tool_use in same response
- `MAX_TURNS_EXHAUSTION` — 20 tool_use responses
- `SUSPENDING_TOOL` — uses sleep_for

### Vitest Configuration

- Existing unit tests: `pnpm test` (default, fast)
- Integration + system: `pnpm test:integration` with separate vitest config
- File naming: `.integration.test.ts` and `.system.test.ts`
- Integration tests use longer timeouts (30s default)

## What Stays

All 197 existing unit tests stay unchanged. They provide fast feedback for individual function behavior. The new layers add confidence for wiring and contracts.
