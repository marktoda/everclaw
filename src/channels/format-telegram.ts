import { marked } from "marked";
import type { Token, Tokens } from "marked";

export interface FormattedMessage {
  text: string;
  entities: TelegramEntity[];
}

export type TelegramEntity =
  | { type: "bold" | "italic" | "strikethrough" | "code" | "blockquote"; offset: number; length: number }
  | { type: "pre"; offset: number; length: number; language?: string }
  | { type: "text_link"; offset: number; length: number; url: string };

export function markdownToEntities(md: string): FormattedMessage {
  const tokens = marked.lexer(md);
  const buf: string[] = [];
  const entities: TelegramEntity[] = [];

  walkBlocks(tokens, buf, entities, new Set());

  // Clean up trailing newlines
  let text = buf.join("");
  while (text.endsWith("\n")) text = text.slice(0, -1);

  // Clamp entity lengths to not exceed text length
  for (const e of entities) {
    if (e.offset + e.length > text.length) {
      e.length = text.length - e.offset;
    }
  }

  return { text, entities: entities.filter((e) => e.length > 0) };
}

function currentOffset(buf: string[]): number {
  let len = 0;
  for (const s of buf) len += s.length;
  return len;
}

function walkBlocks(tokens: Token[], buf: string[], entities: TelegramEntity[], activeTypes: Set<string>): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Separate blocks with newlines (but not before the first block)
    if (i > 0 && isBlock(token) && hasPrecedingBlock(tokens, i)) {
      const text = buf.join("");
      if (!text.endsWith("\n\n")) {
        if (text.endsWith("\n")) buf.push("\n");
        else buf.push("\n\n");
      }
    }

    switch (token.type) {
      case "heading": {
        const start = currentOffset(buf);
        const innerActive = new Set(activeTypes);
        innerActive.add("bold");
        walkInline((token as Tokens.Heading).tokens ?? [], buf, entities, innerActive);
        if (!activeTypes.has("bold")) {
          entities.push({ type: "bold", offset: start, length: currentOffset(buf) - start });
        }
        buf.push("\n");
        break;
      }
      case "paragraph": {
        walkInline((token as Tokens.Paragraph).tokens ?? [], buf, entities, activeTypes);
        buf.push("\n");
        break;
      }
      case "code": {
        const codeToken = token as Tokens.Code;
        const start = currentOffset(buf);
        buf.push(codeToken.text);
        const entity: TelegramEntity = { type: "pre", offset: start, length: codeToken.text.length };
        if (codeToken.lang) (entity as any).language = codeToken.lang;
        entities.push(entity);
        buf.push("\n");
        break;
      }
      case "blockquote": {
        const start = currentOffset(buf);
        walkBlocks((token as Tokens.Blockquote).tokens ?? [], buf, entities, activeTypes);
        const end = currentOffset(buf);
        const text = buf.join("");
        const trimmedEnd = text.endsWith("\n") ? end - 1 : end;
        if (trimmedEnd > start) {
          entities.push({ type: "blockquote", offset: start, length: trimmedEnd - start });
        }
        break;
      }
      case "list": {
        const listToken = token as Tokens.List;
        for (let j = 0; j < listToken.items.length; j++) {
          const item = listToken.items[j];
          const prefix = listToken.ordered ? `${Number(listToken.start ?? 1) + j}. ` : "\u2022 ";
          buf.push(prefix);
          for (const child of item.tokens) {
            if (child.type === "text" && (child as Tokens.Text).tokens) {
              walkInline((child as Tokens.Text).tokens!, buf, entities, activeTypes);
            } else if (child.type === "paragraph" && (child as Tokens.Paragraph).tokens) {
              walkInline((child as Tokens.Paragraph).tokens!, buf, entities, activeTypes);
            } else {
              walkBlocks([child], buf, entities, activeTypes);
            }
          }
          buf.push("\n");
        }
        break;
      }
      case "hr": {
        buf.push("\n");
        break;
      }
      case "space": {
        break;
      }
      default: {
        if ("tokens" in token && Array.isArray(token.tokens)) {
          walkInline(token.tokens, buf, entities, activeTypes);
        } else if ("text" in token && typeof token.text === "string") {
          buf.push(token.text);
        }
        break;
      }
    }
  }
}

function walkInline(tokens: Token[], buf: string[], entities: TelegramEntity[], activeTypes: Set<string>): void {
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        if (textToken.tokens) {
          walkInline(textToken.tokens, buf, entities, activeTypes);
        } else {
          buf.push(textToken.text);
        }
        break;
      }
      case "strong": {
        const start = currentOffset(buf);
        const innerActive = new Set(activeTypes);
        innerActive.add("bold");
        walkInline((token as Tokens.Strong).tokens ?? [], buf, entities, innerActive);
        if (!activeTypes.has("bold")) {
          entities.push({ type: "bold", offset: start, length: currentOffset(buf) - start });
        }
        break;
      }
      case "em": {
        const start = currentOffset(buf);
        const innerActive = new Set(activeTypes);
        innerActive.add("italic");
        walkInline((token as Tokens.Em).tokens ?? [], buf, entities, innerActive);
        if (!activeTypes.has("italic")) {
          entities.push({ type: "italic", offset: start, length: currentOffset(buf) - start });
        }
        break;
      }
      case "del": {
        const start = currentOffset(buf);
        const innerActive = new Set(activeTypes);
        innerActive.add("strikethrough");
        walkInline((token as Tokens.Del).tokens ?? [], buf, entities, innerActive);
        if (!activeTypes.has("strikethrough")) {
          entities.push({ type: "strikethrough", offset: start, length: currentOffset(buf) - start });
        }
        break;
      }
      case "codespan": {
        const start = currentOffset(buf);
        const text = (token as Tokens.Codespan).text;
        buf.push(text);
        if (!activeTypes.has("code")) {
          entities.push({ type: "code", offset: start, length: text.length });
        }
        break;
      }
      case "link": {
        const linkToken = token as Tokens.Link;
        const start = currentOffset(buf);
        walkInline(linkToken.tokens ?? [], buf, entities, activeTypes);
        entities.push({ type: "text_link", offset: start, length: currentOffset(buf) - start, url: linkToken.href });
        break;
      }
      case "image": {
        const imgToken = token as Tokens.Image;
        const start = currentOffset(buf);
        const alt = imgToken.text || imgToken.href;
        buf.push(alt);
        entities.push({ type: "text_link", offset: start, length: alt.length, url: imgToken.href });
        break;
      }
      case "br": {
        buf.push("\n");
        break;
      }
      case "escape": {
        buf.push((token as Tokens.Escape).text);
        break;
      }
      default: {
        if ("text" in token && typeof token.text === "string") {
          buf.push(token.text);
        }
        break;
      }
    }
  }
}

function hasPrecedingBlock(tokens: Token[], index: number): boolean {
  for (let j = index - 1; j >= 0; j--) {
    if (tokens[j].type === "space") continue;
    return isBlock(tokens[j]);
  }
  return false;
}

function isBlock(token: Token): boolean {
  return ["heading", "paragraph", "code", "blockquote", "list", "hr", "table"].includes(token.type);
}
