import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: any[]) => Promise<void>;
const capturedEventHandlers = new Map<string, Handler>();
const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
const mockStartApp = vi.fn().mockResolvedValue(undefined);
const mockStopApp = vi.fn().mockResolvedValue(undefined);

vi.mock("@slack/bolt", () => {
  class App {
    client = { chat: { postMessage: mockPostMessage } };
    event(name: string, handler: Handler) {
      capturedEventHandlers.set(name, handler);
    }
    error = vi.fn();
    start = mockStartApp;
    stop = mockStopApp;
  }
  return { App };
});

import { SlackAdapter } from "./slack.ts";

describe("SlackAdapter", () => {
  beforeEach(() => {
    capturedEventHandlers.clear();
    mockPostMessage.mockClear();
    mockStartApp.mockClear();
    mockStopApp.mockClear();
  });

  it("has name 'slack'", () => {
    const adapter = new SlackAdapter("xoxb-bot|xapp-app");
    expect(adapter.name).toBe("slack");
  });

  it("throws if token is not pipe-delimited", () => {
    expect(() => new SlackAdapter("just-one-token")).toThrow("pipe-delimited");
  });

  it("start registers message handler and calls onMessage", async () => {
    const adapter = new SlackAdapter("xoxb-bot|xapp-app");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    expect(mockStartApp).toHaveBeenCalled();

    const handler = capturedEventHandlers.get("message");
    expect(handler).toBeDefined();

    await handler?.({
      event: {
        type: "message",
        text: "hello",
        channel: "C04ABC",
        user: "U123",
      },
      say: vi.fn(),
    });

    expect(onMessage).toHaveBeenCalledWith({
      recipientId: "slack:C04ABC",
      text: "hello",
    });
  });

  it("ignores bot messages (has subtype)", async () => {
    const adapter = new SlackAdapter("xoxb-bot|xapp-app");
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);
    const handler = capturedEventHandlers.get("message");

    await handler?.({
      event: {
        type: "message",
        subtype: "bot_message",
        text: "I'm a bot",
        channel: "C04ABC",
      },
      say: vi.fn(),
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("sendMessage posts to correct channel with splitting at 4000 chars", async () => {
    const adapter = new SlackAdapter("xoxb-bot|xapp-app");
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    await adapter.sendMessage("slack:C04ABC", "a".repeat(5000));

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage.mock.calls[0][0]).toMatchObject({
      channel: "C04ABC",
      text: "a".repeat(4000),
    });
    expect(mockPostMessage.mock.calls[1][0]).toMatchObject({
      channel: "C04ABC",
      text: "a".repeat(1000),
    });
  });

  it("does not implement setTyping (Slack API limitation)", () => {
    const adapter = new SlackAdapter("xoxb-bot|xapp-app") as any;
    expect(adapter.setTyping).toBeUndefined();
  });

  it("stop stops the app", async () => {
    const adapter = new SlackAdapter("xoxb-bot|xapp-app");
    await adapter.stop();
    expect(mockStopApp).toHaveBeenCalledOnce();
  });
});
