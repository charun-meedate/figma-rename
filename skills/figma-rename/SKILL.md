---
name: figma-rename
description: Rename design tokens and components to a shared naming standard across Figma AND the codebase in one reviewable change, batch by batch, then hand the names to figma-token-export. Presets (`extends`) let many projects share one standard. Suggests names from what a thing IS — a colour's value, a component's structure — with a stated reason and confidence. Use when asked to rename tokens or components, apply or share a naming convention or SSOT across projects, make a Figma file match the team standard, name unnamed variables or components, or when a rename in Figma has left code referring to names that no longer exist.
---

# Figma rename → code, in one change

**Read `./figma-rename.md` in full before doing anything else.** It is the
operating manual: the artefacts, the batch loop, what is validated before
anything is touched, and how to roll a batch back. Acting on the summary below
alone produces a half-applied rename, which is worse than not starting.

The whole skill exists because of one asymmetry:

```
Figma binds by ID   →  renaming there breaks nothing
code binds by NAME  →  renaming there breaks everything that referenced it
```

So a rename is never "a rename in Figma". It is one change that has to land on
both sides together, batch by batch:

```
inventory ──plan──▶ rename-map.json ──┬─▶ use_figma        (Figma)
  (read Figma)      (reviewed, committed)  └─▶ apply-code.mjs  (codebase)
```

The everyday loop, once a project is set up — one batch, one commit. Every step
is gated: nothing ships undecided, and nothing reaches code before Figma.

```bash
node "$S/plan.mjs"                                  # propose (merges with what exists)
node "$S/review.mjs" status                         # decide — the only writer of decisions
node "$S/check.mjs"                                 # refuse before touching anything
node "$S/emit-figma.mjs" --batch <id>               # → run in use_figma
node "$S/review.mjs" mark <id> --figma-applied
#   re-capture dumps, then regenerate tokens
node "$S/apply-code.mjs" --batch <id> --write
node "$S/check.mjs" --after
node "$S/review.mjs" mark <id> --applied            # then commit
```

`$S` is this skill's `scripts/` directory; resolving it correctly is the first
thing the manual covers, and the most common way a first run fails.

Deeper detail lives in `./references/`, loaded on demand:

| file | when |
|---|---|
| [`presets/`](presets/) | the shared standards (`aurora`, `starter`) a project `extends` |
| [`references/naming-convention.md`](references/naming-convention.md) | deciding the target convention, writing it as rules, and sharing it |
| [`references/suggest-engine.md`](references/suggest-engine.md) | naming a variable from its value, and what it refuses to guess |
| [`references/inventory.md`](references/inventory.md) | reading what exists out of Figma (`use_figma` read scripts) |
| [`references/figma-apply.md`](references/figma-apply.md) | applying a batch, atomicity, rename chains, rollback |
| [`references/components.md`](references/components.md) | components: the structural classifier, variant properties, inner layers, Code Connect |
| [`references/code-sync.md`](references/code-sync.md) | which spellings move, generated vs hand-written code, verifying |
| [`references/rename-map.md`](references/rename-map.md) | the `rename-map.json` contract |
