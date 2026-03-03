import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Absurd } from "absurd-sdk";
import { stripQuotes } from "../config.ts";

export interface SkillMeta {
  name?: string;
  description?: string;
  schedule?: string;
  [key: string]: string | undefined;
}

export interface SkillSummary {
  name: string;
  description: string;
  schedule?: string;
  filename: string;
}

export function parseSkillFrontmatter(content: string): SkillMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta: SkillMeta = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.substring(0, colon).trim();
    let val = line.substring(colon + 1).trim();
    val = stripQuotes(val);
    meta[key] = val;
  }
  return meta;
}

export async function listSkills(skillsDir: string): Promise<SkillSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    return [];
  }

  const mdEntries = entries.filter((e) => e.endsWith(".md"));
  const skills = await Promise.all(
    mdEntries.map(async (entry) => {
      const content = await fs.readFile(path.join(skillsDir, entry), "utf-8");
      const meta = parseSkillFrontmatter(content);
      return {
        name: meta.name ?? entry.replace(/\.md$/, ""),
        description: meta.description ?? "",
        schedule: meta.schedule,
        filename: entry,
      };
    }),
  );
  return skills;
}

/**
 * Reconcile skill-based schedules with Absurd's schedule registry.
 * Compares skill files' frontmatter against existing schedules and
 * creates/updates/deletes to match. Called on startup and after any
 * file write or delete in the skills directory.
 */
export async function syncSchedules(
  absurd: Absurd,
  skillsDir: string,
  defaultRecipientId: string,
): Promise<void> {
  const skills = await listSkills(skillsDir);
  const schedules = await absurd.listSchedules();

  const existing = new Map(
    schedules
      .filter(s => s.scheduleName.startsWith("skill:"))
      .map(s => [s.scheduleName, s]),
  );

  const desired = new Map(
    skills
      .filter(s => s.schedule)
      .map(s => [
        `skill:${s.name}`,
        { skillName: s.name, schedule: s.schedule!, recipientId: defaultRecipientId },
      ]),
  );

  // Create or update
  for (const [name, skill] of desired) {
    const curr = existing.get(name);
    if (!curr || curr.scheduleExpr !== skill.schedule) {
      if (curr) {
        try { await absurd.deleteSchedule(name); } catch { /* ok */ }
      }
      await absurd.createSchedule(name, "execute-skill", skill.schedule, {
        params: { skillName: skill.skillName, recipientId: skill.recipientId },
      });
    }
  }

  // Delete orphans
  for (const [name] of existing) {
    if (!desired.has(name)) {
      try { await absurd.deleteSchedule(name); } catch { /* ok */ }
    }
  }
}
