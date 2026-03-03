// src/tasks/shared.ts

import type Anthropic from "@anthropic-ai/sdk";
import type { Absurd, TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { AgentDeps } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";
import type { ChannelRegistry } from "../channels/index.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";

/** Shorter history window for background tasks (skills, workflows). */
export const BACKGROUND_MAX_HISTORY = 10;

export interface TaskDeps {
  anthropic: Anthropic;
  pool: Pool;
  channels: ChannelRegistry;
  config: Config;
  startedAt: Date;
  log?: Logger;
}

/** Build AgentDeps from TaskDeps for a specific task invocation. */
export function buildAgentDeps(
  deps: TaskDeps,
  absurd: Absurd,
  ctx: TaskContext,
  recipientId: string,
  opts?: { maxHistory?: number; silent?: boolean; taskName?: string },
): AgentDeps {
  const log = deps.log?.child({ task: opts?.taskName, recipientId });

  const registry = createToolRegistry({
    absurd,
    pool: deps.pool,
    ctx,
    queueName: deps.config.queueName,
    recipientId,
    notesDir: deps.config.notesDir,
    skillsDir: deps.config.skillsDir,
    scriptsDir: deps.config.scriptsDir,
    scriptTimeout: deps.config.scriptTimeout,
    scriptEnv: deps.config.scriptEnv,
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
      scripts: deps.config.scriptsDir,
    },
    maxHistory: opts?.maxHistory ?? deps.config.maxHistoryMessages,
    registry,
    log,
    onText: opts?.silent
      ? undefined
      : (text) => {
          deps.channels.sendMessage(recipientId, text).catch((err) => {
            log?.warn({ err, recipientId }, "failed to send message");
          });
        },
  };
}
