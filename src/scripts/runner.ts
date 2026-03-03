import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".ts"]);

export function runScript(
  scriptPath: string,
  input: string,
  timeoutSeconds: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      scriptPath,
      [],
      {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024, // 1MB
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

export async function listTools(
  toolsDir: string,
): Promise<Array<{ name: string; path: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(toolsDir);
  } catch {
    return [];
  }

  const tools: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    const ext = path.extname(entry);
    if (!SCRIPT_EXTENSIONS.has(ext)) continue;
    tools.push({
      name: entry.replace(/\.[^.]+$/, ""),
      path: path.join(toolsDir, entry),
    });
  }
  return tools;
}
