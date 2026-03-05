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

/** Accumulates plain text and tracks the current UTF-16 offset. */
interface Writer {
  buf: string[];
  offset: number;
}

function push(w: Writer, s: string): void {
  w.buf.push(s);
  w.offset += s.length;
}

function endsWith(w: Writer, suffix: string): boolean {
  // Check the last buf segment(s) without joining
  const last = w.buf[w.buf.length - 1] ?? "";
  if (last.length >= suffix.length) return last.endsWith(suffix);
  // Rare: suffix spans two segments
  const prev = w.buf[w.buf.length - 2] ?? "";
  return (prev + last).endsWith(suffix);
}

export function markdownToEntities(md: string): FormattedMessage {
  const tokens = marked.lexer(md);
  const w: Writer = { buf: [], offset: 0 };
  const entities: TelegramEntity[] = [];

  walkBlocks(tokens, w, entities, new Set());

  let text = w.buf.join("").replace(/\n+$/, "");

  // Clamp entity lengths to not exceed text length
  for (const e of entities) {
    if (e.offset + e.length > text.length) {
      e.length = text.length - e.offset;
    }
  }

  return { text, entities: entities.filter((e) => e.length > 0) };
}

type EntityType = TelegramEntity["type"];

/** Emit an inline formatting span: walk children, suppress duplicate entity types, push entity. */
function emitFormatted(
  entityType: "bold" | "italic" | "strikethrough",
  childTokens: Token[],
  w: Writer,
  entities: TelegramEntity[],
  activeTypes: Set<EntityType>,
): void {
  const start = w.offset;
  const inner = new Set(activeTypes);
  inner.add(entityType);
  walkInline(childTokens, w, entities, inner);
  if (!activeTypes.has(entityType)) {
    entities.push({ type: entityType, offset: start, length: w.offset - start });
  }
}

function walkBlocks(tokens: Token[], w: Writer, entities: TelegramEntity[], activeTypes: Set<EntityType>): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Separate blocks with newlines (but not before the first block)
    if (i > 0 && isBlock(token) && hasPrecedingBlock(tokens, i)) {
      if (!endsWith(w, "\n\n")) {
        push(w, endsWith(w, "\n") ? "\n" : "\n\n");
      }
    }

    switch (token.type) {
      case "heading": {
        const start = w.offset;
        const inner = new Set(activeTypes);
        inner.add("bold");
        walkInline((token as Tokens.Heading).tokens ?? [], w, entities, inner);
        if (!activeTypes.has("bold")) {
          entities.push({ type: "bold", offset: start, length: w.offset - start });
        }
        push(w, "\n");
        break;
      }
      case "paragraph": {
        walkInline((token as Tokens.Paragraph).tokens ?? [], w, entities, activeTypes);
        push(w, "\n");
        break;
      }
      case "code": {
        const codeToken = token as Tokens.Code;
        const start = w.offset;
        push(w, codeToken.text);
        const entity: TelegramEntity = codeToken.lang
          ? { type: "pre", offset: start, length: codeToken.text.length, language: codeToken.lang }
          : { type: "pre", offset: start, length: codeToken.text.length };
        entities.push(entity);
        push(w, "\n");
        break;
      }
      case "blockquote": {
        const start = w.offset;
        walkBlocks((token as Tokens.Blockquote).tokens ?? [], w, entities, activeTypes);
        const trimmedEnd = endsWith(w, "\n") ? w.offset - 1 : w.offset;
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
          push(w, prefix);
          for (const child of item.tokens) {
            if (child.type === "text" && (child as Tokens.Text).tokens) {
              walkInline((child as Tokens.Text).tokens!, w, entities, activeTypes);
            } else if (child.type === "paragraph" && (child as Tokens.Paragraph).tokens) {
              walkInline((child as Tokens.Paragraph).tokens!, w, entities, activeTypes);
            } else {
              walkBlocks([child], w, entities, activeTypes);
            }
          }
          push(w, "\n");
        }
        break;
      }
      case "hr": {
        push(w, "\n");
        break;
      }
      case "space": {
        break;
      }
      default: {
        if ("tokens" in token && Array.isArray(token.tokens)) {
          walkInline(token.tokens, w, entities, activeTypes);
        } else if ("text" in token && typeof token.text === "string") {
          push(w, token.text);
        }
        break;
      }
    }
  }
}

function walkInline(tokens: Token[], w: Writer, entities: TelegramEntity[], activeTypes: Set<EntityType>): void {
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        if (textToken.tokens) {
          walkInline(textToken.tokens, w, entities, activeTypes);
        } else {
          push(w, textToken.text);
        }
        break;
      }
      case "strong": {
        emitFormatted("bold", (token as Tokens.Strong).tokens ?? [], w, entities, activeTypes);
        break;
      }
      case "em": {
        emitFormatted("italic", (token as Tokens.Em).tokens ?? [], w, entities, activeTypes);
        break;
      }
      case "del": {
        emitFormatted("strikethrough", (token as Tokens.Del).tokens ?? [], w, entities, activeTypes);
        break;
      }
      case "codespan": {
        const start = w.offset;
        const text = (token as Tokens.Codespan).text;
        push(w, text);
        if (!activeTypes.has("code")) {
          entities.push({ type: "code", offset: start, length: text.length });
        }
        break;
      }
      case "link": {
        const linkToken = token as Tokens.Link;
        const start = w.offset;
        walkInline(linkToken.tokens ?? [], w, entities, activeTypes);
        entities.push({ type: "text_link", offset: start, length: w.offset - start, url: linkToken.href });
        break;
      }
      case "image": {
        const imgToken = token as Tokens.Image;
        const start = w.offset;
        const alt = imgToken.text || imgToken.href;
        push(w, alt);
        entities.push({ type: "text_link", offset: start, length: alt.length, url: imgToken.href });
        break;
      }
      case "br": {
        push(w, "\n");
        break;
      }
      case "escape": {
        push(w, (token as Tokens.Escape).text);
        break;
      }
      default: {
        if ("text" in token && typeof token.text === "string") {
          push(w, token.text);
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
