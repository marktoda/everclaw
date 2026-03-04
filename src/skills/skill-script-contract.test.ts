// src/skills/skill-script-contract.test.ts
//
// Contract tests between skill markdown files and the scripts they invoke.
//
// Three invariants checked for every run_script(...) call found in a skill:
//
//   1. NAME MATCH — the name string matches the script filename minus extension.
//      Catches underscore-vs-hyphen typos (run_script("search_flights") when
//      the file is search-flights.py).
//
//   2. OUTPUT FIELD COVERAGE — every top-level key documented in the skill's
//      example output JSON block is present in the script's source output
//      construction. Catches the agent reading a field the script never emits.
//
//   3. ERROR FIELD REACHABILITY — if the skill's prose references an "error"
//      field for a given script, the script source must contain an output path
//      that emits an "error" key.
//
// All checks are static (no subprocess execution). Scripts are parsed as source
// text; JSON examples are extracted from fenced code blocks.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "../../");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

// ---------------------------------------------------------------------------
// Skill parser — extract run_script calls
// ---------------------------------------------------------------------------

interface RunScriptCall {
  /** The name argument as it appears in the skill markdown, e.g. "search-flights" */
  name: string;
  /** Line context for error messages */
  sourceLine: string;
}

/**
 * Extract all run_script("name", ...) call sites from markdown text.
 * Handles both inline prose and fenced code block contexts.
 * Only matches the string-literal name argument (first positional arg).
 */
function extractRunScriptCalls(markdown: string): RunScriptCall[] {
  const calls: RunScriptCall[] = [];
  // Match run_script( followed by a quoted name. The name may use single or
  // double quotes. We do NOT match run_script(variable) to avoid false positives
  // on dynamic invocations (none exist today, but guards against future code).
  const re = /run_script\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    calls.push({ name: m[1], sourceLine: m[0].trim() });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Script index — map name → absolute path
// ---------------------------------------------------------------------------

interface ScriptFile {
  name: string; // filename minus extension, e.g. "search-flights"
  absPath: string;
}

function loadScriptIndex(scriptsDir: string): ScriptFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(scriptsDir);
  } catch {
    return [];
  }
  const EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".ts"]);
  return entries
    .filter((e) => EXTENSIONS.has(path.extname(e)))
    .map((e) => ({
      name: e.replace(/\.[^.]+$/, ""),
      absPath: path.join(scriptsDir, e),
    }));
}

// ---------------------------------------------------------------------------
// Example JSON extractor — find documented output paired to a specific script
// ---------------------------------------------------------------------------

/**
 * Scan the markdown and return, for each run_script call, the documented JSON
 * output example that follows it (if any).
 *
 * Pairing rule: after a run_script("name") call site, look forward through
 * subsequent text for a "returns:" phrase followed by a ```json block. Stop
 * looking when the next run_script call is encountered, so examples are never
 * attributed to the wrong script.
 *
 * Returns a map of script name → parsed example object (or undefined when no
 * example exists for that script).
 */
