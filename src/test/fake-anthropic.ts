// src/test/fake-anthropic.ts
import type Anthropic from "@anthropic-ai/sdk";

export interface ScenarioTurn {
  content: Anthropic.ContentBlock[];
  stop_reason: "end_turn" | "tool_use";
}

export interface Scenario {
  name: string;
  turns: ScenarioTurn[];
}

/**
 * Validate the messages.create request against the Anthropic API contract.
 * Throws a descriptive error on any violation.
 */
function validateRequest(params: Anthropic.MessageCreateParamsNonStreaming): void {
  // 1. Required fields
  if (!params.model) {
    throw new Error("Contract violation: model must be a non-empty string");
  }
  if (!params.max_tokens || params.max_tokens <= 0) {
    throw new Error("Contract violation: max_tokens must be > 0");
  }

  // 2. Messages non-empty
  if (!params.messages || params.messages.length === 0) {
    throw new Error("Contract violation: messages array must have at least one message");
  }

  // 3. First message is user
  if (params.messages[0].role !== "user") {
    throw new Error(
      `Contract violation: first message must be a user message, got "${params.messages[0].role}"`,
    );
  }

  // 4. Role alternation
  for (let i = 1; i < params.messages.length; i++) {
    if (params.messages[i].role === params.messages[i - 1].role) {
      throw new Error(
        `Contract violation: messages must alternate between user and assistant roles. ` +
          `Found consecutive "${params.messages[i].role}" messages at indices ${i - 1} and ${i}`,
      );
    }
  }

  // Build lookup maps for tool_use and tool_result validation
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];
    const content = msg.content;

    if (!Array.isArray(content)) continue;

    if (msg.role === "user") {
      // Check for tool_result blocks
      const toolResults = (content as Anthropic.ContentBlockParam[]).filter(
        (b: any) => b.type === "tool_result",
      ) as Anthropic.ToolResultBlockParam[];

      if (toolResults.length > 0) {
        // 6. No orphan tool_result: must be preceded by an assistant with tool_use
        if (i === 0) {
          throw new Error(
            "Contract violation: tool_result blocks found without a preceding assistant message with tool_use",
          );
        }
        const prev = params.messages[i - 1];
        if (prev.role !== "assistant" || !Array.isArray(prev.content)) {
          throw new Error(
            "Contract violation: tool_result blocks found without a preceding assistant message with tool_use",
          );
        }
        const prevToolUses = (prev.content as Anthropic.ContentBlock[]).filter(
          (b: any) => b.type === "tool_use",
        ) as Anthropic.ToolUseBlock[];
        if (prevToolUses.length === 0) {
          throw new Error(
            "Contract violation: tool_result blocks found without a preceding assistant message with tool_use",
          );
        }

        // Check that every tool_result ID matches a tool_use ID in the preceding assistant message
        const toolUseIds = new Set(prevToolUses.map((b) => b.id));
        for (const tr of toolResults) {
          if (!toolUseIds.has(tr.tool_use_id)) {
            throw new Error(
              `Contract violation: tool_result with ID "${tr.tool_use_id}" has no matching tool_use — ` +
                `ID mismatch or missing tool_use in preceding assistant message`,
            );
          }
        }
      }
    }

    if (msg.role === "assistant" && Array.isArray(content)) {
      // Check for tool_use blocks
      const toolUses = (content as Anthropic.ContentBlock[]).filter(
        (b: any) => b.type === "tool_use",
      ) as Anthropic.ToolUseBlock[];

      if (toolUses.length > 0) {
        // 5. tool_result follows tool_use: the next message must contain tool_result blocks
        const next = params.messages[i + 1];
        if (!next) {
          throw new Error(
            `Contract violation: assistant message with tool_use blocks at index ${i} ` +
              `must be followed by a user message with tool_result blocks`,
          );
        }
        if (next.role !== "user" || !Array.isArray(next.content)) {
          throw new Error(
            `Contract violation: assistant message with tool_use blocks at index ${i} ` +
              `must be followed by a user message with tool_result blocks`,
          );
        }
        const nextToolResults = (next.content as Anthropic.ContentBlockParam[]).filter(
          (b: any) => b.type === "tool_result",
        ) as Anthropic.ToolResultBlockParam[];
        if (nextToolResults.length === 0) {
          throw new Error(
            `Contract violation: assistant message with tool_use blocks at index ${i} ` +
              `must be followed by a user message with tool_result blocks`,
          );
        }

        // 7. Mismatched IDs: every tool_use ID must have a corresponding tool_result
        const resultIds = new Set(nextToolResults.map((b) => b.tool_use_id));
        for (const tu of toolUses) {
          if (!resultIds.has(tu.id)) {
            throw new Error(
              `Contract violation: tool_use with ID "${tu.id}" has no matching tool_result — ` +
                `missing tool_result in the following user message`,
            );
          }
        }
      }
    }
  }
}

/**
 * Scenario-driven fake Anthropic client. Validates every messages.create call
 * against the API contract before returning scripted responses.
 */
type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

export class FakeAnthropic {
  private readonly scenario: Scenario;
  private turnIndex = 0;
  private readonly _requests: CreateParams[] = [];

  readonly messages: {
    create: (params: CreateParams) => Promise<Anthropic.Message>;
  };

  constructor(scenario: Scenario) {
    this.scenario = scenario;

    // Bind create so it can be destructured
    this.messages = {
      create: async (params: CreateParams): Promise<Anthropic.Message> => {
        // Validate the request against the API contract
        validateRequest(params);

        // Store a deep clone of the request
        this._requests.push(structuredClone(params));

        // Check that we haven't exhausted all turns
        if (this.turnIndex >= this.scenario.turns.length) {
          throw new Error(
            `Scenario "${this.scenario.name}" exhausted: ` +
              `all ${this.scenario.turns.length} turns have been consumed`,
          );
        }

        const turn = this.scenario.turns[this.turnIndex++];

        return {
          id: `msg_fake_${this.turnIndex}`,
          type: "message" as const,
          role: "assistant" as const,
          model: params.model,
          content: turn.content,
          stop_reason: turn.stop_reason,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as Anthropic.Message;
      },
    };
  }

  get callCount(): number {
    return this._requests.length;
  }

  get allRequests(): CreateParams[] {
    return this._requests;
  }

  /**
   * Throws if there are unconsumed turns remaining in the scenario.
   */
  assertAllTurnsConsumed(): void {
    const remaining = this.scenario.turns.length - this.turnIndex;
    if (remaining > 0) {
      throw new Error(
        `Scenario "${this.scenario.name}" has ${remaining} unconsumed turn(s) remaining ` +
          `(used ${this.turnIndex} of ${this.scenario.turns.length})`,
      );
    }
  }
}
