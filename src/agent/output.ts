// src/agent/output.ts

/** Strip <internal>...</internal> tags from agent output */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
}
