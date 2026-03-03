import * as pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { Absurd } from "absurd-sdk";
import { loadConfig } from "./config.ts";
import { ChannelRegistry, TelegramAdapter } from "./channels/index.ts";
import { registerHandleMessage } from "./tasks/handle-message.ts";
import { registerExecuteSkill } from "./tasks/execute-skill.ts";
import { registerSendMessage } from "./tasks/send-message.ts";
import { registerWorkflow } from "./tasks/workflow.ts";
import { syncSchedules } from "./skills/manager.ts";
import { getState, setState } from "./memory/state.ts";
import { logger } from "./logger.ts";

async function main() {
  const config = loadConfig();
  const startedAt = new Date();

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const absurd = new Absurd({ db: pool, queueName: config.queueName });

  await absurd.createQueue();

  const channelRegistry = new ChannelRegistry();
  for (const ch of config.channels) {
    if (ch.type === "telegram") {
      channelRegistry.register(new TelegramAdapter(ch.token));
    }
  }

  // Persist defaultRecipientId via state store
  let defaultRecipientId = ((await getState(pool, "system", "defaultRecipientId")) ?? "") as string;

  const taskDeps = { anthropic, pool, channels: channelRegistry, config, startedAt, log: logger };
  registerHandleMessage(absurd, taskDeps);
  registerExecuteSkill(absurd, taskDeps);
  registerSendMessage(absurd, channelRegistry);
  registerWorkflow(absurd, taskDeps);

  // Sync skill schedules on startup
  await syncSchedules(absurd, config.skillsDir, defaultRecipientId);

  const worker = await absurd.startWorker({
    concurrency: config.workerConcurrency,
    claimTimeout: config.claimTimeout,
    onError: (err) => logger.error({ err }, "worker error"),
  });

  logger.info({ queue: config.queueName }, "everclaw started");

  await channelRegistry.startAll(async (msg) => {
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
