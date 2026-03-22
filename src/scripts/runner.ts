import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { baseChildEnv } from "../child-env.ts";

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".ts"]);

export function runScript(
  scriptPath: string,
  input: string,
  timeoutSeconds: number,
  env?: Record<string, string>,
): Promise<string> {
  const ext = path.extname(scriptPath);
  const isPython = ext === ".py";
  const command = isPython ? "uv" : scriptPath;
  const args = isPython ? ["run", "--script", scriptPath] : [];

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        env: env ? baseChildEnv(env) : undefined,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr) reject(new Error(`Script failed: ${stderr}`));
          else reject(err);
          return;
        }
        resolve(stdout);
      },
    );
    if (child.stdin) {
      child.stdin.on("error", () => {}); // ignore EPIPE if process exits early
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export interface ScriptEntry {
  name: string;
  path: string;
  description?: string;
}

const HASH_COMMENT_EXTS = new Set([".sh", ".bash", ".py"]);
const SLASH_COMMENT_EXTS = new Set([".js", ".ts"]);
const MAX_HEAD_LINES = 20;

function extractPythonDocstring(lines: string[], start: number): string | null {
  let i = start;
  // Skip blank lines before docstring
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !lines[i].trim().startsWith('"""')) return null;

  const opening = lines[i].trim();
  // Single-line docstring: """description"""
  if (opening.endsWith('"""') && opening.length > 6) {
    return opening.slice(3, -3).trim();
  }
  // Multi-line docstring
  const result: string[] = [];
  const firstLine = opening.slice(3).trim();
  if (firstLine) result.push(firstLine);
  i++;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().endsWith('"""')) {
      const last = line.trim().slice(0, -3).trim();
      if (last) result.push(last);
      break;
    }
    result.push(line.trim());
    i++;
  }
  return result.join("\n").trim();
}

function extractLineComments(
  lines: string[],
  start: number,
  prefix: string,
  strip: RegExp,
): string {
  const result: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(prefix)) {
      result.push(line.replace(strip, ""));
    } else if (line.trim() !== "" || result.length > 0) {
      break;
    }
  }
  return result.join("\n").trim();
}

export async function getScriptDescription(filePath: string): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }

  const lines = content.split("\n").slice(0, MAX_HEAD_LINES);
  const ext = path.extname(filePath);
  const start = lines[0]?.startsWith("#!") ? 1 : 0;

  if (HASH_COMMENT_EXTS.has(ext)) {
    if (ext === ".py") {
      const docstring = extractPythonDocstring(lines, start);
      if (docstring != null) return docstring;
    }
    return extractLineComments(lines, start, "#", /^#\s?/);
  }
  if (SLASH_COMMENT_EXTS.has(ext)) {
    return extractLineComments(lines, start, "//", /^\/\/\s?/);
  }
  return "";
}

export async function listScripts(scriptsDir: string): Promise<ScriptEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(scriptsDir);
  } catch {
    return [];
  }

  const scripts: ScriptEntry[] = [];
  for (const entry of entries) {
    const ext = path.extname(entry);
    if (!SCRIPT_EXTENSIONS.has(ext)) continue;
    const filePath = path.join(scriptsDir, entry);
    const description = await getScriptDescription(filePath);
    scripts.push({
      name: entry.replace(/\.[^.]+$/, ""),
      path: filePath,
      ...(description && { description }),
    });
  }
  return scripts;
}
