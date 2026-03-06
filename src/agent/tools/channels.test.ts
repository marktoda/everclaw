import { describe, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../channels/adapter.ts";
import { channelTools } from "./channels.ts";
import type { ExecutorDeps } from "./types.ts";

const tool = channelTools[0];

function makeDeps(channelsOverride?: Partial<ExecutorDeps["channels"]>): ExecutorDeps {
  return {
    channels: channelsOverride as ExecutorDeps["channels"],
  } as ExecutorDeps;
}

function makeChannels(opts: { queryable?: string[]; messages?: ChannelMessage[] }) {
  return {
    queryableChannels: vi.fn().mockReturnValue(opts.queryable ?? []),
    queryMessages: vi.fn().mockResolvedValue(opts.messages ?? []),
  };
}

describe("read_messages", () => {
  it("returns error when channel registry is not available", async () => {
    const result = await tool.execute({}, { channels: undefined } as unknown as ExecutorDeps);
    expect(result).toBe("Error: channel registry not available");
  });

  it("lists queryable channels when channel param is omitted", async () => {
    const channels = makeChannels({ queryable: ["gmail", "slack"] });
    const result = await tool.execute({}, makeDeps(channels as any));
    expect(result).toBe("Queryable channels: gmail, slack");
  });

  it("returns friendly message when no channels support queries", async () => {
    const channels = makeChannels({ queryable: [] });
    const result = await tool.execute({}, makeDeps(channels as any));
    expect(result).toBe("No channels support message queries.");
  });

  it("returns friendly error for non-queryable channel", async () => {
    const channels = makeChannels({ queryable: ["gmail"] });
    const result = await tool.execute({ channel: "telegram" }, makeDeps(channels as any));
    expect(result).toBe('Channel "telegram" doesn\'t support queries. Queryable: gmail');
  });

  it("returns messages for a valid queryable channel", async () => {
    const messages: ChannelMessage[] = [
      {
        id: "1",
        from: "alice@example.com",
        text: "Hello there",
        timestamp: new Date("2026-03-01T10:00:00Z"),
      },
      {
        id: "2",
        from: "bob@example.com",
        text: "Meeting tomorrow",
        timestamp: new Date("2026-03-01T11:00:00Z"),
      },
    ];
    const channels = makeChannels({ queryable: ["gmail"], messages });
    const result = await tool.execute({ channel: "gmail" }, makeDeps(channels as any));
    expect(result).toContain("[2026-03-01T10:00:00.000Z] alice@example.com");
    expect(result).toContain("Hello there");
    expect(result).toContain("[2026-03-01T11:00:00.000Z] bob@example.com");
    expect(result).toContain("Meeting tomorrow");
    expect(result).toContain("---");
  });

  it('returns "No messages found." when adapter returns empty array', async () => {
    const channels = makeChannels({ queryable: ["gmail"], messages: [] });
    const result = await tool.execute({ channel: "gmail" }, makeDeps(channels as any));
    expect(result).toBe("No messages found.");
  });

  it("passes limit through to adapter (clamping is adapter's job)", async () => {
    const channels = makeChannels({ queryable: ["gmail"], messages: [] });
    await tool.execute({ channel: "gmail", limit: 100 }, makeDeps(channels as any));
    expect(channels.queryMessages).toHaveBeenCalledWith("gmail", {
      limit: 100,
      query: undefined,
      unread: undefined,
    });
  });

  it("passes undefined limit when not provided", async () => {
    const channels = makeChannels({ queryable: ["gmail"], messages: [] });
    await tool.execute({ channel: "gmail" }, makeDeps(channels as any));
    expect(channels.queryMessages).toHaveBeenCalledWith("gmail", {
      limit: undefined,
      query: undefined,
      unread: undefined,
    });
  });

  it("includes subject in output when present", async () => {
    const messages: ChannelMessage[] = [
      {
        id: "1",
        from: "alice@example.com",
        text: "See attached invoice",
        timestamp: new Date("2026-03-01T10:00:00Z"),
        subject: "Invoice #123",
      },
    ];
    const channels = makeChannels({ queryable: ["gmail"], messages });
    const result = await tool.execute({ channel: "gmail" }, makeDeps(channels as any));
    expect(result).toContain("Subject: Invoice #123");
    expect(result).toContain("See attached invoice");
  });

  it("passes query and unread options through", async () => {
    const channels = makeChannels({ queryable: ["gmail"], messages: [] });
    await tool.execute(
      { channel: "gmail", query: "from:alice", unread: true },
      makeDeps(channels as any),
    );
    expect(channels.queryMessages).toHaveBeenCalledWith("gmail", {
      limit: undefined,
      query: "from:alice",
      unread: true,
    });
  });
});
