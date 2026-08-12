// What a component IS, read off its structure.
//
// A token can be named from its value; a component cannot. But its *shape* is
// evidence: a 40px-tall rounded box with one solid fill and exactly one text
// node is a Button, and a 320-wide box with an overlay and a close control is a
// Modal. That is a judgement a table of rules can make, and it is the half of
// component naming that does not need an LLM.
//
// The rules below are ported test-for-test from the classifier in the team's
// Figma plugin ("Rename & map components", code.ts). They were tuned against a
// real library, so re-deriving them from first principles would have thrown
// that work away.
//
// Changed on the way across, each for a reason recorded at the rule itself:
//
//  - **Three priorities.** Running the ported table against ordinary component
//    shapes showed loose geometric tests outranking specific ones — see the
//    note on RULES. Every small labelled button came out `Tooltip`.
//  - **Confidence from priority.** The plugin returned every match with equal
//    weight, so `Container` (a catch-all for "has auto-layout and >5
//    descendants") arrived looking as certain as `Modal`. Here the priority
//    band sets the confidence, and the weakest tier produces no name at all.
//  - **No content in the name.** The plugin prefixed the first text node, so a
//    button reading "Save" became `Save Button`. That is instance content, not
//    component identity — the next designer changes the label and the name
//    lies. Off by default; `includeTextHint` turns it back on.
//
// The signature is captured in Figma by the read script in
// references/inventory.md — this module only reads the object.

/**
 * `priority` is the authority — the classifier sorts, so array order is only a
 * reading aid. Mostly it runs highest-first, with one exception: where a rule
 * was split into a name-evidence half and a geometry half, the two halves stay
 * next to each other rather than scattering across fifty lines.
 * `test` reads a ComponentSignature.
 *
 * These are the plugin's rules, ported test-for-test — with three priorities
 * changed. All three are the same mistake, found by running the ported table
 * against ordinary component shapes:
 *
 *   a rule that tests NAME evidence ("a child called input/field/search")
 *   and a rule that tests GEOMETRY ("a bordered box 32–56 tall") were given
 *   the same priority, so the loose shape description outranked the specific
 *   rule underneath it.
 *
 * The results were not marginal. Every small labelled button classified as
 * `Tooltip`, every ghost button as `Text Input`, every numeric badge as
 * `Radio Button` — each at a confidence that read as certain. Name evidence
 * keeps its priority in each case; the geometry-only half drops below the rule
 * it was swallowing. The table already used that shape for `Button`, which is
 * where the fix came from.
 *
 * If a library disagrees — these were tuned against a real one — the priorities
 * are data, and moving them back is a one-line change.
 */
