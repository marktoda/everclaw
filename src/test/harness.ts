import * as fs from "node:fs";
import * as path from "node:path";
import { Absurd } from "absurd-sdk";
import * as pg from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

export interface TestDb {
  pool: pg.Pool;
  absurd: Absurd;
  container: StartedTestContainer;
  teardown: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  const container = await new GenericContainer("postgres:17")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: "test",
    password: "test",
    database: "test",
  });

  // Run all SQL migrations in sorted order
  const sqlDir = path.join(import.meta.dirname, "..", "..", "sql");
  const files = fs
    .readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(sqlDir, file), "utf-8"));
  }

  // Create Absurd instance and queue
  const absurd = new Absurd({ db: pool, queueName: "test" });
  await absurd.createQueue();

  const teardown = async () => {
    await absurd.close();
    await pool.end();
    await container.stop();
  };

  return { pool, absurd, container, teardown };
}

/** Poll until an async condition is met. */
export async function waitForAsync(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const interval = 250;
  const iterations = Math.ceil(timeoutMs / interval);
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (await condition()) return;
  }
  throw new Error("waitForAsync timed out");
}

/** Poll until a sync condition is met. */
export async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const interval = 250;
  const iterations = Math.ceil(timeoutMs / interval);
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (condition()) return;
  }
  throw new Error("waitFor timed out");
}
