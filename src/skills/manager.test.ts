import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listSkills, parseSkillFrontmatter } from "./manager.ts";

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
