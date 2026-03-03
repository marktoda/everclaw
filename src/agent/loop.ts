// src/agent/loop.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import pino from "pino";
import type { ToolDef } from "./tools/index.ts";
import type { Logger } from "../logger.ts";
import { getRecentMessages, appendMessage } from "../memory/history.ts";
import { listSkills } from "../skills/manager.ts";
import { listTools } from "../scripts/runner.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { stripInternalTags } from "./output.ts";
import * as fs from "fs/promises";
import * as path from "path";

const MAX_TURNS = 20;

export interface AgentDeps {
  anthropic: Anthropic;
  pool: Pool;
  model: string;
  notesDir: string;
  skillsDir: string;
  toolsDir: string;
  maxHistory: number;
  tools: ToolDef[];
  executeTool: (name: string, input: Record<string, any>) => Promise<string>;
  isSuspending?: (name: string) => boolean;
  log?: Logger;
  /** Called with filtered text as it becomes available. */
  onText?: (text: string) => void;
}

/** Read all files in a directory and concatenate their contents. */
async function readAllNotes(notesDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(notesDir);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(notesDir, entry), "utf-8");
    if (content.trim()) parts.push(`### ${entry}\n\n${content}`);
  }
  return parts.join("\n\n");
}

/**
 * Sanitize reconstructed messages to ensure valid Anthropic API structure.
 * Validates tool_use/tool_result pairing throughout the entire array:
 * - Drops orphaned tool_result without a preceding matching tool_use
 * - Drops assistant tool_use without a following tool_result with matching IDs
 * - Merges consecutive same-role messages to maintain alternation
 */
export function sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Pass 1: validate tool_use/tool_result pairs, drop invalid ones
  const cleaned: Anthropic.MessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // Skip orphaned tool_result (not preceded by a matching tool_use)
    if (msg.role === "user" && Array.isArray(msg.content) &&
        (msg.content as any[])[0]?.type === "tool_result") {
      i++;
      continue;
    }

    // Validate assistant message with tool_use blocks
    if (msg.role === "assistant" && Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === "tool_use")) {
      const next = messages[i + 1];
      if (next?.role === "user" && Array.isArray(next.content) &&
          (next.content as any[])[0]?.type === "tool_result") {
        const useIds = new Set(
          (msg.content as any[])
            .filter((b: any) => b.type === "tool_use")
            .map((b: any) => b.id),
        );
        const resultIds = new Set(
          (next.content as any[]).map((b: any) => b.tool_use_id),
        );
        // Valid pair: every use has a result and vice versa
        if (useIds.size > 0 &&
            [...resultIds].every(id => useIds.has(id)) &&
            [...useIds].every(id => resultIds.has(id))) {
          cleaned.push(msg, next);
          i += 2;
          continue;
        }
      }
      // Invalid or missing tool_result — drop the assistant tool_use message
      i++;
      continue;
    }

    cleaned.push(msg);
    i++;
  }

  // Pass 2: merge consecutive same-role messages to fix alternation
  // (dropping tool pairs can leave adjacent user or assistant messages)
  const result: Anthropic.MessageParam[] = [];
  for (const msg of cleaned) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      const prev = result[result.length - 1];
      const prevText = typeof prev.content === "string" ? prev.content : "";
      const curText = typeof msg.content === "string" ? msg.content : "";
      result[result.length - 1] = {
        role: msg.role,
        content: [prevText, curText].filter(Boolean).join("\n\n"),
      };
    } else {
      result.push(msg);
    }
  }

  return result;
}

