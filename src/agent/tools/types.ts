import type Anthropic from "@anthropic-ai/sdk";
import type { Absurd, TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { ChannelRegistry } from "../../channels/registry.ts";
import type { ExtraDir } from "../../config.ts";

export interface ExecutorDeps {
  absurd: Absurd;
  pool: Pool;
  ctx: TaskContext;
  chatId: string;
  startedAt: Date;

  dirs: {
    notes: string;
    skills: string;
    scripts: string;
    servers: string;
    extra: ExtraDir[];
  };

  queueName: string;
  scriptTimeout: number;
  scriptEnv: Record<string, string>;
  searchApiKey?: string;
  reloadMcp?: () => Promise<void>;
  allowedChatIds: Set<string>;
  channels?: ChannelRegistry;
}

export interface ToolHandler {
  def: Anthropic.Tool;
  suspends?: boolean;
  execute(input: Record<string, unknown>, deps: ExecutorDeps): Promise<string>;
}

export function defineTool(
  name: string,
  description: string,
  properties: Record<string, { type?: string; description?: string; enum?: string[] }> = {},
  required: string[] = [],
): Anthropic.Tool {
  return {
    name,
    description,
    input_schema: { type: "object" as const, properties, required },
  };
}
