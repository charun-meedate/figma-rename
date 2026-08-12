# Components, variants, layers, Code Connect


## Contents

- 1. A variant is not a component
- 2. Layer names inside components
- 3. Component names in code
- Code Connect
- Instances

---

Components rename the same way variables do — `node.name = to` — but three
things around them behave differently enough to break a run.

## 1. A variant is not a component

Inside a `COMPONENT_SET`, each child `COMPONENT`'s **name is its variant
assignment**, not a name:

```
Button                    ← COMPONENT_SET      .name = "Button"
├── size=md, state=default ← COMPONENT          .name IS the variant tuple
├── size=md, state=hover
└── size=lg, state=default
```

Renaming those children with a naming convention destroys the variant axes.
`references/inventory.md`'s capture script filters them out for exactly this
reason; if you build an inventory another way, filter them yourself:

```js
.filter(n => !(n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET"))
```

### Renaming a variant property or value

This is a different operation with a different tool. The property names and
values *are derived from* the children's name strings, so the rename is a
consistent rewrite across every child:

```js
const set = await figma.getNodeByIdAsync("COMPONENT_SET_ID");
if (set.type !== "COMPONENT_SET") throw new Error("not a component set");

// state=Hover  ->  state=hover   (rename a VALUE)
// State=…      ->  state=…       (rename a PROPERTY)
const rewritten = set.children.map(child => {
  const parts = child.name.split(", ").map(p => {
    const [prop, value] = p.split("=");
    const newProp = prop === "State" ? "state" : prop;
    const newValue = value === "Hover" ? "hover" : value;
    return newProp + "=" + newValue;
  });
  return { child, from: child.name, to: parts.join(", ") };
});
// Every child must move, or the set ends up with two different property names.
for (const r of rewritten) r.child.name = r.to;
return { setId: set.id, pairs: rewritten.map(r => ({ from: r.from, to: r.to })), mutatedNodeIds: set.children.map(c => c.id) };
```

Rules that make this safe:

- **All children or none.** A set where some children say `State=hover` and
  others say `state=hover` grows a second property axis, and every instance in
  the file picks up a detached-looking override.
- Read `set.componentPropertyDefinitions` before and after and compare. The
  before/after property key list is the only honest confirmation.
- Non-variant properties (TEXT, BOOLEAN, INSTANCE_SWAP) are keyed
  `Label#4:0` — name before the `#`, generated suffix after. Before renaming
  one, grep the bundled Plugin API typings for the current signature of
  `editComponentProperty` (the `figma-use` skill ships
  `references/plugin-api-standalone.d.ts` for exactly this) rather than
  guessing the argument shape. Instances carry the key, so a property rename
  that goes through the wrong API detaches overrides.

Whichever path you take, do it in its **own batch**, separate from component
name renames. The two produce very different diffs and very different failure
modes.

## 2. Layer names inside components

Plain `node.name = to`. Low risk, low reach: nothing in a token pipeline refers
to them. They matter for two audiences —

- designers reading the layer panel,
- `get_design_context` / design-to-code output, which uses layer names as
  hints for generated element names.

Scope a layer pass to **one component at a time**. A whole-file layer inventory
is mostly `Frame 427` and `Group 12`, which no convention can decide; those
belong in `needsReview`, not in a rule.

## 3. What a shape can say, and what it cannot

A component's **name** can now be argued from its structure — see the classifier
section below. Its **code symbol** still cannot, and that distinction is the
whole of this section.

## 4. Component names in code

This is the one place where the derivation is a guess, and the skill refuses to
make it.

`text/primary/default` → `--text-primary-default` is a **derivation**: the
generator does exactly that transform, so the codemod can reverse it with
certainty. `Button` → `AppButton`, `PrimaryButton`, `ButtonWidget`, or
`buttons/Button.tsx` is a **convention of that codebase**, which no rule here
knows.

So for `component`, `componentSet` and `layer`, `apply-code.mjs` rewrites only
the **exact Figma name string** — which is what appears in Code Connect files,
docs, Storybook titles and comments. Code symbols come from explicit pairs that
a human confirms:

```json
{
  "id": "1:44",
  "from": "btn primary",
  "to": "Button/Primary",
  "code": [
    { "from": "BtnPrimary", "to": "ButtonPrimary" },
    { "from": "btn-primary", "to": "button-primary", "guard": "kebab" }
  ]
}
```

