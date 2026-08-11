---
name: figma-rename
description: Rename design tokens and components to a naming convention across Figma AND the codebase in one reviewable change, batch by batch. Use when asked to rename tokens or components, apply a naming convention to a design system, suggest names for unnamed variables, or when a rename in Figma has left code referring to names that no longer exist.
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

The everyday loop, once a project is set up — one batch, one commit:

```bash
node "$S/emit-figma.mjs" --batch <id>     # → paste into use_figma
node "$S/apply-code.mjs" --batch <id> --write
node "$S/check.mjs" --after
```

`$S` is this skill's `scripts/` directory; resolving it correctly is the first
thing the manual covers, and the most common way a first run fails.

Deeper detail lives in `./references/`, loaded on demand:

| file | when |
|---|---|
| [`references/naming-convention.md`](references/naming-convention.md) | deciding the target convention, and writing it as rules |
| [`references/suggest-engine.md`](references/suggest-engine.md) | naming a variable from its value, and what it refuses to guess |
| [`references/inventory.md`](references/inventory.md) | reading what exists out of Figma (`use_figma` read scripts) |
| [`references/figma-apply.md`](references/figma-apply.md) | applying a batch, atomicity, rename chains, rollback |
| [`references/components.md`](references/components.md) | components, variant properties, inner layers, Code Connect |
| [`references/code-sync.md`](references/code-sync.md) | which spellings move, generated vs hand-written code, verifying |
| [`references/rename-map.md`](references/rename-map.md) | the `rename-map.json` contract |
