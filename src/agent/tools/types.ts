import type Anthropic from "@anthropic-ai/sdk";
import type { Absurd, TaskContext } from "absurd-sdk";
import type { Pool } from "pg";
import type { ExtraDir } from "../../config.ts";

export type ToolDef = Anthropic.Tool;

export interface ExecutorDeps {
  absurd: Absurd;
  pool: Pool;
  ctx: TaskContext;
  recipientId: string;
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
}

export interface ToolHandler {
  def: ToolDef;
  suspends?: boolean;
  execute(input: Record<string, unknown>, deps: ExecutorDeps): Promise<string>;
}

export function defineTool(
  name: string,
  description: string,
  properties: Record<string, { type?: string; description?: string; enum?: string[] }> = {},
  required: string[] = [],
): ToolDef {
  return {
    name,
    description,
    input_schema: { type: "object" as const, properties, required },
  };
}