`plan.mjs` writes a `codeSuggestion` alongside each component rename with the
PascalCase guess. It is ignored by every downstream step until someone promotes
it to `code`. Confirm the symbol actually exists first:

```bash
rg -w 'BtnPrimary' --stats
```

If it appears zero times, the guess was wrong — find the real symbol before
promoting anything.

## Code Connect

The mapping between a Figma component and a code component is stored **by node
key**, so renaming the component does not break it. Two things do go stale:

- the component name printed inside the snippet or in `figma.connect(...)`
  documentation strings,
- `.figma.ts` / `.figma.js` file names chosen to mirror the Figma name.

Include those file globs in `code.include` and the exact Figma name moves with
everything else. After the batch, re-read the mapping to confirm it survived:

```
get_code_connect_map  →  compare component names against the new inventory
```

If the team maintains Code Connect at all, do that check once per component
batch. It is cheap, and a silently stale mapping is the kind of thing that goes
unnoticed for months.

## Instances

Nothing to do. Instances attach by id and follow the main component's rename
automatically. An instance with a **manually overridden name** keeps that
override — which is correct, and also means a stale hand-typed name can survive
a rename. If the team overrides instance names on purpose, sweep for the old
name once after the batch:

```js
const page = await figma.getNodeByIdAsync("PAGE_ID");
await figma.setCurrentPageAsync(page);
const stale = page.findAllWithCriteria({ types: ["INSTANCE"] })
  .filter(n => n.name.includes("btn primary"))
  .map(n => ({ id: n.id, name: n.name }));
return { stale };
```

## The structural classifier

A token can be named from its value. A component cannot — but its *shape* is
evidence, and a table of rules can read it:

```
Component 7   →  Modal    [high]    Structure: 400×320, 2 text node(s)
btn primary   →  Button   [medium]  Structure: 120×40, radius 8, 1 text node — also matched Tag
thing 9       →  (nothing)          no captured shape; spelling only
```

Three steps, and the first is the one people miss:

1. **Capture a signature.** `references/inventory.md` has the script — about
   thirty fields per component: geometry, layout, fills, strokes, corner radius,
   child names and types, text nodes, variant properties. Without it the
   classifier has nothing to read and `plan.mjs` says so rather than staying
   quiet.
2. **Classify.** 50 rules, priority-ordered, ported test-for-test from the team's
   Figma plugin. Each match carries the evidence and the runners-up, because when
   several rules fire the winner is a ranking, not a fact.
3. **Review.** Same path as any other suggestion: `review.mjs` shows the reason
   and the confidence, and nothing ships undecided.

### What it will not do

- **No name at all when nothing matches.** The plugin answered `Small Element`,
  `Bar Element` or `Component` here. Those read as answers in a list of two
  hundred, and they are not names.
- **Confidence follows the priority band.** `Container` — any auto-layout frame
  with more than five descendants, which is most frames — cannot come back
  looking as certain as `Modal`.
- **The label does not go in the name.** The plugin prefixed the first text node,
  so a button reading "Save" became `Save Button`. That is instance content: the
  next designer writes a different label and the name is a lie.
  `classifier.includeTextHint` turns it back on for libraries whose labels are
  identities rather than copy.
- **Two components that read alike go to review**, with each other's evidence
  attached. `Button 1` and `Button 2` tell nobody which is which.

### Tuning it without forking the skill

The priorities are data, and they live in the shared standard rather than in the
installed JS — otherwise tuning them means editing a file the next `install.sh`
overwrites, which is the fork `extends` exists to prevent.

```json
"components": {
  "classifier": {
    "minConfidence": "medium",
    "priorities": { "Tooltip": 120 },
    "disable": ["Container"],
    "pageHints": { "sheet": "Modal" },
    "includeTextHint": false
  }
}
```

A `priorities` key naming a rule that does not exist is refused, with the list of
real ones — a typo there would otherwise be a silent no-op.

**Three priorities were already changed** on the way across from the plugin, each
the same mistake: a rule testing GEOMETRY sat at the same priority as one testing
NAME evidence, so the loose shape description outranked the specific rule under
it. Every small labelled button classified as `Tooltip`, every ghost button as
`Text Input`, every numeric badge as `Radio Button` — each at a confidence that
read as certain. If a library disagrees with the corrections, `priorities` moves
them back.
