import type { ToolHandler } from "./types.ts";
import { defineTool } from "./types.ts";

export const channelTools: ToolHandler[] = [
  {
    def: defineTool(
      "read_messages",
      "Read recent messages from a queryable channel (e.g. gmail). " +
        "Call with no channel to see which channels support queries.",
      {
        channel: {
          type: "string",
          description: "Channel name (e.g. 'gmail'). Omit to list queryable channels.",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default 10, max 50)",
        },
        query: {
          type: "string",
          description:
            "Search/filter string. For Gmail, uses Gmail search syntax (e.g. 'from:alice', 'subject:invoice', 'is:unread').",
        },
        unread: {
          type: "string",
          enum: ["true", "false"],
          description: "Only return unread messages (default: false)",
        },
      },
    ),
    async execute(input, deps) {
      if (!deps.channels) return "Error: channel registry not available";

      const { channel, limit, query, unread } = input as {
        channel?: string;
        limit?: number;
        query?: string;
        unread?: string;
      };

      const queryable = deps.channels.queryableChannels();

      if (!channel) {
        if (queryable.length === 0) return "No channels support message queries.";
        return `Queryable channels: ${queryable.join(", ")}`;
      }

      if (!queryable.includes(channel)) {
        return `Channel "${channel}" doesn't support queries. Queryable: ${queryable.join(", ") || "none"}`;
      }

      const messages = await deps.channels.queryMessages(channel, {
        limit: Math.min(limit ?? 10, 50),
        query,
        unread: unread === "true",
      });

      if (messages.length === 0) return "No messages found.";

      return messages
        .map((m) => {
          const parts = [`[${m.timestamp.toISOString()}] ${m.from}`];
          if (m.subject) parts.push(`Subject: ${m.subject}`);
          parts.push(m.text);
          return parts.join("\n");
        })
        .join("\n\n---\n\n");
    },
  },
];
