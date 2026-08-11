# Applying a batch in Figma


## Contents

- Why the script is generated
- Per-kind API
- What renaming does and does not break
- Library (remote) entities
- Rollback
- Verifying a batch landed

---

```bash
node "$S/emit-figma.mjs" --batch variable-color-semantic
```

prints a script; you pass it to `use_figma` with the file key. Load the
`figma-use` skill first — it is a mandatory prerequisite of that tool, and
skipping it causes failures that look like Figma bugs.

## Why the script is generated

A batch is 20–40 id/name pairs. Hand-transcribing one id wrong renames a
different variable and reports success — there is no error, because the id is
valid. The generator also bakes in three behaviours that are easy to leave out
when writing the script under time pressure.

### 1. Validate everything, then mutate

```js
const resolved = [], problems = [];
for (const [id, expected, to] of PAIRS) {
  const target = await figma.variables.getVariableByIdAsync(id);
  if (!target) { problems.push({ id, error: "not found in this file" }); continue; }
  if (target.name !== expected) { problems.push({ id, error: "…" }); continue; }
  resolved.push({ target, from: target.name, to });
}
if (problems.length) throw new Error("Refusing to rename — …");
for (const item of resolved) item.target.name = item.to;
```

The name check is the important half. It fails when someone renamed things in
Figma between the inventory capture and now — the exact situation where blindly
applying the map renames the wrong entities.

`use_figma` is atomic: **a script that throws is not executed at all**, so a
rejected batch leaves the file byte-identical. That is what makes "throw on any
problem" the right response rather than "skip the bad ones and carry on".

### 2. Stage rename chains

`a → b` where something else is `b → c` cannot be applied in a single sweep: by
the time `a` becomes `b`, `b` is either taken or has already moved. The
generator detects this and stages through temporary names:

```js
resolved.forEach((item, i) => { item.target.name = "__rn_tmp_" + i; });
for (const item of resolved) item.target.name = item.to;
```

`check.mjs` reports chains as a warning so the behaviour is visible, not as an
error — there is nothing to fix.

If a run is ever interrupted mid-stage, the file contains names starting with
`__rn_tmp_`. Search for that prefix before doing anything else; the batch's
`--reverse` script will not help, because the current names are neither the old
nor the new ones. Fix by re-capturing the inventory and planning from where the
file actually is.

### 3. Return what changed

```js
return { batch, kind, renamed: n, pairs: [{id, from, to}, …], mutatedNodeIds: [...] };
```

Paste that into the commit message or the PR. It is the record that makes
`--reverse` trustworthy, and the only proof of what actually landed.

## Per-kind API

| kind | getter | rename |
|---|---|---|
| `variable` | `figma.variables.getVariableByIdAsync(id)` | `v.name = to` |
| `textStyle` / `effectStyle` / `paintStyle` | `figma.getStyleByIdAsync(id)` | `s.name = to` |
| `component` / `componentSet` / `layer` | `figma.getNodeByIdAsync(id)` | `n.name = to` |

Node kinds need their page loaded. `emit-figma.mjs` emits exactly one
`await figma.setCurrentPageAsync(page)` when the batch carries a `pageId`,
which is why `plan.mjs` batches nodes per page: one page switch per call is the
`figma-use` rule, and a batch spanning two pages cannot honour it.

## What renaming does and does not break

**Does not break:**

- variable bindings on any layer (bound by id)
- component instances (attached by id)
- applied styles
- published library links for consumers who have already imported the entity

**Does break, or needs attention:**

- every reference by name in code — the entire reason `apply-code.mjs` exists
- Code Connect snippets that print the component name (the mapping itself is by
  node key and survives; the text in the snippet does not update itself)
- documentation, Storybook titles, screenshots, anything that quoted the name
- for a **published library**: consumers see the new names only after the
  library is published, and their code breaks at that moment, not now. Renaming
  a published library is a coordinated release, not a cleanup task.

## Library (remote) entities

A variable or style with `remote: true` belongs to another file. Assigning to
its `name` from a consuming file does not work. Both `check.mjs` and the
generated script report them rather than half-applying; open the source file
and rename there.

## Rollback

```bash
node "$S/emit-figma.mjs" --batch <id> --reverse
```

Swaps every pair, so the same validate-then-mutate script walks the batch back.
Because it validates against the **new** names, running it twice fails loudly
instead of scrambling anything.

Pair it with `git revert` of that batch's commit. Both halves of a batch are
one commit and one `use_figma` call precisely so that this works — a
400-rename big-bang has no rollback at all.

## Verifying a batch landed

After the call returns, spot-check in Figma rather than trusting the count:

```js
const names = (await figma.variables.getLocalVariablesAsync())
  .filter(v => v.name.startsWith("text/"))
  .map(v => v.name)
  .sort();
return names;
```

And confirm nothing is stranded:

```js
const stranded = (await figma.variables.getLocalVariablesAsync())
  .filter(v => v.name.startsWith("__rn_tmp_"))
  .map(v => ({ id: v.id, name: v.name }));
return { stranded };
```

An empty `stranded` list is the one-line proof that no staged rename was left
half-done.
