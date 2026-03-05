import type { FormattedMessage, TelegramEntity } from "./format-telegram.ts";

/** Split text into chunks that fit within a character limit.
 *  Prefers paragraph boundaries (\n\n), then line boundaries (\n), then hard-splits. */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitWithEntities(msg: FormattedMessage, maxLength: number): FormattedMessage[] {
  const { text, entities } = msg;
  if (text.length <= maxLength) return [{ text, entities: [...entities] }];

  const chunks: FormattedMessage[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + maxLength, text.length);

    if (end < text.length) {
      // Find a natural break point
      let splitAt = text.lastIndexOf("\n\n", end);
      if (splitAt <= offset) splitAt = text.lastIndexOf("\n", end);
      if (splitAt <= offset) splitAt = end;
      end = splitAt;

      // Don't split in the middle of a surrogate pair
      if (end > 0 && end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
      }
    }

    const chunkText = text.slice(offset, end);
    const chunkEntities: TelegramEntity[] = [];

    for (const entity of entities) {
      const eStart = entity.offset;
      const eEnd = entity.offset + entity.length;

      // Skip entities entirely outside this chunk
      if (eEnd <= offset || eStart >= end) continue;

      // Clip to chunk boundaries and adjust offset
      const clippedStart = Math.max(eStart, offset);
      const clippedEnd = Math.min(eEnd, end);
      const clipped: TelegramEntity = {
        ...entity,
        offset: clippedStart - offset,
        length: clippedEnd - clippedStart,
      };
      chunkEntities.push(clipped);
    }

    chunks.push({ text: chunkText, entities: chunkEntities });

    // Advance past the split point, skipping leading newlines
    offset = end;
    while (offset < text.length && text[offset] === "\n") offset++;
  }

  return chunks;
}
