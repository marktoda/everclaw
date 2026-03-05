// src/tasks/shared.ts

import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Absurd, TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { AgentDeps } from "../agent/loop.ts";
import { createToolRegistry } from "../agent/tools/index.ts";
import type { ChannelRegistry } from "../channels/index.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { McpManager } from "../servers/manager.ts";

/** Shorter history window for background tasks (skills, workflows). */
export const BACKGROUND_MAX_HISTORY = 10;

/** Path (relative to notes dir) where the default recipient ID is persisted. */
export function defaultRecipientFile(notesDir: string): string {
  return path.join(notesDir, "temp", "default-recipient.json");
}

export interface TaskDeps {
  anthropic: Anthropic;
  pool: Pool;
  channels: ChannelRegistry;
  config: Config;
  startedAt: Date;
  log?: Logger;
  mcp?: McpManager;
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

  const registry = createToolRegistry(
    {
      absurd,
      pool: deps.pool,
      ctx,
      queueName: deps.config.worker.queueName,
      recipientId,
      dirs: deps.config.dirs,
      scriptTimeout: deps.config.scriptTimeout,
      scriptEnv: deps.config.scriptEnv,
      startedAt: deps.startedAt,
      searchApiKey: deps.config.braveSearchApiKey,
      reloadMcp: deps.mcp ? () => deps.mcp!.reload() : undefined,
      allowedChatIds: deps.config.allowedChatIds,
    },
    deps.mcp,
  );

  return {
    anthropic: deps.anthropic,
    pool: deps.pool,
    model: deps.config.agent.model,
    dirs: {
      notes: deps.config.dirs.notes,
      skills: deps.config.dirs.skills,
      scripts: deps.config.dirs.scripts,
    },
    maxHistory: opts?.maxHistory ?? deps.config.agent.maxHistoryMessages,
    registry,
    log,
    mcpSummaries: deps.mcp?.serverSummaries(),
    extraDirs: deps.config.dirs.extra,
    onText: opts?.silent
      ? undefined
      : async (text) => {
          await deps.channels.sendMessage(recipientId, text);
        },
  };
}
