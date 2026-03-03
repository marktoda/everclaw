import type Anthropic from "@anthropic-ai/sdk";
import type { Absurd, TaskContext } from "absurd-sdk";
import type { Pool } from "pg";

export type ToolDef = Anthropic.Tool;

export interface ExecutorDeps {
  absurd: Absurd;
  pool: Pool;
  ctx: TaskContext;
  queueName: string;
  chatId: number;
  notesDir: string;
  skillsDir: string;
  toolsDir: string;
  scriptTimeout: number;
  startedAt: Date;
  searchApiKey?: string;
}

export interface ToolHandler {
  def: ToolDef;
  suspends?: boolean;
  execute(input: Record<string, unknown>, deps: ExecutorDeps): Promise<string>;
}

export function defineTool(
  name: string,
  description: string,
  properties: Record<string, { type?: string; description?: string }> = {},
  required: string[] = [],
): ToolDef {
  return {
    name,
    description,
    input_schema: { type: "object" as const, properties, required },
  };
}
