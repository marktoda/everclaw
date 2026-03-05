import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".ts"]);

const PYTHON_EXTENSIONS = new Set([".py"]);

export function runScript(
  scriptPath: string,
  input: string,
  timeoutSeconds: number,
  env?: Record<string, string>,
): Promise<string> {
  const ext = path.extname(scriptPath);
  const isPython = PYTHON_EXTENSIONS.has(ext);
  const command = isPython ? "uv" : scriptPath;
  const args = isPython ? ["run", "--script", scriptPath] : [];

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        env: env
          ? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }
          : undefined,
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

export async function getScriptDescription(filePath: string): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }

  const lines = content.split("\n").slice(0, MAX_HEAD_LINES);
  const ext = path.extname(filePath);
  const commentLines: string[] = [];

  let i = 0;

  // Skip shebang
  if (lines[0]?.startsWith("#!")) i = 1;

  if (HASH_COMMENT_EXTS.has(ext)) {
    // Check for Python docstring first
    if (ext === ".py") {
      // Skip blank lines after shebang before docstring
      while (i < lines.length && lines[i].trim() === "") i++;
      if (i < lines.length && lines[i].trim().startsWith('"""')) {
        const opening = lines[i].trim();
        if (opening.endsWith('"""') && opening.length > 6) {
          // Single-line docstring: """description"""
          return opening.slice(3, -3).trim();
        }
        // Multi-line docstring
        const content = opening.slice(3).trim();
        if (content) commentLines.push(content);
        i++;
        while (i < lines.length) {
          const line = lines[i];
          if (line.trim().endsWith('"""')) {
            const last = line.trim().slice(0, -3).trim();
            if (last) commentLines.push(last);
            break;
          }
          commentLines.push(line.trim());
          i++;
        }
        return commentLines.join("\n").trim();
      }
    }
    // Hash comments
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#")) {
        commentLines.push(line.replace(/^#\s?/, ""));
      } else if (line.trim() === "" && commentLines.length === 0) {
      } else {
        break;
      }
    }
  } else if (SLASH_COMMENT_EXTS.has(ext)) {
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("//")) {
        commentLines.push(line.replace(/^\/\/\s?/, ""));
      } else if (line.trim() === "" && commentLines.length === 0) {
      } else {
        break;
      }
    }
  }

  return commentLines.join("\n").trim();
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
