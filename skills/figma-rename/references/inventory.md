# Capturing the inventory


## Contents

- The shape
- Variables
- Text, effect and paint styles
- Components and component sets
- Layers inside a component
- Modes
- Merging several calls
- When the page listing looks empty

---

`rename/inventory.json` is the list of everything that could be renamed, read
straight out of Figma. Nothing in `scripts/` can reach Figma — **you** capture
it with `use_figma` read-only calls and write the result into the project.

Load the `figma-use` skill before the first `use_figma` call. It is a mandatory
prerequisite of that tool.

## The shape

```json
{
  "fileKey": "abc123…",
  "capturedAt": "2026-08-11 (mode: Light)",
  "entries": [
    { "kind": "variable", "id": "VariableID:1:23", "name": "color/text-primary",
      "scope": "2. Semantic", "resolvedType": "COLOR", "remote": false },
    { "kind": "componentSet", "id": "1:44", "name": "btn primary",
      "scope": "Components", "pageId": "0:12" },
    { "kind": "layer", "id": "1:57", "name": "Label",
      "scope": "Button", "parentId": "1:44", "pageId": "0:12" },
    { "kind": "textStyle", "id": "S:9f2…", "name": "Body/lg/bold" }
  ]
}
```

| field | meaning |
|---|---|
| `kind` | `variable`, `component`, `componentSet`, `layer`, `textStyle`, `effectStyle`, `paintStyle` |
| `id` | the Plugin API id — what the rename is actually applied to |
| `name` | the current name; `check.mjs` refuses the map if this has moved |
| `scope` | the uniqueness namespace: collection for variables, page for nodes |
| `pageId` | for node kinds — `emit-figma.mjs` emits the page switch from it |
| `remote` | `true` for library entities, which cannot be renamed from this file |

`scope` is what `plan.mjs` batches by, so it decides how the work is split into
commits. Use the real collection name for variables (`1. Primitive`,
`2. Semantic`) — that is the grouping a designer will recognise in review.

## Variables

One call, no page switching needed — variables are file-level.

**Capture the values, not just the names.** They are what the suggest engine
reads, and they are what lets it calibrate shade ladders against the ramps this
file already has. A name-only inventory silently turns the whole engine off.

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const byId = new Map(collections.map(c => [c.id, c]));
const variables = await figma.variables.getLocalVariablesAsync();
const nameById = new Map(variables.map(v => [v.id, v.name]));

return {
  collections: collections.map(c => ({ name: c.name, id: c.id, modes: c.modes.map(m => m.name) })),
  entries: variables.map(v => {
    const collection = byId.get(v.variableCollectionId);
    // One mode's worth of values is enough to name a variable, and the default
    // mode is the one every other mode is an override of.
    const raw = collection ? v.valuesByMode[collection.defaultModeId] : undefined;
    const isAlias = raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS";
    return {
      kind: "variable",
      id: v.id,
      name: v.name,
      scope: collection?.name ?? null,
      resolvedType: v.resolvedType,
      remote: v.remote,
      scopes: v.scopes,
      codeSyntax: v.codeSyntax,
      value: isAlias ? undefined : raw,
      alias: isAlias ? raw.id : undefined,
      aliasName: isAlias ? nameById.get(raw.id) ?? null : undefined,
    };
  }),
};
```

Notes that matter:

- **`defaultModeId`, not `modes[0]`.** They are usually the same and sometimes
  are not; the default is the one the file resolves to.
- **An alias keeps its pointer, not a value.** That is deliberate — an alias is
  a semantic token, and its correct name is its *role*, which no value reveals.
  The engine routes those to `needsReview` rather than naming them.
- **`scopes` is a strong category signal for numbers.** `GAP` says spacing,
  `CORNER_RADIUS` says radius. Without it the engine falls back to guessing
  from the value alone, which never earns better than low confidence.
- Colour values are `{r, g, b, a}` in 0–1, which is what the engine expects.
  Do not convert to hex on the way out.

`codeSyntax` is worth capturing: if it is already populated it tells you what
the codebase calls each token, which is better evidence than guessing from the
name — and `emit-figma.mjs --with-code-syntax` will keep it in step afterwards.

## Text, effect and paint styles

Also file-level, also one call.

```js
const [text, effect, paint] = await Promise.all([
  figma.getLocalTextStylesAsync(),
  figma.getLocalEffectStylesAsync(),
  figma.getLocalPaintStylesAsync(),
]);
const map = (styles, kind) => styles.map(s => ({ kind, id: s.id, name: s.name, remote: s.remote }));
return {
  entries: [...map(text, "textStyle"), ...map(effect, "effectStyle"), ...map(paint, "paintStyle")],
};
```

## Components and component sets

Nodes live on pages, and **page context resets between `use_figma` calls**. The
rule from `figma-use` applies exactly: one `setCurrentPageAsync` per call, and
multiple pages are covered by issuing several calls **in one message** so they
run in parallel.

Step 1 — one cheap call for the page list:

```js
return figma.root.children.map(p => ({ id: p.id, name: p.name }));
```

Step 2 — one call per page, all emitted in the same message:

```js
const page = await figma.getNodeByIdAsync("PAGE_ID");
await figma.setCurrentPageAsync(page);
// Indexed type lookup — far faster than findAll with a predicate.
const nodes = page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
return {
  entries: nodes
    // A COMPONENT inside a COMPONENT_SET is a VARIANT: its name is a
    // "Prop=Value" string, not a component name. Renaming those is a different
    // operation — see components.md.
    .filter(n => !(n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET"))
    .map(n => ({
      kind: n.type === "COMPONENT_SET" ? "componentSet" : "component",
      id: n.id,
      name: n.name,
      scope: page.name,
      pageId: page.id,
    })),
};
```

That filter matters. Without it the inventory fills with entries called
`size=md, state=hover`, the convention mangles them into `size-md/state-hover`,
and applying the result destroys the variant axes of every component set in the
file.

## Layers inside a component

Only capture these when layer naming is in scope — they are numerous and their
blast radius is small (they matter for design-to-code output and for designers
reading the layer panel, not for token references).

```js
const page = await figma.getNodeByIdAsync("PAGE_ID");
await figma.setCurrentPageAsync(page);
const set = page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })
  .find(n => n.name === "Button");
return {
  entries: set.findAll(n => n.type !== "COMPONENT").map(n => ({
    kind: "layer",
    id: n.id,
    name: n.name,
    scope: set.name,
    parentId: set.id,
    pageId: page.id,
    type: n.type,
  })),
};
```

Scope this to one component per pass. A whole-file layer inventory is thousands
of entries, most of them named `Frame 427`, and no convention can decide what
those should be called.

## Modes

An inventory records **names**, and names do not vary by mode — so unlike
`figma-token-export`, this skill does not need one capture per mode. Note in
`capturedAt` which mode was active anyway; it makes the artefact easier to
place next to a token dump taken the same day.

## Merging several calls

The page fan-out returns one result per call. Concatenate the `entries` arrays
into one file by hand (or have the agent do it) — order does not matter, ids
must be unique, and `loadInventory` fails loudly on a duplicate id.

## When the page listing looks empty

`get_metadata` has been observed reporting only the cover page on a production
file that had many. If a file looks empty, ask the user for a node-specific
link (right-click a frame → *Copy link to selection*) rather than concluding
there is nothing to rename. The `node-id=1643-43256` in the URL is node id
`1643:43256`.
