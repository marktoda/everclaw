// src/memory/state.ts
import type { Pool } from "pg";

export async function getState(pool: Pool, namespace: string, key: string): Promise<unknown> {
  const r = await pool.query(
    `SELECT value FROM assistant.state WHERE namespace = $1 AND key = $2`,
    [namespace, key],
  );
  return r.rows.length === 0 ? null : r.rows[0].value;
}

export async function setState(pool: Pool, namespace: string, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO assistant.state (namespace, key, value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (namespace, key) DO UPDATE SET value = $3, updated_at = now()`,
    [namespace, key, JSON.stringify(value)],
  );
}

export async function deleteState(pool: Pool, namespace: string, key: string): Promise<void> {
  await pool.query(
    `DELETE FROM assistant.state WHERE namespace = $1 AND key = $2`,
    [namespace, key],
  );
}

export async function listState(pool: Pool, namespace: string): Promise<Array<{ key: string; value: unknown }>> {
  const r = await pool.query(
    `SELECT key, value FROM assistant.state WHERE namespace = $1 ORDER BY key`,
    [namespace],
  );
  return r.rows;
}