export const RULES = [
  { name: 'Modal', priority: 200, test: (s) => s.hasOverlay || (s.hasClose && s.width > 300 && s.height > 200) },
  { name: 'Dialog', priority: 198, test: (s) => s.hasClose && s.hasAction && s.width > 250 && s.textNodes.length >= 2 },
  { name: 'Toast', priority: 195, test: (s) => s.hasClose && s.width > 200 && s.height <= 80 && s.textNodes.length >= 1 },
  { name: 'Navigation Bar', priority: 190, test: (s) => s.layoutMode === 'HORIZONTAL' && s.width > 300 && s.height <= 80 && s.smallInstances >= 3 },
  { name: 'Tab Bar', priority: 188, test: (s) => s.layoutMode === 'HORIZONTAL' && s.textNodes.length >= 3 && s.height <= 60 && s.width > 250 },
  { name: 'Sidebar', priority: 185, test: (s) => s.layoutMode === 'VERTICAL' && s.width <= 280 && s.height > 400 && s.textNodes.length >= 4 },
  { name: 'Breadcrumb', priority: 183, test: (s) => s.layoutMode === 'HORIZONTAL' && s.hasArrow && s.textNodes.length >= 2 && s.height <= 40 },
  { name: 'Pagination', priority: 180, test: (s) => s.layoutMode === 'HORIZONTAL' && s.hasArrow && s.textNodes.some((t) => /^\d+$/.test(t.text)) },
  { name: 'Search Bar', priority: 175, test: (s) => s.hasSearch && s.hasInput },
  { name: 'Dropdown', priority: 173, test: (s) => s.hasDropdown || (s.hasArrow && s.hasStroke && s.height <= 50 && s.textNodes.length === 1) },
  // DEVIATION FROM THE PLUGIN — split in two.
  //
  // The original was one rule at 170 combining name evidence (`hasInput`, from
  // a child called "input"/"field"/"search") with a geometric fallback
  // ("bordered box, 32–56 tall, wider than 100, no solid fill"). That fallback
  // is also an exact description of an outline button, and at 170 it outranked
  // Button (148) — so every ghost button classified as Text Input.
  //
  // Name evidence keeps its priority; the geometry-only guess drops below
  // Button, which is the same shape this table already uses for Button itself.
  { name: 'Text Input', priority: 170, test: (s) => s.hasInput },
  { name: 'Text Input', priority: 144, test: (s) => s.hasStroke && s.cornerRadius >= 2 && s.height >= 32 && s.height <= 56 && s.width > 100 && s.textNodes.length <= 2 && !s.hasSolidFill },
  { name: 'Textarea', priority: 168, test: (s) => s.hasInput && s.height > 80 },
  { name: 'Checkbox', priority: 165, test: (s) => s.hasCheckbox || (s.width <= 24 && s.height <= 24 && s.hasStroke && s.cornerRadius <= 4 && s.cornerRadius >= 1) },
  { name: 'Radio Button', priority: 163, test: (s) => s.hasRadio },
  // Geometry-only, so below Badge: a 24×24 circle is a radio button OR a
  // notification badge, and the one with a number in it is the badge.
  { name: 'Radio Button', priority: 142, test: (s) => s.width <= 24 && s.height <= 24 && s.cornerRadius >= 10 && !s.textNodes.length },
  { name: 'Toggle', priority: 160, test: (s) => s.hasToggle || (s.width >= 36 && s.width <= 60 && s.height >= 18 && s.height <= 32 && s.cornerRadius >= 8 && s.hasSolidFill) },
  { name: 'Slider', priority: 158, test: (s) => s.hasSlider || (s.layoutMode === 'HORIZONTAL' && s.width > 100 && s.height <= 30 && s.childCount <= 4) },
  { name: 'Icon Button', priority: 155, test: (s) => s.hasIcon && !s.textNodes.length && s.width <= 56 && s.height <= 56 && s.cornerRadius >= 4 },
  { name: 'Button', priority: 150, test: (s) => s.cornerRadius >= 4 && s.hasSolidFill && s.textNodes.length === 1 && s.height >= 28 && s.height <= 64 && s.width <= 300 },
  { name: 'Button', priority: 148, test: (s) => s.hasStroke && s.textNodes.length === 1 && s.height >= 28 && s.height <= 64 && s.width <= 300 && s.cornerRadius >= 4 },
  { name: 'Floating Action Button', priority: 147, test: (s) => s.hasIcon && s.hasSolidFill && s.cornerRadius >= 20 && s.width >= 48 && s.width <= 72 && Math.abs(s.width - s.height) <= 4 },
  { name: 'Badge', priority: 145, test: (s) => s.width <= 32 && s.height <= 32 && s.hasSolidFill && s.cornerRadius >= 8 && s.textNodes.length <= 1 },
  { name: 'Tag', priority: 143, test: (s) => s.cornerRadius >= 4 && s.height <= 32 && s.width <= 120 && s.textNodes.length === 1 && (s.hasSolidFill || s.hasStroke) },
  { name: 'Chip', priority: 141, test: (s) => s.cornerRadius >= 12 && s.height <= 40 && s.textNodes.length === 1 && s.hasIcon },
  // DEVIATION FROM THE PLUGIN — priority lowered from 193 to 139.
  //
  // This test describes "a small box with one short text", which is also an
  // exact description of a button. At 193 it outranked Button (150), so a
  // 120×40 filled rounded component with a "Save" label classified as Tooltip,
  // at high confidence. Every small labelled button in a library lands here.
  // Verified against the ported rules before changing anything.
  //
  // Its test is the weakest shape description in the table, so it now sits below
  // every rule with a tighter one (Button, Badge, Tag, Chip, Status Indicator).
  // A real tooltip still reaches it — nothing else in
  // the table claims a small one-line box that has no fill-and-radius button
  // signature — and where both genuinely fit, `alternatives` says so.
  { name: 'Tooltip', priority: 139, test: (s) => s.width <= 200 && s.height <= 60 && s.textNodes.length === 1 && s.totalDescendants <= 5 },
  { name: 'Status Indicator', priority: 140, test: (s) => s.width <= 16 && s.height <= 16 && s.hasSolidFill && s.cornerRadius >= 6 },
  { name: 'Avatar', priority: 138, test: (s) => s.hasAvatar || (s.width >= 24 && s.width <= 80 && Math.abs(s.width - s.height) <= 2 && s.cornerRadius >= s.width / 2 - 2) },
  { name: 'Rating', priority: 135, test: (s) => s.hasStar && s.layoutMode === 'HORIZONTAL' },
  { name: 'Progress Bar', priority: 133, test: (s) => s.hasProgressBar || (s.height <= 12 && s.width > 80 && s.cornerRadius >= 2 && s.hasSolidFill) },
  { name: 'Notification Badge', priority: 130, test: (s) => s.hasNotification && s.width <= 48 },
  { name: 'User Card', priority: 128, test: (s) => s.hasAvatar && s.textNodes.length >= 2 && s.hasAction },
  { name: 'Profile Card', priority: 126, test: (s) => s.hasAvatar && s.textNodes.length >= 2 },
  { name: 'Media Card', priority: 124, test: (s) => s.hasImage && s.textNodes.length >= 1 && s.cornerRadius >= 4 && s.height > 100 },
  { name: 'Card', priority: 120, test: (s) => s.cornerRadius >= 4 && (s.hasFill || s.hasStroke) && s.textNodes.length >= 2 && s.width > 150 && s.height > 80 },
  { name: 'List Item', priority: 118, test: (s) => s.layoutMode === 'HORIZONTAL' && s.textNodes.length >= 1 && s.height <= 80 && s.width > 200 && (s.hasDivider || s.hasArrow) },
  { name: 'Accordion', priority: 115, test: (s) => s.hasArrow && s.textNodes.length >= 1 && s.height <= 60 && s.layoutMode === 'HORIZONTAL' },
  { name: 'Heading', priority: 110, test: (s) => s.textNodes.length === 1 && s.textNodes[0].fontSize >= 24 && s.childCount <= 2 },
  { name: 'Label', priority: 108, test: (s) => s.textNodes.length === 1 && s.textNodes[0].fontSize <= 14 && s.childCount <= 2 && s.width <= 200 },
  { name: 'Image Placeholder', priority: 105, test: (s) => s.hasImageFill && s.childCount <= 1 },
  { name: 'Icon', priority: 103, test: (s) => s.width <= 32 && s.height <= 32 && s.childCount <= 3 && !s.textNodes.length },
  { name: 'Divider', priority: 100, test: (s) => (s.height <= 2 && s.width > 40) || (s.width <= 2 && s.height > 40) },
  { name: 'Spacer', priority: 95, test: (s) => s.childCount === 0 && !s.hasFill && !s.hasStroke && s.textNodes.length === 0 },
  { name: 'Header', priority: 90, test: (s) => s.layoutMode === 'HORIZONTAL' && s.width > 300 && s.height <= 100 && s.textNodes.length >= 1 && (s.hasIcon || s.hasAvatar) },
  { name: 'Footer', priority: 85, test: (s) => s.layoutMode === 'HORIZONTAL' && s.width > 300 && s.textNodes.length >= 2 && s.height <= 80 },
  { name: 'Table Row', priority: 83, test: (s) => s.layoutMode === 'HORIZONTAL' && s.textNodes.length >= 3 && s.height <= 60 && s.width > 300 },
  { name: 'Form Group', priority: 80, test: (s) => s.layoutMode === 'VERTICAL' && s.textNodes.length >= 2 && s.hasInput },
  { name: 'Section', priority: 70, test: (s) => s.totalDescendants > 15 && s.textNodes.length >= 2 && s.height > 200 },
  { name: 'Container', priority: 60, test: (s) => s.totalDescendants > 5 && s.hasAutoLayout },
];

