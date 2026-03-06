import Anthropic from "@anthropic-ai/sdk";
import { Absurd } from "absurd-sdk";
import * as pg from "pg";
import { ChannelRegistry, createAdapter } from "./channels/index.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { createMcpManager } from "./servers/manager.ts";
import { syncSchedules } from "./skills/manager.ts";
import { registerExecuteSkill } from "./tasks/execute-skill.ts";
import { registerHandleMessage } from "./tasks/handle-message.ts";
import { registerSendMessage } from "./tasks/send-message.ts";
import { registerWorkflow } from "./tasks/workflow.ts";

async function main() {
  const config = loadConfig();
  const startedAt = new Date();

  const pool = new pg.Pool({ connectionString: config.worker.databaseUrl });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 120_000 });
  const absurd = new Absurd({ db: pool, queueName: config.worker.queueName });

  await absurd.createQueue();

  const mcpManager = createMcpManager();
  await mcpManager.start(config.dirs.servers, config.serverEnv);

  const channelRegistry = new ChannelRegistry();
  for (const ch of config.channels) {
    try {
      channelRegistry.register(
        await createAdapter(ch.type, ch.token, {
          openaiApiKey: config.openaiApiKey,
          gmailLabel: config.gmailLabel,
        }),
      );
    } catch (err) {
      logger.error({ err, channel: ch.type }, "failed to create channel adapter — skipping");
    }
  }

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
  await syncSchedules(absurd, config.dirs.skills);

  const worker = await absurd.startWorker({
    concurrency: config.worker.concurrency,
    claimTimeout: config.worker.claimTimeout,
    onError: (err) => logger.error({ err }, "worker error"),
  });

  logger.info({ queue: config.worker.queueName }, "everclaw started");

  await channelRegistry.startAll(async (msg) => {
    try {
      // Allowlist check
      if (config.allowedChatIds.size === 0) {
        // Discovery mode: reply with chat ID instructions, don't run agent
        logger.info({ chatId: msg.chatId }, "discovery mode — replying with chat ID");
        await channelRegistry.sendMessage(
          msg.chatId,
          `Your chat ID is: ${msg.chatId}\n\nAdd this to your .env file:\nALLOWED_CHAT_IDS=${msg.chatId}\n\nThen restart the bot.`,
        );
        return;
      }
      if (!config.allowedChatIds.has(msg.chatId)) {
        logger.warn(
          { chatId: msg.chatId },
          "unauthorized message — replying with chat ID",
        );
        await channelRegistry.sendMessage(
          msg.chatId,
          `Your chat ID is: ${msg.chatId}\n\nAdd it to ALLOWED_CHAT_IDS in your .env file, then restart the bot.`,
        );
        return;
      }

      logger.info({ chatId: msg.chatId }, "message received");
      await absurd.spawn("handle-message", {
        chatId: msg.chatId,
        text: msg.text,
      });
    } catch (err) {
      logger.error({ err, chatId: msg.chatId }, "failed to handle inbound message");
    }
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
