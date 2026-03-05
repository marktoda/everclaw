import * as path from "node:path";

/** Resolve an adapter-specific auth directory under data/auth/. */
export function authDir(adapterName: string): string {
  return path.resolve(`data/auth/${adapterName}`);
}
