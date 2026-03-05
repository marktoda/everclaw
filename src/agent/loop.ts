// src/agent/loop.ts

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { ExtraDir } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { Message } from "../memory/history.ts";
import { appendMessage, getRecentMessages } from "../memory/history.ts";
import { deconstructMessages, reconstructMessages } from "../memory/messages.ts";
import type { ScriptEntry } from "../scripts/runner.ts";
import { listScripts } from "../scripts/runner.ts";
import type { ServerSummary } from "../servers/manager.ts";
import type { SkillSummary } from "../skills/manager.ts";
import { listSkills } from "../skills/manager.ts";
import { stripInternalTags } from "./output.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { ToolRegistry } from "./tools/index.ts";

const MAX_TURNS = 50;

interface Dirs {
  notes: string;
  skills: string;
  scripts: string;
}

export interface AgentDeps {
  anthropic: Anthropic;
  pool: Pool;
  model: string;
  dirs: Dirs;
  maxHistory: number;
  registry: ToolRegistry;
  log?: Logger;
  mcpSummaries?: ServerSummary[];
  extraDirs?: ExtraDir[];
  /** Called with filtered text as it becomes available. Must be awaited for delivery. */
  onText?: (text: string) => Promise<void>;
}

/** Read all .md files in the pinned notes directory and concatenate their contents. */
async function readPinnedNotes(notesDir: string): Promise<string> {
  const pinnedDir = path.join(notesDir, "pinned");
  let entries: string[];
  try {
    entries = await fs.readdir(pinnedDir);
  } catch {
    return "";
  }
  const mdEntries = entries.filter((e) => e.endsWith(".md")).sort();
  const contents = await Promise.all(
    mdEntries.map((entry) => fs.readFile(path.join(pinnedDir, entry), "utf-8").catch(() => "")),
  );
  return contents
    .map((content, i) => (content.trim() ? `### ${mdEntries[i]}\n\n${content}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** List .md filenames in the root notes directory (not recursive, excludes subdirs). */
async function listAvailableNotes(notesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(notesDir);
  } catch {
    return [];
  }
  return entries.filter((e) => e.endsWith(".md")).sort();
}

export async function runAgentLoop(
  ctx: TaskContext,
  recipientId: string,
  userMessage: string,
  deps: AgentDeps,
): Promise<string> {
  const log = deps.log;

  // Load context (checkpointed)
  const context = await ctx.step("load-context", async () => {
    const [pinnedNotes, availableNotes, history, skills, tools] = await Promise.all([
      readPinnedNotes(deps.dirs.notes),
      listAvailableNotes(deps.dirs.notes),
      getRecentMessages(deps.pool, recipientId, deps.maxHistory),
      listSkills(deps.dirs.skills),
      listScripts(deps.dirs.scripts),
    ]);
    return { pinnedNotes, availableNotes, history, skills, tools };
  });

  log?.debug("context loaded");

  const systemPrompt = buildSystemPrompt({
    pinnedNotes: context.pinnedNotes as string,
    availableNotes: context.availableNotes as string[],
    skills: (context.skills as SkillSummary[]).map((s) => ({
      name: s.name,
      description: s.description,
      schedule: s.schedule,
    })),
    tools: (context.tools as ScriptEntry[]).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    mcpServers: deps.mcpSummaries,
    extraDirs: deps.extraDirs,
  });

  const messages = reconstructMessages(context.history as Message[]);
  messages.push({ role: "user", content: userMessage });

  const preLoopLength = messages.length;
  let reply = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await ctx.step(`agent-turn-${turn}`, async () => {
      const r = await deps.anthropic.messages.create({
        model: deps.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: deps.registry.definitions,
      });
      return { content: r.content, stopReason: r.stop_reason };
    });

    const content = resp.content as Anthropic.ContentBlock[];
    messages.push({ role: "assistant", content });

    // Extract text blocks for reply and sending
    const textBlocks = content.filter((b): b is Anthropic.TextBlock => b.type === "text");

    // Send text to the caller — wrapped in ctx.step() so that text is NOT
    // re-sent when the task resumes after a suspending tool (sleep_for, etc.).
    // On replay, ctx.step returns the cached result without executing the fn.
    if (textBlocks.length > 0 && deps.onText) {
      await ctx.step(`send-text-${turn}`, async () => {
        for (const block of textBlocks) {
          const filtered = stripInternalTags(block.text);
          if (filtered) await deps.onText?.(filtered);
        }
        return true;
      });
    }

    if ((resp.stopReason as string) !== "tool_use") {
      reply = textBlocks.map((b) => b.text).join("\n");
      log?.info({ turns: turn + 1 }, "agent loop complete");
      break;
    }

    // Execute tool calls.
    // Workflow tools (sleep_for, sleep_until, wait_for_event) may throw
    // SuspendTask — they must NOT be wrapped in ctx.step() because the
    // step would interfere with the SDK's internal checkpoint management.
    // Non-suspending tools are wrapped in ctx.step() for checkpointing.
    const toolBlocks = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    log?.info({ turn: turn + 1, tools: toolBlocks.map((b) => b.name) }, "executing tools");
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tb of toolBlocks) {
      let result: string;
      if (deps.registry.isSuspending(tb.name)) {
        // Call directly — SuspendTask propagates up to the Absurd worker
        result = await deps.registry.execute(tb.name, tb.input as Record<string, unknown>);
      } else {
        result = await ctx.step(`tool-${turn}-${tb.id}`, () =>
          deps.registry.execute(tb.name, tb.input as Record<string, unknown>),
        );
      }
      results.push({ type: "tool_result", tool_use_id: tb.id, content: result as string });
    }
    messages.push({ role: "user", content: results });

    if (turn === MAX_TURNS - 1) {
      log?.warn({ maxTurns: MAX_TURNS }, "max turns exhausted");
    }
  }

  // Persist messages — store the user message, all tool interactions, and
  // the final assistant reply. This ensures the next turn's conversation
  // history includes what tools were used and their results.
  await ctx.step("persist", async () => {
    await appendMessage(deps.pool, { recipientId, role: "user", content: userMessage });
    const loopMessages = messages.slice(preLoopLength);
    for (const msg of deconstructMessages(recipientId, loopMessages)) {
      await appendMessage(deps.pool, msg);
    }
    return true;
  });

  return stripInternalTags(reply);
}
