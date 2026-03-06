// src/tasks/shared.ts

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
  chatId: string,
  opts?: { maxHistory?: number; interactive?: boolean; taskName?: string },
): AgentDeps {
  const log = deps.log?.child({ task: opts?.taskName, chatId });

  const registry = createToolRegistry(
    {
      absurd,
      pool: deps.pool,
      ctx,
      queueName: deps.config.worker.queueName,
      chatId,
      dirs: deps.config.dirs,
      scriptTimeout: deps.config.scriptTimeout,
      scriptEnv: deps.config.scriptEnv,
      startedAt: deps.startedAt,
      searchApiKey: deps.config.braveSearchApiKey,
      reloadMcp: deps.mcp ? () => deps.mcp!.reload() : undefined,
      allowedChatIds: deps.config.allowedChatIds,
      channels: deps.channels,
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
    onText: opts?.interactive
      ? async (text) => {
          await deps.channels.sendMessage(chatId, text);
        }
      : undefined,
  };
}
