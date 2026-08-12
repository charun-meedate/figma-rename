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

## The component signature — what lets a shape suggest a name

A component name cannot be derived from a value, but it can be argued from the
component's **shape**: a 40px-tall rounded box with one solid fill and exactly
one text node is a Button; a 320-wide box with an overlay and a close control is
a Modal. `lib/classify.mjs` makes that argument from a `signature` object, and
this is the script that captures one.

Without a signature, a component gets spelling normalisation only — `plan.mjs`
says so explicitly rather than leaving you to wonder why nothing was suggested.

Add this to the per-page component script above; it walks each component once
and attaches the result as `signature`.

```js
const page = await figma.getNodeByIdAsync("PAGE_ID");
await figma.setCurrentPageAsync(page);

const CHILD_SIGNALS = [
  ["hasIcon",         /icon|ico$|^i$/],
  ["hasImage",        /image|photo|thumbnail|img|cover|hero|banner/],
  ["hasAvatar",       /avatar|profile|user-pic|photo-circle/],
  ["hasInput",        /input|field|textfield|textarea|search/],
  ["hasAction",       /button|btn|cta|action|submit/],
  ["hasDivider",      /divider|separator|^hr$/],
  ["hasToggle",       /toggle|switch/],
  ["hasCheckbox",     /check|tick/],
  ["hasRadio",        /radio|dot-select/],
  ["hasDropdown",     /dropdown|select|picker|combobox/],
  ["hasSlider",       /slider|range|track/],
  ["hasProgressBar",  /progress|loading|spinner/],
  ["hasClose",        /close|dismiss|x-btn|^x$/],
  ["hasStar",         /star|rating|favorite/],
  ["hasArrow",        /arrow|chevron|caret|back|next/],
  ["hasSearch",       /search|magnify|find/],
  ["hasNotification", /notification|alert|bell|badge|dot/],
  ["hasOverlay",      /overlay|backdrop|modal|sheet/],
];

function collectSignals(node, depth, out) {
  if (!("children" in node) || depth <= 0) return out;
  for (const child of node.children) {
    out.childTypes.push(child.type);
    out.childNames.push(child.name);
    const name = child.name.toLowerCase();
    for (const [flag, re] of CHILD_SIGNALS) if (re.test(name)) out[flag] = true;
    // A small instance is an icon whatever it is called.
    if (child.type === "INSTANCE" && "width" in child && child.width <= 28 && child.height <= 28) {
      out.hasIcon = true;
      out.smallInstances++;
    }
    if (child.type === "LINE") out.hasDivider = true;
    if (child.type === "ELLIPSE" && "width" in child && child.width === child.height && child.width >= 24 && child.width <= 64) {
      out.hasAvatar = true;
    }
    if ((child.type === "RECTANGLE" || child.type === "ELLIPSE") && "fills" in child) {
      const fills = child.fills;
      if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) out.hasImage = true;
    }
    collectSignals(child, depth - 1, out);
  }
  return out;
}

function collectText(node, depth, out = []) {
  if (depth <= 0 || out.length >= 8) return out;
  if (node.type === "TEXT") {
    const text = node.characters.trim();
    if (text.length && text.length <= 50) {
      const font = node.fontName;
      out.push({
        text,
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 14,
        isBold: typeof font === "object" && /bold|semi|medium|black|heavy/i.test(font.style ?? ""),
      });
    }
    return out;
  }
  if ("children" in node) for (const child of node.children) collectText(child, depth - 1, out);
  return out;
}

function countDescendants(node, depth) {
  if (depth <= 0 || !("children" in node)) return 0;
  let n = 0;
  for (const child of node.children) n += 1 + countDescendants(child, depth - 1);
  return n;
}

function buildSignature(node, pageName) {
  // A COMPONENT_SET is a grid of variants, so measuring the set measures the
  // GRID — on a real file the Button set came back 553×1126 with 60 children and
  // classified as "Card", while one of its variants is 129×28 with radius 8.
  // Measure a representative variant instead; only variantProps and the variant
  // count are facts about the set itself.
  const isSet = node.type === "COMPONENT_SET" && "children" in node && node.children.length > 0;
  const shape = isSet ? node.children[0] : node;
  const variantProps = shape?.variantProperties ? Object.keys(shape.variantProperties) : [];

  const fills = "fills" in shape && Array.isArray(shape.fills) ? shape.fills.filter((f) => f.visible !== false) : [];
  const strokes = "strokes" in shape && Array.isArray(shape.strokes) ? shape.strokes.filter((s) => s.visible !== false) : [];
  const radius = "cornerRadius" in shape && typeof shape.cornerRadius === "number" ? shape.cornerRadius : 0;

  const signals = collectSignals(shape, 3, {
    childTypes: [], childNames: [], smallInstances: 0,
    ...Object.fromEntries(CHILD_SIGNALS.map(([flag]) => [flag, false])),
  });

  return {
    width: "width" in shape ? shape.width : 0,
    height: "height" in shape ? shape.height : 0,
    aspectRatio: "height" in shape && shape.height > 0 ? shape.width / shape.height : 1,
    childCount: "children" in shape ? shape.children.length : 0,
    directChildCount: "children" in shape ? shape.children.length : 0,
    totalDescendants: countDescendants(shape, 4),
    layoutMode: "layoutMode" in shape ? String(shape.layoutMode) : "NONE",
    hasAutoLayout: "layoutMode" in shape && shape.layoutMode !== "NONE",
    cornerRadius: radius,
    hasFill: fills.length > 0,
    hasSolidFill: fills.some((f) => f.type === "SOLID"),
    hasGradientFill: fills.some((f) => String(f.type).startsWith("GRADIENT")),
    hasImageFill: fills.some((f) => f.type === "IMAGE"),
    hasStroke: strokes.length > 0,
    textNodes: collectText(shape, 3),
    variantProps,
    variantCount: isSet ? node.children.length : 0,
    measuredFrom: isSet ? "variant" : "self",
    pageContext: pageName,
    ...signals,
  };
}

const nodes = page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })
  .filter((n) => !(n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET"));

return {
  entries: nodes.map((n) => ({
    kind: n.type === "COMPONENT_SET" ? "componentSet" : "component",
    id: n.id,
    name: n.name,
    scope: page.name,
    pageId: page.id,
    signature: buildSignature(n, page.name),
  })),
};
```