export async function runAgentLoop(
  ctx: TaskContext,
  chatId: number,
  userMessage: string,
  deps: AgentDeps,
): Promise<string> {
  const log = deps.log ?? pino({ level: "silent" });

  // Load context (checkpointed)
  const context = await ctx.step("load-context", async () => {
    const [notes, history, skills, tools] = await Promise.all([
      readAllNotes(deps.notesDir),
      getRecentMessages(deps.pool, chatId, deps.maxHistory),
      listSkills(deps.skillsDir),
      listTools(deps.toolsDir),
    ]);
    return { notes, history, skills, tools };
  });

  log.debug("context loaded");

  const systemPrompt = buildSystemPrompt({
    notes: context.notes as string,
    skills: (context.skills as any[]).map(s => ({ name: s.name, description: s.description, schedule: s.schedule })),
    tools: (context.tools as any[]).map(t => ({ name: t.name })),
  });

  // Build messages array — reconstruct full Anthropic content blocks from
  // stored history so Claude sees tool_use / tool_result context.
  const messages: Anthropic.MessageParam[] = [];
  for (const msg of context.history as any[]) {
    if (msg.role === "assistant" && msg.toolUse?.length > 0 && msg.toolUse[0].id) {
      // Reconstruct assistant message with tool_use content blocks
      const content: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[] = [];
      if (msg.content && msg.content !== "(tool use only)") {
        content.push({ type: "text", text: msg.content, citations: null } as Anthropic.TextBlock);
      }
      for (const tu of msg.toolUse) {
        content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "tool" && msg.toolUse?.length > 0) {
      // Reconstruct tool results as user message with tool_result blocks
      messages.push({
        role: "user",
        content: msg.toolUse.map((r: any) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      });
    } else if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Sanitize: validate tool_use/tool_result pairing throughout the array.
  // The old cleanup only handled orphans at the start of the window.
  // This handles mismatched IDs mid-array from concurrent persists,
  // partial writes, and history window clipping.
  {
    const sanitized = sanitizeMessages(messages);
    messages.length = 0;
    messages.push(...sanitized);
  }

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
        tools: deps.tools,
      });
      return { content: r.content, stopReason: r.stop_reason };
    });

    const content = resp.content as Anthropic.ContentBlock[];
    messages.push({ role: "assistant", content });

    // Extract text blocks for reply and sending
    const textBlocks = content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );

    // Send text to the caller — wrapped in ctx.step() so that text is NOT
    // re-sent when the task resumes after a suspending tool (sleep_for, etc.).
    // On replay, ctx.step returns the cached result without executing the fn.
    if (textBlocks.length > 0 && deps.onText) {
      await ctx.step(`send-text-${turn}`, async () => {
        for (const block of textBlocks) {
          const filtered = stripInternalTags(block.text);
          if (filtered) deps.onText!(filtered);
        }
        return true;
      });
    }

    if ((resp.stopReason as string) !== "tool_use") {
      reply = textBlocks.map(b => b.text).join("\n");
      log.info({ turns: turn + 1 }, "agent loop complete");
      break;
    }

    // Execute tool calls.
    // Workflow tools (sleep_for, sleep_until, wait_for_event) may throw
    // SuspendTask — they must NOT be wrapped in ctx.step() because the
    // step would interfere with the SDK's internal checkpoint management.
    // Non-suspending tools are wrapped in ctx.step() for checkpointing.
    const toolBlocks = content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    log.info({ turn: turn + 1, tools: toolBlocks.map(b => b.name) }, "executing tools");
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tb of toolBlocks) {
      let result: string;
      if (deps.isSuspending?.(tb.name)) {
        // Call directly — SuspendTask propagates up to the Absurd worker
        result = await deps.executeTool(tb.name, tb.input as Record<string, any>);
      } else {
        result = await ctx.step(`tool-${turn}-${tb.name}`, () =>
          deps.executeTool(tb.name, tb.input as Record<string, any>),
        );
      }
      results.push({ type: "tool_result", tool_use_id: tb.id, content: result as string });
    }
    messages.push({ role: "user", content: results });

    if (turn === MAX_TURNS - 1) {
      log.warn({ maxTurns: MAX_TURNS }, "max turns exhausted");
    }
  }

  // Persist messages — store the user message, all tool interactions, and
  // the final assistant reply. This ensures the next turn's conversation
  // history includes what tools were used and their results.
  await ctx.step("persist", async () => {
    await appendMessage(deps.pool, { chatId, role: "user", content: userMessage });
    // Walk the messages array to find assistant + tool_result pairs we added
    // during the loop (skip the sanitized history and the user message).
    const loopMessages = messages.slice(preLoopLength);
    for (const msg of loopMessages) {
      if (msg.role === "assistant") {
        // Extract text and tool_use from content blocks
        const blocks = msg.content as Anthropic.ContentBlock[];
        const text = blocks
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map(b => b.text)
          .join("\n");
        const toolUse = blocks
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map(b => ({ id: b.id, name: b.name, input: b.input }));
        await appendMessage(deps.pool, {
          chatId,
          role: "assistant",
          content: text || "(tool use only)",
          toolUse: toolUse.length > 0 ? toolUse : undefined,
        });
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        // Tool results — store structured data for history reconstruction
        const results = msg.content as Anthropic.ToolResultBlockParam[];
        const toolResults = results
          .map(r => `[${r.tool_use_id}]: ${r.content}`)
          .join("\n");
        await appendMessage(deps.pool, {
          chatId,
          role: "tool",
          content: toolResults,
          toolUse: results.map(r => ({ tool_use_id: r.tool_use_id, content: r.content })),
        });
      }
    }
    return true;
  });

  return stripInternalTags(reply);
}