/** Page names that name the thing on them. Used only when no rule matched. */
export const PAGE_HINTS = {
  button: 'Button', icon: 'Icon', input: 'Input', card: 'Card',
  nav: 'Navigation', modal: 'Modal', form: 'Form Element', avatar: 'Avatar',
  badge: 'Badge', tag: 'Tag', chip: 'Chip', toggle: 'Toggle',
  tab: 'Tab', alert: 'Alert', toast: 'Toast', tooltip: 'Tooltip',
};

/**
 * Priority band to confidence.
 *
 * The high band is a distinctive structural signature — an overlay plus a close
 * control really is a modal. The low band is a description of a shape, not of a
 * purpose: `Container` matches any auto-layout frame with a few children, which
 * is most frames in most files. Presenting those two the same way is how a
 * reviewer ends up approving 200 components called `Container`.
 */
export function confidenceFor(priority) {
  if (priority >= 180) return 'high';
  if (priority >= 120) return 'medium';
  return 'low';
}

const MISSING = [
  'width', 'height', 'childCount', 'totalDescendants', 'layoutMode',
  'cornerRadius', 'textNodes',
];

/**
 * A signature to a component type, or null when nothing defensible applies.
 *
 * @returns {{name, reason, confidence, priority, matched}|null}
 */
/**
 * The rule table with a project's overrides applied.
 *
 * The priorities are data — the header says so — but before this they were data
 * inside an installed skill, so tuning them meant editing a file that the next
 * `install.sh` overwrites. That is the fork this skill's `extends` mechanism
 * exists to prevent, reappearing one directory down.
 *
 * `convention.components.classifier.priorities` moves a rule; `pageHints` adds
 * or replaces a page-name fallback. Both travel with the shared standard.
 */
