import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockList, mockGet, mockSend, mockModify, mockGetProfile } = vi.hoisted(() => ({
  mockList: vi.fn().mockResolvedValue({ data: { messages: [] } }),
  mockGet: vi.fn(),
  mockSend: vi.fn().mockResolvedValue({ data: { id: "sent1" } }),
  mockModify: vi.fn().mockResolvedValue({}),
  mockGetProfile: vi.fn().mockResolvedValue({ data: { emailAddress: "me@gmail.com" } }),
}));

vi.mock("googleapis", () => {
  const gmail = {
    users: {
      messages: {
        list: mockList,
        get: mockGet,
        send: mockSend,
        modify: mockModify,
      },
      getProfile: mockGetProfile,
    },
  };
  return {
    google: {
      gmail: vi.fn().mockReturnValue(gmail),
      auth: {
        OAuth2: class {
          setCredentials = vi.fn();
          generateAuthUrl = vi.fn().mockReturnValue("https://auth.url");
          on = vi.fn();
        },
      },
    },
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockImplementation((filePath: string) => {
    if (filePath.includes("credentials.json")) {
      return Promise.resolve(
        JSON.stringify({
          installed: {
            client_id: "id",
            client_secret: "secret",
            redirect_uris: ["http://localhost"],
          },
        }),
      );
    }
    if (filePath.includes("token.json")) {
      return Promise.resolve(JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    }
    if (filePath.includes("state.json")) {
      return Promise.reject(new Error("ENOENT"));
    }
    return Promise.reject(new Error("ENOENT"));
  }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import type { ChannelAdapter } from "./adapter.ts";
import { GmailAdapter } from "./gmail.ts";

describe("GmailAdapter", () => {
  beforeEach(() => {
    mockList.mockClear().mockResolvedValue({ data: { messages: [] } });
    mockGet.mockClear();
    mockSend.mockClear();
    mockModify.mockClear();
    mockGetProfile.mockClear().mockResolvedValue({ data: { emailAddress: "me@gmail.com" } });
  });

  it("has name 'gmail'", () => {
    const adapter = new GmailAdapter();
    expect(adapter.name).toBe("gmail");
  });

  it("setTyping is not defined", () => {
    const adapter = new GmailAdapter() as ChannelAdapter;
    expect(adapter.setTyping).toBeUndefined();
  });

  it("start connects and does initial poll without processing", async () => {
    mockList.mockResolvedValueOnce({ data: { messages: [{ id: "old1" }, { id: "old2" }] } });

    const adapter = new GmailAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await adapter.start(onMessage);

    expect(onMessage).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it("sendMessage constructs RFC 2822 email and sends", async () => {
    const adapter = new GmailAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    await adapter.sendMessage("gmail:user@example.com", "Hello there!");

    expect(mockSend).toHaveBeenCalledOnce();
    const raw = mockSend.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, "base64url").toString();
    expect(decoded).toContain("To: user@example.com");
    expect(decoded).toContain("From: me@gmail.com");
    expect(decoded).toContain("Hello there!");

    await adapter.stop();
  });

  it("sendMessage uses stored threading headers for replies", async () => {
    const adapter = new GmailAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    (adapter as any).threadContext.set("user@example.com", {
      subject: "Project update",
      messageId: "<abc@mail.gmail.com>",
      references: "<xyz@mail.gmail.com>",
    });

    await adapter.sendMessage("gmail:user@example.com", "Got it!");

    const raw = mockSend.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, "base64url").toString();
    expect(decoded).toContain("Subject: Re: Project update");
    expect(decoded).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(decoded).toContain("References: <xyz@mail.gmail.com> <abc@mail.gmail.com>");

    await adapter.stop();
  });

  it("stop clears polling interval", async () => {
    const adapter = new GmailAdapter();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await adapter.start(onMessage);
    await adapter.stop();
  });
});
