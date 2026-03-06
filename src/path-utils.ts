import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Check that a resolved path stays within a base directory. */
export function isContainedIn(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Verify that the real (symlink-resolved) path stays within the base directory. */
export async function validateRealPath(abs: string, baseDir: string): Promise<string | null> {
  try {
    const real = await fs.realpath(abs);
    if (!isContainedIn(real, baseDir)) return "Error: path escapes allowed directory via symlink";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist — check nearest existing ancestor
      try {
        const realParent = await fs.realpath(path.dirname(abs));
        if (!isContainedIn(realParent, baseDir))
          return "Error: path escapes allowed directory via symlink";
      } catch {
        // Parent doesn't exist either — will be created, safe
      }
    } else {
      throw err;
    }
  }
  return null;
}
