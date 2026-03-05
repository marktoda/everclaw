import Anthropic from "@anthropic-ai/sdk";
import { Absurd } from "absurd-sdk";
import * as pg from "pg";
import { ChannelRegistry, createAdapter } from "./channels/index.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { getState, setState } from "./memory/state.ts";
import { createMcpManager } from "./servers/manager.ts";
import { syncSchedules } from "./skills/manager.ts";
import { registerExecuteSkill } from "./tasks/execute-skill.ts";
import { registerHandleMessage } from "./tasks/handle-message.ts";
import { registerSendMessage } from "./tasks/send-message.ts";
import { registerWorkflow } from "./tasks/workflow.ts";

async function main() {
  const config = loadConfig();
  const startedAt = new Date();

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const absurd = new Absurd({ db: pool, queueName: config.queueName });

  await absurd.createQueue();

  const mcpManager = createMcpManager();
  await mcpManager.start(config.serversDir, config.serverEnv);

  const channelRegistry = new ChannelRegistry();
  for (const ch of config.channels) {
    channelRegistry.register(
      createAdapter(ch.type, ch.token, { openaiApiKey: config.openaiApiKey }),
    );
  }

  // Persist defaultRecipientId via state store
  let defaultRecipientId = ((await getState(pool, "system", "defaultRecipientId")) ?? "") as string;

  const taskDeps = {
    anthropic,
    pool,
    channels: channelRegistry,
    config,
    startedAt,
    log: logger,
    mcp: mcpManager,
  };
  registerHandleMessage(absurd, taskDeps);
  registerExecuteSkill(absurd, taskDeps);
  registerSendMessage(absurd, channelRegistry);
  registerWorkflow(absurd, taskDeps);

  // Sync skill schedules on startup
  await syncSchedules(absurd, config.skillsDir);

  const worker = await absurd.startWorker({
    concurrency: config.workerConcurrency,
    claimTimeout: config.claimTimeout,
    onError: (err) => logger.error({ err }, "worker error"),
  });

  logger.info({ queue: config.queueName }, "everclaw started");

  await channelRegistry.startAll(async (msg) => {
    // Allowlist check
    if (config.allowedChatIds.size === 0) {
      // Discovery mode: reply with chat ID instructions, don't run agent
      logger.info({ recipientId: msg.recipientId }, "discovery mode — replying with chat ID");
      await channelRegistry.sendMessage(
        msg.recipientId,
        `Your chat ID is: ${msg.recipientId}\n\nAdd this to your .env file:\nALLOWED_CHAT_IDS=${msg.recipientId}\n\nThen restart the bot.`,
      );
      return;
    }
    if (!config.allowedChatIds.has(msg.recipientId)) {
      logger.warn({ recipientId: msg.recipientId }, "unauthorized message — ignored");
      return;
    }

    if (!defaultRecipientId) {
      defaultRecipientId = msg.recipientId;
      await setState(pool, "system", "defaultRecipientId", msg.recipientId);
    }
    logger.info({ recipientId: msg.recipientId }, "message received");
    await absurd.spawn("handle-message", {
      recipientId: msg.recipientId,
      text: msg.text,
    });
  });

  const shutdown = async () => {
    logger.info("shutting down");
    await channelRegistry.stopAll();
    await mcpManager.stop();
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
