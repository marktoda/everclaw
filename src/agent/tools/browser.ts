/** Split a command string into args, respecting quoted segments. */
export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of cmd) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}