export function rulesWith({ priorities = {}, disable = [] } = {}) {
  const disabled = new Set(disable);
  const unknown = Object.keys(priorities).filter((name) => !RULES.some((r) => r.name === name));
  if (unknown.length) {
    throw new Error(
      `classifier.priorities names rule(s) that do not exist: ${unknown.join(', ')}.\n` +
        `Rules: ${[...new Set(RULES.map((r) => r.name))].join(', ')}`,
    );
  }
  return RULES.filter((r) => !disabled.has(r.name)).map((r) =>
    priorities[r.name] === undefined ? r : { ...r, priority: priorities[r.name] },
  );
}

export function classifyComponent(signature, { pageName = '', classifier = {} } = {}) {
  if (!signature) return null;
  const absent = MISSING.filter((key) => signature[key] === undefined);
  if (absent.length) {
    throw new Error(
      `Signature is missing ${absent.join(', ')} — capture it with the script in ` +
        'references/inventory.md, not by hand.',
    );
  }
  const sig = { textNodes: [], childNames: [], variantProps: [], ...signature };

  const table = classifier.priorities || classifier.disable ? rulesWith(classifier) : RULES;
  const matches = table.filter((r) => r.test(sig)).sort((a, b) => b.priority - a.priority);
  if (matches.length) {
    const best = matches[0];
    const evidence = [];
    evidence.push(`${Math.round(sig.width)}×${Math.round(sig.height)}`);
    if (sig.layoutMode && sig.layoutMode !== 'NONE') evidence.push(`${sig.layoutMode.toLowerCase()} auto-layout`);
    if (sig.cornerRadius) evidence.push(`radius ${sig.cornerRadius}`);
    if (sig.textNodes.length) evidence.push(`${sig.textNodes.length} text node(s)`);
    if (sig.variantProps.length) evidence.push(`variants: ${sig.variantProps.slice(0, 3).join(', ')}`);
    // Runners-up matter: when several rules fire, the winner is a ranking, not
    // a fact, and the reviewer should see what else it could have been.
    const alternatives = matches.slice(1, 3).map((m) => m.name).filter((n) => n !== best.name);
    return {
      name: best.name,
      priority: best.priority,
      matched: matches.length,
      confidence: confidenceFor(best.priority),
      reason:
        `Structure: ${evidence.join(', ')}` +
        (alternatives.length ? ` — also matched ${alternatives.join(', ')}` : ''),
    };
  }

  const page = String(pageName || sig.pageContext || '').toLowerCase();
  for (const [keyword, label] of Object.entries({ ...PAGE_HINTS, ...(classifier.pageHints ?? {}) })) {
    if (page.includes(keyword)) {
      return {
        name: label,
        priority: 0,
        matched: 0,
        confidence: 'low',
        reason: `No structural rule matched — named from the page "${pageName || sig.pageContext}"`,
      };
    }
  }

  // The plugin fell back to "Small Element", "Bar Element" and "Component"
  // here. Those are not names, they are the classifier admitting defeat with
  // extra steps — and they read as answers in a list of 200. Say nothing.
  return null;
}

/**
 * The suggested name for one component.
 *
 * `includeTextHint` reproduces the plugin's behaviour of prefixing the first
 * text node ("Save" + "Button" -> "Save Button"). It is off by default: the
 * label is instance content, and a component named after it is wrong the first
 * time someone writes a different label into an instance. The team's own deck
 * says to name by function, not appearance.
 */
export function suggestComponentName(signature, { pageName = '', includeTextHint = false, classifier = {} } = {}) {
  const classification = classifyComponent(signature, { pageName, classifier });
  if (!classification) return null;

  let name = classification.name;
  if (includeTextHint) {
    const primary = signature.textNodes?.[0]?.text;
    if (primary && primary.length <= 15 && !name.toLowerCase().includes(primary.toLowerCase())) {
      name = `${primary} ${name}`;
    }
  }
  return { ...classification, name };
}

/**
 * Components that would end up sharing a name.
 *
 * The plugin appended " 1", " 2" and moved on. For components that is more
 * defensible than it is for tokens — two different components genuinely do need
 * two different names — but `Button 1` and `Button 2` tell nobody which is
 * which, so the collision is reported rather than papered over, with the
 * distinguishing evidence attached.
 */
export function findNameCollisions(suggestions) {
  const byName = new Map();
  for (const s of suggestions) {
    if (!s?.name) continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  return [...byName.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([name, group]) => ({
      name,
      members: group.map((s) => ({ id: s.id, currentName: s.currentName, reason: s.reason })),
    }));
}
