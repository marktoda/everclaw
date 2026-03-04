import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/*  Server config                                                      */
/* ------------------------------------------------------------------ */

export interface ServerConfig {
  name: string;        // filename minus .json
  description?: string;
  command: string;     // required
  args?: string[];
}

/**
 * Read `servers/*.json` files and parse them into ServerConfig objects.
 * Returns `[]` when the directory does not exist.
 * Skips non-.json files, invalid JSON, and files missing `command`.
 */
export async function listServerConfigs(
  serversDir: string,
): Promise<ServerConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(serversDir);
  } catch {
    return [];
  }

  const configs: ServerConfig[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    let raw: string;
    try {
      raw = await readFile(path.join(serversDir, entry), "utf-8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).command !== "string"
    ) {
      continue;
    }

    const obj = parsed as Record<string, unknown>;
    const name = entry.replace(/\.json$/, "");

    configs.push({
      name,
      command: obj.command as string,
      ...(typeof obj.description === "string"
        ? { description: obj.description }
        : {}),
      ...(Array.isArray(obj.args) ? { args: obj.args as string[] } : {}),
    });
  }

  return configs;
}
