import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listSkills, parseSkillFrontmatter, syncSchedules } from "./manager.ts";

describe("skill manager", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-")); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it("returns empty list for empty dir", async () => {
    expect(await listSkills(tmpDir)).toEqual([]);
  });

  it("lists .md files as skills", async () => {
    fs.writeFileSync(path.join(tmpDir, "foo.md"), "---\nname: foo\n---\n# Foo");
    fs.writeFileSync(path.join(tmpDir, "bar.md"), "---\nname: bar\n---\n# Bar");
    fs.writeFileSync(path.join(tmpDir, "not-a-skill.txt"), "ignore me");
    const skills = await listSkills(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.name).sort()).toEqual(["bar", "foo"]);
  });

  it("parses frontmatter", () => {
    const fm = parseSkillFrontmatter("---\nname: test\ndescription: Desc\nschedule: \"0 9 * * *\"\n---\n# Body");
    expect(fm.name).toBe("test");
    expect(fm.description).toBe("Desc");
    expect(fm.schedule).toBe("0 9 * * *");
  });

  it("handles missing frontmatter", () => {
    const fm = parseSkillFrontmatter("# Just a heading\nSome text");
    expect(fm.name).toBeUndefined();
  });
});

describe("syncSchedules", () => {
  let tmpDir: string;

  function makeAbsurd(existingSchedules: Array<{ scheduleName: string; scheduleExpr: string }> = []) {
    return {
      listSchedules: vi.fn().mockResolvedValue(existingSchedules),
      createSchedule: vi.fn().mockResolvedValue(undefined),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-")); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it("creates a schedule for a skill with a schedule field", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "morning.md"),
      "---\nname: morning\nschedule: 0 9 * * *\n---\nDo morning stuff.",
    );
    const absurd = makeAbsurd();

    await syncSchedules(absurd, tmpDir);

    expect(absurd.createSchedule).toHaveBeenCalledOnce();
    expect(absurd.createSchedule).toHaveBeenCalledWith(
      "skill:morning",
      "execute-skill",
      "0 9 * * *",
      { params: { skillName: "morning" } },
    );
    expect(absurd.deleteSchedule).not.toHaveBeenCalled();
  });

  it("skips skills without a schedule field", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "manual.md"),
      "---\nname: manual\ndescription: No schedule\n---\nManual only.",
    );
    const absurd = makeAbsurd();

    await syncSchedules(absurd, tmpDir);

    expect(absurd.createSchedule).not.toHaveBeenCalled();
    expect(absurd.deleteSchedule).not.toHaveBeenCalled();
  });

  it("deletes orphaned schedules with no matching skill file", async () => {
    // No skill files, but an existing schedule
    const absurd = makeAbsurd([
      { scheduleName: "skill:deleted-skill", scheduleExpr: "0 9 * * *" },
    ]);

    await syncSchedules(absurd, tmpDir);

    expect(absurd.deleteSchedule).toHaveBeenCalledOnce();
    expect(absurd.deleteSchedule).toHaveBeenCalledWith("skill:deleted-skill");
    expect(absurd.createSchedule).not.toHaveBeenCalled();
  });

  it("does not delete non-skill schedules", async () => {
    const absurd = makeAbsurd([
      { scheduleName: "other:custom", scheduleExpr: "* * * * *" },
    ]);

    await syncSchedules(absurd, tmpDir);

    // "other:custom" should not be touched — it's not prefixed with "skill:"
    expect(absurd.deleteSchedule).not.toHaveBeenCalled();
  });

  it("updates a schedule when the expression changes", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daily.md"),
      "---\nname: daily\nschedule: 0 10 * * *\n---\nNew time.",
    );
    const absurd = makeAbsurd([
      { scheduleName: "skill:daily", scheduleExpr: "0 9 * * *" },
    ]);

    await syncSchedules(absurd, tmpDir);

    // Should delete the old one, then create with new expression
    expect(absurd.deleteSchedule).toHaveBeenCalledWith("skill:daily");
    expect(absurd.createSchedule).toHaveBeenCalledWith(
      "skill:daily",
      "execute-skill",
      "0 10 * * *",
      { params: { skillName: "daily" } },
    );
  });

  it("does not recreate a schedule when expression is unchanged", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "stable.md"),
      "---\nname: stable\nschedule: 0 9 * * *\n---\nSame.",
    );
    const absurd = makeAbsurd([
      { scheduleName: "skill:stable", scheduleExpr: "0 9 * * *" },
    ]);

    await syncSchedules(absurd, tmpDir);

    expect(absurd.createSchedule).not.toHaveBeenCalled();
    expect(absurd.deleteSchedule).not.toHaveBeenCalled();
  });

  it("handles create + delete in the same sync", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "new-skill.md"),
      "---\nname: new-skill\nschedule: 0 8 * * *\n---\nNew.",
    );
    const absurd = makeAbsurd([
      { scheduleName: "skill:old-skill", scheduleExpr: "0 9 * * *" },
    ]);

    await syncSchedules(absurd, tmpDir);

    expect(absurd.createSchedule).toHaveBeenCalledWith(
      "skill:new-skill",
      "execute-skill",
      "0 8 * * *",
      { params: { skillName: "new-skill" } },
    );
    expect(absurd.deleteSchedule).toHaveBeenCalledWith("skill:old-skill");
  });

  it("handles empty skills directory gracefully", async () => {
    const absurd = makeAbsurd();

    await syncSchedules(absurd, tmpDir);

    expect(absurd.createSchedule).not.toHaveBeenCalled();
    expect(absurd.deleteSchedule).not.toHaveBeenCalled();
  });
});
