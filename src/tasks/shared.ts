// src/tasks/shared.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { AgentDeps } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";

const TG_MAX = 4096;

/** Split text into chunks that fit within Telegram's message limit. */
function splitForTelegram(text: string): string[] {
  if (text.length <= TG_MAX) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_MAX) {
    // Try to split at a double-newline (paragraph boundary) within the limit
    let splitAt = remaining.lastIndexOf("\n\n", TG_MAX);
    if (splitAt <= 0) {
      // Fall back to single newline
      splitAt = remaining.lastIndexOf("\n", TG_MAX);
    }
    if (splitAt <= 0) {
      // Last resort: hard split
      splitAt = TG_MAX;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export interface TaskDeps {
  anthropic: Anthropic;
  pool: Pool;
  bot: Bot;
  config: Config;
  startedAt: Date;
  log?: Logger;
}

/** Build AgentDeps from TaskDeps for a specific task invocation. */
export function buildAgentDeps(
  deps: TaskDeps,
  absurd: Absurd,
  ctx: TaskContext,
  chatId: number,
  opts?: { maxHistory?: number; silent?: boolean; taskName?: string },
): AgentDeps {
  const log = deps.log?.child({ task: opts?.taskName, chatId });

  const registry = createToolRegistry({
    absurd,
    pool: deps.pool,
    ctx,
    queueName: deps.config.queueName,
    chatId,
    notesDir: deps.config.notesDir,
    skillsDir: deps.config.skillsDir,
    toolsDir: deps.config.toolsDir,
    scriptTimeout: deps.config.scriptTimeout,
    startedAt: deps.startedAt,
    searchApiKey: deps.config.braveSearchApiKey,
  });

  return {
    anthropic: deps.anthropic,
    pool: deps.pool,
    model: deps.config.model,
    dirs: {
      notes: deps.config.notesDir,
      skills: deps.config.skillsDir,
      tools: deps.config.toolsDir,
    },
    maxHistory: opts?.maxHistory ?? deps.config.maxHistoryMessages,
    registry,
    log,
    onText: opts?.silent ? undefined : (text) => {
      // Telegram has a 4096-char limit per message; split at paragraph boundaries
      for (const chunk of splitForTelegram(text)) {
        deps.bot.api.sendMessage(chatId, chunk).catch(() => {});
      }
    },
  };
}
