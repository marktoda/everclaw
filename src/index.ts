import * as pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { Absurd } from "absurd-sdk";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { registerHandleMessage } from "./tasks/handle-message.js";
import { registerExecuteSkill } from "./tasks/execute-skill.js";
import { registerSendMessage } from "./tasks/send-message.js";
import { registerWorkflow } from "./tasks/workflow.js";
import { syncSchedules } from "./skills/manager.js";
import { getState, setState } from "./memory/state.js";

async function main() {
  const config = loadConfig();
  const startedAt = new Date();

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const absurd = new Absurd({ db: pool, queueName: config.queueName });

  await absurd.createQueue();

  const bot = createBot(config.telegramToken, absurd);

  // Persist defaultChatId via state store. On startup, read it.
  // On first message, write it.
  let defaultChatId = (await getState(pool, "system", "defaultChatId")) ?? 0;
  bot.on("message:text", async (ctx) => {
    if (defaultChatId === 0) {
      defaultChatId = ctx.chat.id;
      await setState(pool, "system", "defaultChatId", defaultChatId);
    }
  });

  const taskDeps = { anthropic, pool, bot, config, startedAt };
  registerHandleMessage(absurd, taskDeps);
  registerExecuteSkill(absurd, taskDeps);
  registerSendMessage(absurd, bot);
  registerWorkflow(absurd, taskDeps);

  // Sync skill schedules on startup
  await syncSchedules(absurd, config.skillsDir, defaultChatId);

  const worker = await absurd.startWorker({
    concurrency: config.workerConcurrency,
    claimTimeout: config.claimTimeout,
    onError: (err) => console.error("[worker]", err.message),
  });

  console.log(`absurd-assistant started (queue=${config.queueName})`);

  bot.start({ onStart: () => console.log("Telegram bot connected") });

  const shutdown = async () => {
    console.log("Shutting down...");
    bot.stop();
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
