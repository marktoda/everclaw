// src/memory/messages.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, Message, ToolResultMessage } from "./history.ts";

type ContentBlock = Anthropic.ContentBlockParam;

/** Narrow MessageParam.content to its array form. Returns null if string. */
function contentBlocks(msg: Anthropic.MessageParam): ContentBlock[] | null {
  return Array.isArray(msg.content) ? msg.content : null;
}

function isToolUse(b: ContentBlock): b is Anthropic.ToolUseBlockParam {
  return b.type === "tool_use";
}

function isToolResult(b: ContentBlock): b is Anthropic.ToolResultBlockParam {
  return b.type === "tool_result";
}

/**
 * Convert DB Message[] → Anthropic MessageParam[] (ready for API).
 * Reconstructs tool_use/tool_result content blocks from stored history,
 * then sanitizes the array (drops orphans, fixes mismatched IDs,
 * merges consecutive same-role messages).
 */
export function reconstructMessages(history: Message[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of history) {
    if (msg.role === "assistant" && msg.toolUse && msg.toolUse.length > 0) {
      const content: ContentBlock[] = [];
      if (msg.content && msg.content !== "(tool use only)") {
        content.push({ type: "text", text: msg.content });
      }
      for (const tu of msg.toolUse) {
        content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "tool" && msg.toolUse?.length > 0) {
      messages.push({
        role: "user",
        content: msg.toolUse.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      });
    } else if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  return sanitizeMessages(messages);
}

/**
 * Convert Anthropic messages from the agent loop back → DB Message[]
 * (ready for appendMessage INSERT). Handles assistant messages (with or
 * without tool_use) and user messages containing tool_result blocks.
 */
export function deconstructMessages(
  recipientId: string,
  loopMessages: Anthropic.MessageParam[],
): Message[] {
  const result: Message[] = [];

  for (const msg of loopMessages) {
    if (msg.role === "assistant") {
      const blocks = contentBlocks(msg) ?? [];
      const text = blocks
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolUse = blocks
        .filter(isToolUse)
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
      result.push({
        recipientId,
        role: "assistant",
        content: text || "(tool use only)",
        toolUse: toolUse.length > 0 ? toolUse : undefined,
      } satisfies AssistantMessage);
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      const blocks = msg.content as Anthropic.ToolResultBlockParam[];
      if (blocks[0]?.type === "tool_result") {
        result.push({
          recipientId,
          role: "tool",
          content: blocks.map((r) => `[${r.tool_use_id}]: ${r.content}`).join("\n"),
          toolUse: blocks.map((r) => ({
            tool_use_id: r.tool_use_id,
            content: r.content as string,
          })),
        } satisfies ToolResultMessage);
      }
    }
  }

  return result;
}

/**
 * Sanitize reconstructed messages to ensure valid Anthropic API structure.
 * Validates tool_use/tool_result pairing throughout the entire array:
 * - Drops orphaned tool_result without a preceding matching tool_use
 * - Drops assistant tool_use without a following tool_result with matching IDs
 * - Merges consecutive same-role messages to maintain alternation
 */
export function sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Pass 1: validate tool_use/tool_result pairs, drop invalid ones
  const cleaned: Anthropic.MessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    const blocks = contentBlocks(msg);

    // Skip orphaned tool_result (not preceded by a matching tool_use)
    if (msg.role === "user" && blocks && isToolResult(blocks[0])) {
      i++;
      continue;
    }

    // Validate assistant message with tool_use blocks
    if (msg.role === "assistant" && blocks?.some(isToolUse)) {
      const next = messages[i + 1];
      const nextBlocks = next ? contentBlocks(next) : null;
      if (next?.role === "user" && nextBlocks && isToolResult(nextBlocks[0])) {
        const useIds = new Set(blocks.filter(isToolUse).map((b) => b.id));
        const resultIds = new Set(nextBlocks.filter(isToolResult).map((b) => b.tool_use_id));
        // Valid pair: every use has a result and vice versa
        if (
          useIds.size > 0 &&
          [...resultIds].every((id) => useIds.has(id)) &&
          [...useIds].every((id) => resultIds.has(id))
        ) {
          cleaned.push(msg, next);
          i += 2;
          continue;
        }
      }
      // Invalid or missing tool_result — drop the assistant tool_use message
      i++;
      continue;
    }

    cleaned.push(msg);
    i++;
  }

  // Pass 2: merge consecutive same-role messages to fix alternation
  // (dropping tool pairs can leave adjacent user or assistant messages)
  const result: Anthropic.MessageParam[] = [];
  for (const msg of cleaned) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      const prev = result[result.length - 1];
      const prevText = typeof prev.content === "string" ? prev.content : "";
      const curText = typeof msg.content === "string" ? msg.content : "";
      result[result.length - 1] = {
        role: msg.role,
        content: [prevText, curText].filter(Boolean).join("\n\n"),
      };
    } else {
      result.push(msg);
    }
  }

  return result;
}
