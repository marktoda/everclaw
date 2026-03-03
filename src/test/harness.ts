import { GenericContainer, type StartedTestContainer } from "testcontainers";
import * as pg from "pg";
import * as fs from "fs";
import * as path from "path";
import { Absurd } from "absurd-sdk";

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
    .start();

  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: "test",
    password: "test",
    database: "test",
  });

  // Run SQL migrations
  const sqlDir = path.join(import.meta.dirname, "..", "..", "sql");
  const migration1 = fs.readFileSync(path.join(sqlDir, "001-absurd.sql"), "utf-8");
  const migration2 = fs.readFileSync(path.join(sqlDir, "002-assistant.sql"), "utf-8");
  await pool.query(migration1);
  await pool.query(migration2);

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
