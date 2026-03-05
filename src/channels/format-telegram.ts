/**
 * Convert CommonMark/GFM markdown to Telegram-compatible HTML.
 * Telegram supports: <b>, <i>, <s>, <u>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>
 * Unsupported tags are stripped by Telegram, so erring on the side of inclusion is safe.
 */
export function markdownToTelegramHtml(md: string): string {
  // 1. Escape HTML entities in the raw markdown
  let text = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. Extract fenced code blocks into placeholders
  const codeBlocks: string[] = [];
  text = text.replace(/^```(\w*)\n([\s\S]*?)^```/gm, (_, lang, code) => {
    const trimmed = code.replace(/\n$/, "");
    const attr = lang ? ` language="${lang}"` : "";
    codeBlocks.push(`<pre><code${attr}>${trimmed}</code></pre>`);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // 3. Extract inline code into placeholders
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // 4. Block rules (applied line by line)
  text = text
    .split("\n")
    .map((line) => {
      // Headings → bold
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) return `<b>${heading[2]}</b>`;

      // Horizontal rules → empty line
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) return "";

      // Blockquotes
      const quote = line.match(/^&gt;\s?(.*)$/);
      if (quote) return `<blockquote>${quote[1]}</blockquote>`;

      // Unordered list items
      const ul = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (ul) return `${ul[1]}\u2022 ${ul[2]}`;

      // Ordered list items — keep as-is (already readable)

      return line;
    })
    .join("\n");

  // Merge adjacent blockquotes into single blocks
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // 5. Inline rules
  // Bold: **text**
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic: *text*
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Images: ![alt](url) → link (must run before links)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 6. Restore placeholders
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  // Clean up excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
