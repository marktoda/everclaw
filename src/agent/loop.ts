// src/agent/loop.ts
import Anthropic from "@anthropic-ai/sdk";
import type { TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { ToolDef } from "./tools.js";
import { getRecentMessages, appendMessage } from "../memory/history.js";
import { listSkills } from "../skills/manager.js";
import { listTools } from "../scripts/runner.js";
import { buildSystemPrompt } from "./prompt.js";
import { stripInternalTags } from "./output.js";
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

export async function runAgentLoop(
  ctx: TaskContext,
  chatId: number,
  userMessage: string,
  deps: AgentDeps,
): Promise<string> {
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

  const systemPrompt = buildSystemPrompt({
    notes: context.notes as string,
    skills: (context.skills as any[]).map(s => ({ name: s.name, description: s.description, schedule: s.schedule })),
    tools: (context.tools as any[]).map(t => ({ name: t.name })),
  });

  // Build messages array
  const messages: Anthropic.MessageParam[] = [];
  for (const msg of context.history as any[]) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: userMessage });

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

    // Send text blocks to the caller per-turn
    const textBlocks = content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    for (const block of textBlocks) {
      const filtered = stripInternalTags(block.text);
      if (filtered && deps.onText) deps.onText(filtered);
    }

    if ((resp.stopReason as string) !== "tool_use") {
      reply = textBlocks.map(b => b.text).join("\n");
      break;
    }

    // Execute tool calls.
    // Workflow tools (sleep_for, sleep_until, wait_for_event) may throw
    // SuspendTask — they must NOT be wrapped in ctx.step() because the
    // step would interfere with the SDK's internal checkpoint management.
    // Non-suspending tools are wrapped in ctx.step() for checkpointing.
    const SUSPENDING_TOOLS = new Set(["sleep_for", "sleep_until", "wait_for_event"]);
    const toolBlocks = content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tb of toolBlocks) {
      let result: string;
      if (SUSPENDING_TOOLS.has(tb.name)) {
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
  }

  // Persist messages — store the user message, all tool interactions, and
  // the final assistant reply. This ensures the next turn's conversation
  // history includes what tools were used and their results.
  await ctx.step("persist", async () => {
    await appendMessage(deps.pool, { chatId, role: "user", content: userMessage });
    // Walk the messages array to find assistant + tool_result pairs we added
    // during the loop (skip the initial history and the user message we added).
    const loopMessages = messages.slice((context.history as any[]).length + 1);
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
          .map(b => ({ name: b.name, input: b.input }));
        await appendMessage(deps.pool, {
          chatId,
          role: "assistant",
          content: text || "(tool use only)",
          toolUse: toolUse.length > 0 ? toolUse : undefined,
        });
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        // Tool results — store as a single tool message with all results
        const toolResults = (msg.content as Anthropic.ToolResultBlockParam[])
          .map(r => `[${r.tool_use_id}]: ${r.content}`)
          .join("\n");
        await appendMessage(deps.pool, {
          chatId,
          role: "tool",
          content: toolResults,
        });
      }
    }
    return true;
  });

  return stripInternalTags(reply);
}
