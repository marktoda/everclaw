/** Find the best split point: prefer \n\n, then \n, then hard-split at maxEnd.
 *  Never splits in the middle of a surrogate pair. */
export function findSplitPoint(text: string, start: number, maxEnd: number): number {
  let splitAt = text.lastIndexOf("\n\n", maxEnd);
  if (splitAt <= start) splitAt = text.lastIndexOf("\n", maxEnd);
  if (splitAt <= start) splitAt = maxEnd;
  // Don't split in the middle of a surrogate pair
  if (splitAt > 0 && splitAt < text.length) {
    const code = text.charCodeAt(splitAt - 1);
    if (code >= 0xd800 && code <= 0xdbff) splitAt--;
  }
  return splitAt;
}

/** Split text into chunks that fit within a character limit.
 *  Prefers paragraph boundaries (\n\n), then line boundaries (\n), then hard-splits. */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = findSplitPoint(remaining, 0, maxLength);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
