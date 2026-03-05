# Notes Tiered Storage Design

## Problem

All notes in `data/notes/` are loaded in full into every system prompt. No size limits, no categorization. As the agent accumulates notes, context consumption grows unbounded. There is no distinction between critical always-on context (profile, preferences) and reference material (research, guides) or scratch data (drafts, intermediate results).

## Design: Three-Tier Notes

Three subdirectories under `data/notes/`:

| Directory | Prompt Behavior | Use Case |
|-----------|----------------|----------|
| `data/notes/pinned/` | Full content loaded every turn | Profile, preferences, critical context |
| `data/notes/` (root) | Filenames listed, content on demand | Research, guides, reference material |
| `data/notes/temp/` | Invisible — not listed or loaded | Scratch space, drafts, intermediate work |

### Pinned Notes (`data/notes/pinned/`)

- Read by `readPinnedNotes` (replaces `readAllNotes`).
- Injected as `## Your Notes` in system prompt with `### filename` sub-headers.
- **Size cap**: configurable, default ~8KB. If exceeded, content is truncated with a warning telling the agent to move less-critical notes out of pinned.
- Only `.md` files at the top level of `pinned/` (not recursive).

### Available Notes (`data/notes/*.md`)

- Listed by `listAvailableNotes` — returns filenames from root level only.
- Shown in prompt as `## Available Notes` with filenames like `- data/notes/slc-travel-guide.md`.
- Agent loads content on demand via `read_file`.
- Section omitted if no available notes exist.

### Temp Notes (`data/notes/temp/`)

- Not listed in the prompt. Not loaded.
- Agent reads/writes explicitly using `read_file` / `write_file`.
- For workflow scratch data, drafts, intermediate results.

## Changes

### `src/agent/loop.ts`

- Rename `readAllNotes` → `readPinnedNotes`: reads only `data/notes/pinned/*.md`.
- Add `listAvailableNotes`: returns sorted filenames from `data/notes/*.md` (root-level only).
- Both values passed through context to `buildSystemPrompt`.

### `src/agent/prompt.ts`

- `## Your Notes` section: pinned note content only. Truncated with warning if over budget.
- New `## Available Notes` section: list of filenames from root-level notes.
- Update tool instructions:
  ```
  - **data/notes/pinned/**: Critical notes loaded every message. Keep small.
  - **data/notes/**: Reference notes listed by name, loaded on demand via read_file.
  - **data/notes/temp/**: Scratch space. Not listed or loaded.
  ```

### `src/agent/tools/state.ts`

- `get_status` reports: `Pinned notes: N files (X KB), Available notes: M files`.

### Migration

Move existing `data/notes/*.md` to `data/notes/pinned/`. One-time manual step.

## What Does NOT Change

- `DIR_MAPPINGS` in `files.ts` — `data/notes/` prefix already covers all subdirectories.
- `DIR_HOOKS` — notes still have no side effects on write/delete.
- State store (`get_state`/`set_state`) — unchanged, still serves workflow data.
- File tools — no new tools needed. Agent uses existing `read_file`, `write_file`, `delete_file`.