Two things worth knowing about the output:

- **It is bulky.** A signature is ~30 fields per component, so capture one page
  at a time and expect the inventory to be large. That is fine — it is committed
  as the record of what the file looked like.
- **`textNodes` carries real copy from the file.** The classifier reads sizes and
  counts, and by default does *not* put the text into a name (a label is instance
  content and changes). Do not turn `includeTextHint` on for a library whose
  labels are placeholders.

## Renaming just a selection

MCP cannot read the user's live selection. What it can do is take a **link to
it**, which is one right-click away and does the same job:

> In Figma → select the component(s) → right-click → **Copy link to selection**

The `node-id=1643-43256` in that URL is node id `1643:43256`. Capture inside
that node instead of the whole page:

```js
const root = await figma.getNodeByIdAsync("1643:43256");
if (!root) throw new Error("That node is not in this file — check the link");
// Loading the page the node lives on is still required.
const page = root.type === "PAGE" ? root : (() => { let p = root; while (p.parent && p.type !== "PAGE") p = p.parent; return p; })();
await figma.setCurrentPageAsync(page);

const nodes = ("findAllWithCriteria" in root ? root : page)
  .findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })
  .filter((n) => !(n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET"));

return {
  // Recorded so a later reader knows this inventory is a SLICE of the file,
  // not the file — `check` and `plan` say so in their output.
  scopeNodeId: root.id,
  entries: nodes.map((n) => ({ /* …as above… */ })),
};
```

**Variables cannot be scoped this way.** They are file-level, not canvas nodes —
`getLocalVariablesAsync` has no subtree. Narrow those by collection when
capturing, or by name at plan time:

```bash
node "$S/plan.mjs" --kind variable --only "palette/**"
```

Say which of the two you are doing out loud. "I renamed the selection" and "I
renamed everything matching `palette/**`" are different claims, and only one of
them is true of a variable pass.

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
