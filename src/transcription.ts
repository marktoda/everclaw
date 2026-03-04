import OpenAI, { toFile } from "openai";

export async function transcribeAudio(buffer: Buffer, apiKey: string): Promise<string> {
  if (!buffer || buffer.length === 0) {
    throw new Error("Cannot transcribe empty audio buffer");
  }

  const openai = new OpenAI({ apiKey });
  const file = await toFile(buffer, "voice.ogg", { type: "audio/ogg" });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "text",
  });

  // When response_format is 'text', the API returns a plain string
  return (transcription as unknown as string).trim();
}
