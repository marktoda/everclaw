import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "../logger.ts";
import type { ToolDef } from "../agent/tools/types.ts";

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
    const name = path.basename(entry, ".json");

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

/* ------------------------------------------------------------------ */
/*  McpManager                                                         */
/* ------------------------------------------------------------------ */

export interface ServerSummary {
  name: string;
  description?: string;
}

export interface McpManager {
  start(serversDir: string, env: Record<string, string>): Promise<void>;
  reload(): Promise<void>;
  definitions(): ToolDef[];
  execute(toolName: string, input: Record<string, unknown>): Promise<string>;
  serverSummaries(): ServerSummary[];
  stop(): Promise<void>;
}

interface ConnectedServer {
  config: ServerConfig;
  client: Client;
}

/**
 * Factory that creates an McpManager instance.
 *
 * The manager connects to MCP servers described by JSON config files,
 * discovers their tools (namespaced as `mcp_<server>_<tool>`), and
 * routes execute calls to the appropriate server.
 */
export function createMcpManager(): McpManager {
  /** server name -> ConnectedServer */
  let servers = new Map<string, ConnectedServer>();
  /** namespaced tool name -> { server name, original tool name } */
  let toolRoute = new Map<string, { serverName: string; toolName: string }>();
  /** All discovered tool definitions (Anthropic format) */
  let toolDefs: ToolDef[] = [];
  /** Stored args from last start() call, used by reload() */
  let storedServersDir: string | undefined;
  let storedEnv: Record<string, string> | undefined;

  function clearState(): void {
    servers = new Map();
    toolRoute = new Map();
    toolDefs = [];
  }

  async function start(
    serversDir: string,
    env: Record<string, string>,
  ): Promise<void> {
    storedServersDir = serversDir;
    storedEnv = env;

    // Idempotent: stop existing connections first (stop() calls clearState())
    await stop();

    const configs = await listServerConfigs(serversDir);

    for (const config of configs) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...process.env as Record<string, string>, ...env },
        });

        const client = new Client({
          name: "everclaw",
          version: "1.0.0",
        });

        await client.connect(transport);

        const { tools } = await client.listTools();

        const connected: ConnectedServer = { config, client };
        servers.set(config.name, connected);

        for (const tool of tools) {
          const namespacedName = `mcp_${config.name}_${tool.name}`;
          toolRoute.set(namespacedName, {
            serverName: config.name,
            toolName: tool.name,
          });
          toolDefs.push({
            name: namespacedName,
            description: tool.description ?? "",
            input_schema: tool.inputSchema as ToolDef["input_schema"],
          });
        }

        logger.info(
          { server: config.name, tools: tools.length },
          "MCP server connected",
        );
      } catch (err) {
        logger.warn(
          { server: config.name, err },
          "Failed to connect MCP server, skipping",
        );
      }
    }
  }

  async function reload(): Promise<void> {
    if (!storedServersDir || !storedEnv) {
      throw new Error("McpManager.reload() called before start()");
    }
    await start(storedServersDir, storedEnv);
  }

  function definitions(): ToolDef[] {
    return toolDefs;
  }

  async function execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const route = toolRoute.get(toolName);
    if (!route) {
      return `Error: unknown MCP tool "${toolName}"`;
    }

    const server = servers.get(route.serverName);
    if (!server) {
      return `Error: MCP server "${route.serverName}" not connected`;
    }

    try {
      const result = await server.client.callTool({
        name: route.toolName,
        arguments: input,
      });

      // Extract text from content blocks
      const content = (result as { content?: unknown[] }).content;
      if (Array.isArray(content)) {
        return content
          .filter(
            (block): block is { type: "text"; text: string } =>
              typeof block === "object" &&
              block !== null &&
              (block as Record<string, unknown>).type === "text" &&
              typeof (block as Record<string, unknown>).text === "string",
          )
          .map((block) => block.text)
          .join("\n");
      }

      return String(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error from MCP server "${route.serverName}": ${msg}`;
    }
  }

  function serverSummaries(): ServerSummary[] {
    return Array.from(servers.values()).map((s) => ({
      name: s.config.name,
      ...(s.config.description ? { description: s.config.description } : {}),
    }));
  }

  async function stop(): Promise<void> {
    for (const [, server] of servers) {
      try {
        await server.client.close();
      } catch {
        // best-effort cleanup
      }
    }
    clearState();
  }

  return { start, reload, definitions, execute, serverSummaries, stop };
}
