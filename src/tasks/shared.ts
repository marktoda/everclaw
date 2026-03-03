// src/tasks/shared.ts
import type { Absurd, TaskContext } from "absurd-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { AgentDeps } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";

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
  opts?: { maxHistory?: number; silent?: boolean },
): AgentDeps {
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
    notesDir: deps.config.notesDir,
    skillsDir: deps.config.skillsDir,
    toolsDir: deps.config.toolsDir,
    maxHistory: opts?.maxHistory ?? deps.config.maxHistoryMessages,
    registry,
    log: deps.log,
    onText: opts?.silent ? undefined : (text) => {
      deps.bot.api.sendMessage(chatId, text).catch(() => {});
    },
  };
}
