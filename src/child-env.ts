/** Minimal host environment forwarded to child processes (scripts, MCP servers). */
export function baseChildEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...extra,
  };
}
