import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".ts"]);

export function runScript(
  scriptPath: string,
  input: string,
  timeoutSeconds: number,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      scriptPath,
      [],
      {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        env: env ? { ...process.env, ...env } : undefined,
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

export async function listScripts(
  scriptsDir: string,
): Promise<Array<{ name: string; path: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(scriptsDir);
  } catch {
    return [];
  }

  const scripts: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    const ext = path.extname(entry);
    if (!SCRIPT_EXTENSIONS.has(ext)) continue;
    scripts.push({
      name: entry.replace(/\.[^.]+$/, ""),
      path: path.join(scriptsDir, entry),
    });
  }
  return scripts;
}
