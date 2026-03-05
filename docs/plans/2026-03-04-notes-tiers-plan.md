# Notes Tiered Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split notes into three tiers (pinned/available/temp) so only critical notes consume context, while reference material is available on demand.

**Architecture:** `readAllNotes` is replaced by `readPinnedNotes` (reads `data/notes/pinned/*.md`) and `listAvailableNotes` (lists `data/notes/*.md` filenames). The system prompt shows pinned content in full and available notes as a filename list. A configurable size cap prevents pinned notes from consuming unbounded context. `data/notes/temp/` exists as invisible scratch space.

**Tech Stack:** TypeScript, vitest, Node.js fs/promises

---

### Task 1: Replace `readAllNotes` with `readPinnedNotes` and `listAvailableNotes`

**Files:**
- Modify: `src/agent/loop.ts:24-28` (Dirs interface), `src/agent/loop.ts:44-60` (readAllNotes function), `src/agent/loop.ts:71-78` (load-context step), `src/agent/loop.ts:83-96` (buildSystemPrompt call)
- Modify: `src/agent/prompt.ts:1-7` (PromptContext), `src/agent/prompt.ts:118-120` (notes injection)
- Modify: `src/agent/prompt.test.ts`

**Step 1: Write the failing tests**

Add these tests to `src/agent/prompt.test.ts`:

```typescript
it("includes pinned notes in Your Notes section", () => {
  const p = buildSystemPrompt({
    pinnedNotes: "Name: Alice",
    availableNotes: [],
    skills: [],
    tools: [],
  });
  expect(p).toContain("## Your Notes");
  expect(p).toContain("Name: Alice");
});

it("lists available notes by filename", () => {
  const p = buildSystemPrompt({
    pinnedNotes: "",
    availableNotes: ["slc-travel-guide.md", "research.md"],
    skills: [],
    tools: [],
  });
  expect(p).toContain("## Available Notes");
  expect(p).toContain("- data/notes/slc-travel-guide.md");
  expect(p).toContain("- data/notes/research.md");
});

it("omits Available Notes section when empty", () => {
  const p = buildSystemPrompt({
    pinnedNotes: "",
    availableNotes: [],
    skills: [],
    tools: [],
  });
  expect(p).not.toContain("Available Notes");
});

it("shows both pinned and available notes", () => {
  const p = buildSystemPrompt({
    pinnedNotes: "Name: Alice",
    availableNotes: ["guide.md"],
    skills: [],
    tools: [],
  });
  expect(p).toContain("## Your Notes");
  expect(p).toContain("Name: Alice");
  expect(p).toContain("## Available Notes");
  expect(p).toContain("data/notes/guide.md");
});

it("truncates pinned notes over budget with warning", () => {
  const longNotes = "x".repeat(10000);
  const p = buildSystemPrompt({
    pinnedNotes: longNotes,
    availableNotes: [],
    skills: [],
    tools: [],
    pinnedNotesBudget: 8192,
  });
  expect(p).toContain("## Your Notes");
  expect(p).not.toContain("x".repeat(10000));
  expect(p).toContain("pinned notes exceed");
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/agent/prompt.test.ts`
Expected: FAIL — `notes` property doesn't match new interface

**Step 3: Update PromptContext and buildSystemPrompt**

In `src/agent/prompt.ts`, replace the `PromptContext` interface and notes injection:

```typescript
export interface PromptContext {
  pinnedNotes: string;
  availableNotes: string[];
  skills: Array<{ name: string; description: string; schedule?: string }>;
  tools: Array<{ name: string; description?: string }>;
  mcpServers?: Array<{ name: string; description?: string }>;
  extraDirs?: Array<{ name: string; mode: "ro" | "rw"; absPath: string }>;
  pinnedNotesBudget?: number;
}
```

Default budget constant at the top of the file:

```typescript
const DEFAULT_PINNED_NOTES_BUDGET = 8192;
```

Replace the notes block instruction (line 19-20) with:

```
- **data/notes/pinned/**: Critical notes loaded every message. Keep small — profile, preferences, key context.
- **data/notes/**: Reference notes. Listed by name in your prompt but not auto-loaded. Use read_file when relevant.
- **data/notes/temp/**: Scratch space. Not listed or loaded. Use for drafts and intermediate work.
```

Replace the notes injection (lines 118-120) with:

```typescript
const budget = ctx.pinnedNotesBudget ?? DEFAULT_PINNED_NOTES_BUDGET;
if (ctx.pinnedNotes.trim()) {
  if (ctx.pinnedNotes.length > budget) {
    parts.push(
      `## Your Notes\n\n${ctx.pinnedNotes.slice(0, budget)}\n\n` +
        `(pinned notes exceed ${budget} char limit — move less-critical notes to data/notes/)`,
    );
  } else {
    parts.push(`## Your Notes\n\n${ctx.pinnedNotes}`);
  }
}

if (ctx.availableNotes.length > 0) {
  const list = ctx.availableNotes.map((f) => `- data/notes/${f}`).join("\n");
  parts.push(`## Available Notes\n\nReference notes — use read_file to load when relevant.\n\n${list}`);
}
```

**Step 4: Update existing prompt tests**

Update all existing tests that pass `notes:` to use `pinnedNotes:` and `availableNotes: []`. For example:

```typescript
// Before:
buildSystemPrompt({ notes: "", skills: [], tools: [] });
// After:
buildSystemPrompt({ pinnedNotes: "", availableNotes: [], skills: [], tools: [] });
```

The "includes notes" test becomes:

```typescript
it("includes pinned notes", () => {
  const p = buildSystemPrompt({ pinnedNotes: "Name: Alice", availableNotes: [], skills: [], tools: [] });
  expect(p).toContain("Name: Alice");
});
```

**Step 5: Run tests to verify they pass**

Run: `pnpm test src/agent/prompt.test.ts`
Expected: PASS

**Step 6: Update `readAllNotes` → `readPinnedNotes` and add `listAvailableNotes` in loop.ts**

In `src/agent/loop.ts`, replace `readAllNotes` (lines 44-60) with two functions:

```typescript
/** Read all .md files in the pinned notes directory and concatenate their contents. */
async function readPinnedNotes(notesDir: string): Promise<string> {
  const pinnedDir = path.join(notesDir, "pinned");
  let entries: string[];
  try {
    entries = await fs.readdir(pinnedDir);
  } catch {
    return "";
  }
  const mdEntries = entries.filter((e) => e.endsWith(".md")).sort();
  const contents = await Promise.all(
    mdEntries.map((entry) => fs.readFile(path.join(pinnedDir, entry), "utf-8").catch(() => "")),
  );
  return contents
    .map((content, i) => (content.trim() ? `### ${mdEntries[i]}\n\n${content}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** List .md filenames in the root notes directory (not recursive, excludes subdirs). */
async function listAvailableNotes(notesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(notesDir);
  } catch {
    return [];
  }
  // Only top-level .md files — filter out directories by checking for extension
  return entries.filter((e) => e.endsWith(".md")).sort();
}
```

Update the `load-context` step (lines 71-78) to call both:

```typescript
const context = await ctx.step("load-context", async () => {
  const [pinnedNotes, availableNotes, history, skills, tools] = await Promise.all([
    readPinnedNotes(deps.dirs.notes),
    listAvailableNotes(deps.dirs.notes),
    getRecentMessages(deps.pool, recipientId, deps.maxHistory),
    listSkills(deps.dirs.skills),
    listScripts(deps.dirs.scripts),
  ]);
  return { pinnedNotes, availableNotes, history, skills, tools };
});
```

Update the `buildSystemPrompt` call (lines 83-96):

```typescript
const systemPrompt = buildSystemPrompt({
  pinnedNotes: context.pinnedNotes as string,
  availableNotes: context.availableNotes as string[],
  skills: (context.skills as SkillSummary[]).map((s) => ({
    name: s.name,
    description: s.description,
    schedule: s.schedule,
  })),
  tools: (context.tools as ScriptEntry[]).map((t) => ({
    name: t.name,
    description: t.description,
  })),
  mcpServers: deps.mcpSummaries,
  extraDirs: deps.extraDirs,
});
```

**Step 7: Update the loop.test.ts mock for readdir**

The mock at line 28-31 of `loop.test.ts` currently mocks `fs/promises.readdir` to reject (simulating no notes dir). This still works because `readPinnedNotes` catches the error and returns `""`. No change needed to this mock.

However, if `buildSystemPrompt` is called (it's mocked to return `"system-prompt"`), verify it's now called with the new interface shape. Add an assertion to the first test:

```typescript
expect(buildSystemPrompt).toHaveBeenCalledWith(
  expect.objectContaining({
    pinnedNotes: "",
    availableNotes: [],
  }),
);
```

**Step 8: Run full test suite**

Run: `pnpm test`
Expected: PASS (all tests)

Run: `npx tsc --noEmit`
Expected: clean

**Step 9: Commit**

```bash
git add src/agent/loop.ts src/agent/prompt.ts src/agent/prompt.test.ts src/agent/loop.test.ts
git commit -m "feat: split notes into pinned/available tiers with size cap"
```

---

### Task 2: Update `get_status` to report pinned and available note counts

**Files:**
- Modify: `src/agent/tools/state.ts:49-51`
- Modify: `src/agent/tools/registry.test.ts` (the get_status test)

**Step 1: Write the failing test**

In `src/agent/tools/registry.test.ts`, find the `get_status` test and update the expected output to match the new format. The test setup needs a `pinned/` subdirectory. If the test uses a temp dir, create `pinned/` inside it.

Find the existing `get_status` test (search for `get_status`) and update the expected output assertion to expect:

```
Pinned notes: 0 files
Available notes: 0 files
```

instead of:

```
Notes: 0 files
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/agent/tools/registry.test.ts -t "get_status"`
Expected: FAIL — output still says "Notes: X files"

**Step 3: Update get_status implementation**

In `src/agent/tools/state.ts`, replace lines 49-51:

```typescript
// Before:
`Notes: ${(await fs.readdir(deps.dirs.notes).catch(() => [])).length} files`,

// After:
`Pinned notes: ${(await fs.readdir(path.join(deps.dirs.notes, "pinned")).catch(() => [])).filter((e: string) => e.endsWith(".md")).length} files`,
`Available notes: ${(await fs.readdir(deps.dirs.notes).catch(() => [])).filter((e: string) => e.endsWith(".md")).length} files`,
```

Add `import * as path from "node:path";` at the top if not already imported.

**Step 4: Run tests**

Run: `pnpm test src/agent/tools/registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tools/state.ts src/agent/tools/registry.test.ts
git commit -m "feat: update get_status to report pinned and available note counts"
```

---

### Task 3: Migrate existing notes and update docs

**Files:**
- Move: `data/notes/*.md` → `data/notes/pinned/`
- Modify: `CLAUDE.md`

**Step 1: Create pinned directory and move existing notes**

```bash
mkdir -p data/notes/pinned data/notes/temp
mv data/notes/profile.md data/notes/pinned/
mv data/notes/workflows.md data/notes/pinned/
mv data/notes/slc-travel-guide.md data/notes/pinned/
```

**Step 2: Add .gitkeep to temp directory**

```bash
touch data/notes/temp/.gitkeep
```

**Step 3: Update CLAUDE.md**

Find the notes-related section and update it to describe the three-tier system. The key sections to update:

In the Architecture tree, change `data/notes/` to show the subdirectories:

```
data/notes/             Agent-writable persistent notes
  pinned/               Critical notes loaded every message (profile, preferences)
  temp/                 Scratch space (not listed in prompt, not auto-loaded)
```

In the "Key Patterns" section, add or update the notes description:

```
**Notes tiers.** Notes are split into three tiers under `data/notes/`: `pinned/` (full content loaded into every system prompt, size-capped at 8KB), root-level `.md` files (listed by filename in the prompt, loaded on demand via `read_file`), and `temp/` (invisible scratch space, not listed or loaded). The agent moves notes between tiers using `write_file` and `delete_file`.
```

**Step 4: Run full test suite to verify nothing broke**

Run: `pnpm test`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: clean

**Step 5: Commit**

```bash
git add data/notes/ CLAUDE.md
git commit -m "feat: migrate existing notes to pinned/ and update docs"
```

---

### Task 4: Final verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 3: Lint check**

Run: `npx @biomejs/biome check src/`
Expected: Clean (or only pre-existing issues)

**Step 4: Manual smoke test**

Verify the directory structure:

```bash
ls data/notes/pinned/     # should show profile.md, workflows.md, slc-travel-guide.md
ls data/notes/            # should show pinned/ and temp/ directories, no .md files
ls data/notes/temp/       # should show .gitkeep only
```

**Step 5: Verify prompt output**

Write a quick throwaway script or add a temporary test:

```typescript
import { buildSystemPrompt } from "./src/agent/prompt.ts";
const p = buildSystemPrompt({
  pinnedNotes: "### profile.md\n\nName: Alice",
  availableNotes: ["slc-travel-guide.md"],
  skills: [],
  tools: [],
});
console.log(p);
```

Verify the output contains:
- `## Your Notes` with `Name: Alice`
- `## Available Notes` with `data/notes/slc-travel-guide.md`
- Updated tool instructions mentioning `data/notes/pinned/`, `data/notes/`, and `data/notes/temp/`
