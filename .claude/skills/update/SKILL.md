---
name: update
description: Safely pull upstream everclaw changes into a fork — backup, merge, migrate, validate
---

# /update — pull upstream changes into your fork

Safely merge upstream everclaw changes while preserving local customizations. Creates a backup, previews changes, resolves conflicts, runs new migrations, and validates.

## Instructions

Work through each phase in order. Use `TaskCreate` to track progress. Be autonomous: detect problems, fix them, only ask when a real choice is needed. Minimize token usage — use git commands for inspection, don't read files unnecessarily.

---

### Phase 1: Preflight

Run these checks in parallel:

1. **Clean working tree** — `git status --porcelain`. If dirty, stop and tell the user to commit or stash first. Do NOT offer to stash for them.

2. **Upstream remote** — `git remote get-url upstream 2>/dev/null`. If missing, add it:
   ```bash
   git remote add upstream https://github.com/marktoda/everclaw.git
   ```
   If the user's fork is from a different URL, use `AskUserQuestion` to confirm the upstream URL.

3. **Detect upstream branch** — Check `git branch -r | grep upstream/` for `main` or `master`. Default to `main`.

4. **Fetch upstream** — `git fetch upstream --prune`.

Report what was found.

---

### Phase 2: Backup

Create a safety net before any changes:

```bash
SHORT=$(git rev-parse --short HEAD)
TS=$(date +%Y%m%d-%H%M%S)
TAG="pre-update-${SHORT}-${TS}"
git branch "backup/${TAG}"
git tag "${TAG}"
```

Report the backup tag — this is the rollback point.

---

### Phase 3: Preview changes

Compute the merge base and show what's coming:

```bash
BASE=$(git merge-base HEAD upstream/main)
```

1. **Upstream commits since divergence:**
   ```bash
   git log --oneline $BASE..upstream/main
   ```

2. **Local commits since divergence:**
   ```bash
   git log --oneline $BASE..HEAD
   ```

3. **Changed files** — run `git diff --name-only $BASE..upstream/main` and categorize:
   - **Source** (`src/`): may conflict if user modified same files
   - **SQL migrations** (`sql/`): new migrations to apply
   - **Skills** (`skills/`): unlikely to conflict
   - **Scripts** (`scripts/`): unlikely to conflict
   - **Config** (`package.json`, `tsconfig.json`, `docker-compose.yml`, `Dockerfile`): needs review
   - **Docs** (`CLAUDE.md`, `README.md`, `docs/`): informational
   - **Other**: everything else

Present the summary, then use `AskUserQuestion`:

> How do you want to proceed?
> - **Full merge (Recommended)** — Merge all upstream changes
> - **Cherry-pick** — Select specific commits
> - **Abort** — Just view the changelog, don't change anything

If aborted, stop here.

---

### Phase 4: Dry-run conflict check

Before making real changes, test the merge:

```bash
git merge --no-commit --no-ff upstream/main 2>&1
```

Check for conflicts with `git diff --name-only --diff-filter=U`. Then abort the test merge:

```bash
git merge --abort
```

If conflicts were found, show them to the user and explain which files will need manual resolution. Ask if they want to continue.

---

### Phase 5: Execute the update

**Full merge:**
```bash
git merge upstream/main --no-edit
```

If conflicts occur:
- Open ONLY the conflicted files
- Resolve conflict markers, preserving local customizations over upstream where intent is unclear
- `git add` each resolved file
- `git commit --no-edit` to complete the merge

**Cherry-pick:**
- Show the upstream commit list
- Use `AskUserQuestion` to ask which commits (by hash)
- `git cherry-pick <hash1> <hash2> ...`
- Resolve conflicts per-commit if needed

---

### Phase 6: Detect and apply new SQL migrations

Check if any new SQL files were added upstream:

```bash
git diff --name-only --diff-filter=A $BASE..HEAD -- sql/
```

If new migrations exist:

1. List them in order (they are numbered: `001-`, `002-`, etc.)
2. Determine which are genuinely new (not already applied) — check the highest-numbered file that existed before the merge vs what exists now
3. Use `AskUserQuestion` to ask deployment method:
   > New SQL migrations detected. How is your database running?
   > - **Docker Compose** — Migrations run automatically on next restart
   > - **Bare metal** — Apply migrations now with psql

For bare metal, run each new migration in order:
```bash
psql "$DATABASE_URL" -f sql/<new-migration>.sql
```

For Docker Compose, note that migrations will apply on next container rebuild.

---

### Phase 7: Install dependencies

Check if `package.json` or `pnpm-lock.yaml` changed:

```bash
git diff --name-only $BASE..HEAD -- package.json pnpm-lock.yaml
```

If changed, run:
```bash
pnpm install
```

Verify it succeeds.

---

### Phase 8: Validate

Run in sequence:

1. **Type check:**
   ```bash
   npx tsc --noEmit
   ```

2. **Tests:**
   ```bash
   pnpm test
   ```

If either fails:
- Read the error output carefully
- If it's a merge-related issue (missing import, type mismatch from merged code), fix it
- Do NOT refactor or clean up unrelated code
- If you can't fix it, report the failure clearly and suggest the rollback command

---

### Phase 9: Breaking changes

Check if CHANGELOG.md was modified:

```bash
git diff ${TAG}..HEAD -- CHANGELOG.md
```

Look for lines starting with `[BREAKING]`. If found, display each one and explain what action the user needs to take.

---

### Phase 10: Summary

Report:
- Backup tag (rollback point)
- Number of upstream commits merged
- New SQL migrations (and whether they were applied)
- Dependencies updated (yes/no)
- Test results (pass/fail)
- Breaking changes (if any)

Provide the rollback command:
```bash
git reset --hard <backup-tag>
```

And restart instructions:
- **Docker Compose:** `docker compose down && docker compose up --build -d`
- **Bare metal:** Restart `node src/index.ts`

Done.