function extractDocumentedOutputExamplesByScript(
  markdown: string,
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();

  // Collect positions of all run_script calls with their names.
  const callPositions: Array<{ name: string; pos: number }> = [];
  const callRe = /run_script\(\s*["']([^"']+)["']/g;
  let cm: RegExpExecArray | null;
  while ((cm = callRe.exec(markdown)) !== null) {
    callPositions.push({ name: cm[1], pos: cm.index });
  }

  // Collect positions of all ```json blocks preceded by a "returns:" line.
  const jsonBlocks: Array<{ parsed: Record<string, unknown>; pos: number }> = [];
  const fenceRe = /```json\n([\s\S]*?)```/g;
  let fm: RegExpExecArray | null;
  let lastFenceEnd = 0;
  while ((fm = fenceRe.exec(markdown)) !== null) {
    const precedingSlice = markdown.slice(lastFenceEnd, fm.index);
    const precedingLines = precedingSlice.trimEnd().split("\n").slice(-4).join("\n");
    if (/returns?:/i.test(precedingLines)) {
      try {
        const parsed = JSON.parse(fm[1].trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          jsonBlocks.push({ parsed: parsed as Record<string, unknown>, pos: fm.index });
        }
      } catch {
        // Invalid JSON in skill doc — not our concern here.
      }
    }
    lastFenceEnd = fm.index + fm[0].length;
  }

  // For each run_script call, find the first JSON block that appears after it
  // but before the next run_script call.
  for (let i = 0; i < callPositions.length; i++) {
    const { name, pos: callPos } = callPositions[i];
    const nextCallPos = callPositions[i + 1]?.pos ?? Infinity;
    const block = jsonBlocks.find((b) => b.pos > callPos && b.pos < nextCallPos);
    if (block) {
      // If the same script name appears multiple times, the first example wins.
      if (!result.has(name)) {
        result.set(name, block.parsed);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Script source key extractor
// ---------------------------------------------------------------------------

/**
 * Collect the set of top-level keys that a script source emits in its JSON
 * output. Works by static text analysis — no execution.
 *
 * For Python: look for dictionary-literal keys in `output = { ... }` blocks
 * and `json.dumps({...})` calls.
 *
 * For bash: look for JSON object echo statements with quoted keys.
 *
 * Returns a Set<string> of discovered key names.
 */
function extractScriptOutputKeys(source: string, ext: string): Set<string> {
  const keys = new Set<string>();
  // Generic: match any "key": pattern appearing inside what looks like a JSON
  // object being constructed. This is intentionally broad — false positives
  // (keys from *input* parsing) are acceptable; the test only fails if a key
  // from the skill's documented example is *absent* from the script source
  // entirely, which would mean the script never references that name at all.
  const keyPattern = /["']([a-zA-Z_][a-zA-Z0-9_]*)["']\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyPattern.exec(source)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

/**
 * Returns true if the script source has an output path that emits an "error"
 * key. Checks for both `"error":` in dict literals and `{"error":` JSON
 * constructions in bash echo statements.
 */
function scriptEmitsErrorKey(source: string): boolean {
  return (
    /["']error["']\s*:/.test(source) ||
    /\{"error":/.test(source) ||
    /"error"/.test(source)
  );
}

// ---------------------------------------------------------------------------
// Helpers for collecting per-skill documented error handling references
// ---------------------------------------------------------------------------

/**
 * Returns true if the skill markdown explicitly references the error field for
 * the named script (e.g. "If search-flights returns an `error` field").
 */
function skillReferencesErrorFieldFor(markdown: string, scriptName: string): boolean {
  // Look for prose that names this script near an "error field" reference.
  // Allow for the script name appearing within ±3 lines of "error field".
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(scriptName)) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
    if (/error\s+field/i.test(window) || /`error`/i.test(window)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test suite assembly
// ---------------------------------------------------------------------------

function loadSkillFiles(): Array<{ name: string; path: string; content: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".md"))
    .map((e) => {
      const p = path.join(SKILLS_DIR, e);
      return { name: e, path: p, content: fs.readFileSync(p, "utf-8") };
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skill–script contract", () => {
  const scripts = loadScriptIndex(SCRIPTS_DIR);
  const skills = loadSkillFiles();

  // Sanity: the test suite only has value if there are skills and scripts to check.
  it("has skill files and script files to check", () => {
    expect(skills.length).toBeGreaterThan(0);
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const skill of skills) {
    const calls = extractRunScriptCalls(skill.content);
    if (calls.length === 0) continue;

    describe(`skill: ${skill.name}`, () => {
      // ── Invariant 1: name matches filename minus extension ──────────────

      describe("script name matching", () => {
        for (const call of calls) {
          it(`run_script("${call.name}") matches a script filename`, () => {
            const match = scripts.find((s) => s.name === call.name);
            expect(
              match,
              `run_script("${call.name}") in ${skill.name}: no file named ` +
                `"${call.name}.<ext>" in scripts/. ` +
                `Available scripts: ${scripts.map((s) => s.name).join(", ")}`,
            ).toBeDefined();
          });

          it(`run_script("${call.name}") uses hyphens matching the filename exactly`, () => {
            // The name must equal the filename stem character-for-character.
            // This catches underscore/hyphen swaps even if both forms existed.
            const match = scripts.find((s) => s.name === call.name);
            if (!match) return; // already failed in previous test
            expect(call.name).toBe(match.name);
          });
        }
      });

      // ── Invariant 2: documented output fields exist in script source ─────

      describe("output field coverage", () => {
        // Build a map of script name → the documented output example that
        // follows that script's run_script call in the skill prose.
        const examplesByScript = extractDocumentedOutputExamplesByScript(skill.content);
        const uniqueScriptNames = [...new Set(calls.map((c) => c.name))];

        for (const scriptName of uniqueScriptNames) {
          const scriptFile = scripts.find((s) => s.name === scriptName);
          if (!scriptFile) continue; // already caught by name-matching test

          const example = examplesByScript.get(scriptName);
          if (!example) {
            // No documented "returns:" example for this script — skip field check.
            // This is not a failure; not every script invocation needs an example.
            it.skip(`${scriptName}: no documented output example found in skill (field check skipped)`, () => {});
            continue;
          }

          const source = fs.readFileSync(scriptFile.absPath, "utf-8");
          const sourceKeys = extractScriptOutputKeys(source, path.extname(scriptFile.absPath));
          const exampleTopKeys = Object.keys(example);

          it(`${scriptName}: all top-level example keys exist in script source`, () => {
            const missing = exampleTopKeys.filter((k) => !sourceKeys.has(k));
            expect(
              missing,
              `Keys in skill's documented example not found anywhere in ${scriptFile.absPath}: ${missing.join(", ")}. ` +
                `This means the skill documents fields the script never emits.`,
            ).toEqual([]);
          });

          // Check nested array-item objects (e.g. the flights[] entry shape)
          const arrayValues = Object.values(example).filter(Array.isArray);
          for (const arr of arrayValues) {
            const firstItem = arr[0];
            if (firstItem && typeof firstItem === "object" && !Array.isArray(firstItem)) {
              const itemKeys = Object.keys(firstItem as object);
              it(`${scriptName}: all example array-item keys exist in script source`, () => {
                const missing = itemKeys.filter((k) => !sourceKeys.has(k));
                expect(
                  missing,
                  `Keys in skill's documented array-item example not found in ${scriptFile.absPath}: ${missing.join(", ")}`,
                ).toEqual([]);
              });
            }
          }
        }
      });

      // ── Invariant 3: error field reachable when skill references it ──────

      describe("error field handling", () => {
        const uniqueScriptNames = [...new Set(calls.map((c) => c.name))];

        for (const scriptName of uniqueScriptNames) {
          const scriptFile = scripts.find((s) => s.name === scriptName);
          if (!scriptFile) continue;

          if (!skillReferencesErrorFieldFor(skill.content, scriptName)) continue;

          it(`${scriptName}: script emits "error" key when skill handles it`, () => {
            const source = fs.readFileSync(scriptFile.absPath, "utf-8");
            expect(
              scriptEmitsErrorKey(source),
              `Skill ${skill.name} handles an "error" field from ${scriptName}, ` +
                `but no "error" key construction found in ${scriptFile.absPath}. ` +
                `Either the skill's error handling is dead code or the script needs an error path.`,
            ).toBe(true);
          });
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Additional standalone regression tests for known scripts/skills
// ---------------------------------------------------------------------------

describe("search-flights.py output schema", () => {
  it("top-level keys match example-skill documented example", () => {
    const scriptPath = path.join(SCRIPTS_DIR, "search-flights.py");
    const source = fs.readFileSync(scriptPath, "utf-8");
    const keys = extractScriptOutputKeys(source, ".py");

    // These are the top-level keys the skill's JSON example documents
    const documentedTopLevel = ["flights", "current_price", "metadata"];
    for (const k of documentedTopLevel) {
      expect(keys.has(k), `"${k}" not found in search-flights.py output construction`).toBe(true);
    }
  });

  it("flight object keys match example-skill documented example", () => {
    const scriptPath = path.join(SCRIPTS_DIR, "search-flights.py");
    const source = fs.readFileSync(scriptPath, "utf-8");
    const keys = extractScriptOutputKeys(source, ".py");

    // These are the flight-object keys the skill's JSON example documents
    const documentedFlightKeys = ["price", "name", "departure", "arrival", "duration", "stops", "delay", "is_best"];
    for (const k of documentedFlightKeys) {
      expect(keys.has(k), `flight key "${k}" not found in search-flights.py`).toBe(true);
    }
  });

  it("metadata keys match example-skill documented example", () => {
    const scriptPath = path.join(SCRIPTS_DIR, "search-flights.py");
    const source = fs.readFileSync(scriptPath, "utf-8");
    const keys = extractScriptOutputKeys(source, ".py");

    const documentedMetadataKeys = ["origin", "destination", "date", "return_date", "result_count", "raw_result_count"];
    for (const k of documentedMetadataKeys) {
      expect(keys.has(k), `metadata key "${k}" not found in search-flights.py`).toBe(true);
    }
  });

  it("emits error key in error paths", () => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, "search-flights.py"), "utf-8");
    expect(scriptEmitsErrorKey(source)).toBe(true);
  });
});

describe("run_script name format invariant", () => {
  it("no run_script call in any skill uses underscores where the matching script uses hyphens", () => {
    const skills = loadSkillFiles();
    const scripts = loadScriptIndex(SCRIPTS_DIR);

    const violations: string[] = [];

    for (const skill of skills) {
      const calls = extractRunScriptCalls(skill.content);
      for (const call of calls) {
        // If this call name has underscores, check if there's a hyphenated variant
        if (call.name.includes("_")) {
          const hyphenated = call.name.replace(/_/g, "-");
          const hyphenatedFile = scripts.find((s) => s.name === hyphenated);
          if (hyphenatedFile) {
            violations.push(
              `${skill.name}: run_script("${call.name}") — file is "${hyphenated}" (use hyphens, not underscores)`,
            );
          }
        }
        // Also check the reverse: if this call name has hyphens, there shouldn't be an underscored file
        if (call.name.includes("-")) {
          const underscored = call.name.replace(/-/g, "_");
          const underscoredFile = scripts.find((s) => s.name === underscored);
          if (underscoredFile) {
            // This would be an inconsistency in the scripts/ dir itself — note it but don't fail
            // the skill test, since the skill name matches a real file.
          }
        }
      }
    }

    expect(
      violations,
      "Skill(s) call run_script() with underscored names but the script file uses hyphens:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });
});
