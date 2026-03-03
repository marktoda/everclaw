import * as pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { Absurd } from "absurd-sdk";
import { loadConfig } from "./config.ts";
import { createBot } from "./bot.ts";
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

  // Persist defaultChatId via state store
  let defaultChatId = ((await getState(pool, "system", "defaultChatId")) ?? 0) as number;
  const bot = createBot(config.telegramToken, absurd, {
    onFirstMessage: defaultChatId === 0
      ? async (chatId) => {
          defaultChatId = chatId;
          await setState(pool, "system", "defaultChatId", chatId);
        }
      : undefined,
  });

  const taskDeps = { anthropic, pool, bot, config, startedAt, log: logger };
  registerHandleMessage(absurd, taskDeps);
  registerExecuteSkill(absurd, taskDeps);
  registerSendMessage(absurd, bot);
  registerWorkflow(absurd, taskDeps);

  // Sync skill schedules on startup
  await syncSchedules(absurd, config.skillsDir, defaultChatId);

  const worker = await absurd.startWorker({
    concurrency: config.workerConcurrency,
    claimTimeout: config.claimTimeout,
    onError: (err) => logger.error({ err }, "worker error"),
  });

  logger.info({ queue: config.queueName }, "everclaw started");

  bot.start({ onStart: () => logger.info("telegram bot connected") });

  const shutdown = async () => {
    logger.info("shutting down");
    bot.stop();
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
