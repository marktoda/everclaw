import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockToFile } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockToFile: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    audio = { transcriptions: { create: mockCreate } };
  },
  toFile: mockToFile,
}));

import { transcribeAudio } from "./transcription.ts";

describe("transcribeAudio", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockToFile.mockReset();
    mockToFile.mockImplementation(async (buf: Buffer, name: string, opts: any) => ({
      buf,
      name,
      opts,
    }));
  });

  it("returns transcript on success", async () => {
    mockCreate.mockResolvedValue("hello world");
    const result = await transcribeAudio(Buffer.from("audio-data"), "sk-key");
    expect(result).toBe("hello world");
    expect(mockToFile).toHaveBeenCalledWith(expect.any(Buffer), "voice.ogg", { type: "audio/ogg" });
    expect(mockCreate).toHaveBeenCalledWith({
      file: expect.anything(),
      model: "whisper-1",
      response_format: "text",
    });
  });

  it("throws when OpenAI API fails", async () => {
    mockCreate.mockRejectedValue(new Error("rate limit"));
    await expect(transcribeAudio(Buffer.from("audio"), "sk-key")).rejects.toThrow("rate limit");
  });

  it("throws on empty buffer", async () => {
    await expect(transcribeAudio(Buffer.alloc(0), "sk-key")).rejects.toThrow("empty");
  });

  it("trims whitespace from transcript", async () => {
    mockCreate.mockResolvedValue("  hello world  \n");
    const result = await transcribeAudio(Buffer.from("audio"), "sk-key");
    expect(result).toBe("hello world");
  });
});
