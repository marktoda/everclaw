// src/memory/messages.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Message, AssistantMessage, ToolResultMessage } from "./history.ts";

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
      const content: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[] = [];
      if (msg.content && msg.content !== "(tool use only)") {
        content.push({ type: "text", text: msg.content, citations: null } as Anthropic.TextBlock);
      }
      for (const tu of msg.toolUse) {
        content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "tool" && msg.toolUse?.length > 0) {
      messages.push({
        role: "user",
        content: msg.toolUse.map(r => ({
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
  chatId: number,
  loopMessages: Anthropic.MessageParam[],
): Message[] {
  const result: Message[] = [];

  for (const msg of loopMessages) {
    if (msg.role === "assistant") {
      const blocks = msg.content as Anthropic.ContentBlock[];
      const text = blocks
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("\n");
      const toolUse = blocks
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map(b => ({ id: b.id, name: b.name, input: b.input as Record<string, any> }));
      result.push({
        chatId,
        role: "assistant",
        content: text || "(tool use only)",
        toolUse: toolUse.length > 0 ? toolUse : undefined,
      } satisfies AssistantMessage);
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      const blocks = msg.content as Anthropic.ToolResultBlockParam[];
      if (blocks[0]?.type === "tool_result") {
        result.push({
          chatId,
          role: "tool",
          content: blocks.map(r => `[${r.tool_use_id}]: ${r.content}`).join("\n"),
          toolUse: blocks.map(r => ({ tool_use_id: r.tool_use_id, content: r.content as string })),
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

    // Skip orphaned tool_result (not preceded by a matching tool_use)
    if (msg.role === "user" && Array.isArray(msg.content) &&
        (msg.content as any[])[0]?.type === "tool_result") {
      i++;
      continue;
    }

    // Validate assistant message with tool_use blocks
    if (msg.role === "assistant" && Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === "tool_use")) {
      const next = messages[i + 1];
      if (next?.role === "user" && Array.isArray(next.content) &&
          (next.content as any[])[0]?.type === "tool_result") {
        const useIds = new Set(
          (msg.content as any[])
            .filter((b: any) => b.type === "tool_use")
            .map((b: any) => b.id),
        );
        const resultIds = new Set(
          (next.content as any[]).map((b: any) => b.tool_use_id),
        );
        // Valid pair: every use has a result and vice versa
        if (useIds.size > 0 &&
            [...resultIds].every(id => useIds.has(id)) &&
            [...useIds].every(id => resultIds.has(id))) {
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
