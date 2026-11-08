/**
 * The colour packs the application ships with.
 *
 * This module is the single list of theme identities. The main process uses it
 * to validate what is stored in the settings table, the renderer uses it to
 * build the Appearance screen, and the stylesheet carries one block per id for
 * each mode. The visual values themselves live in `styles.css`, not here: a
 * theme has to be able to paint before React mounts, and a CSS file is the only
 * thing that can do that without a flash.
 *
 * Adding a pack therefore means three things: an id and a description here, a
 * light and a dark block in `styles.css`, and nothing else. `tests/themes.test.ts`
 * fails if the two lists disagree.
 */

export const THEME_IDS = [
  "midnight-navy",
  "obsidian-black",
  "ocean-teal",
  "royal-indigo",
  "emerald-forest",
  "arctic-blue",
  "burgundy-wine",
  "amethyst-violet",
  "copper-bronze",
  "crimson-red",
  "slate-professional",
  "pearl-white",
  "carbon-graphite",
  "sage-green",
  "sandstone",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/**
 * The pack an installation gets before anyone chooses one.
 *
 * Ocean Teal is the palette EyerStock shipped with, so an existing database -
 * which has no palette stored at all - keeps the exact colours it had.
 */
export const DEFAULT_THEME_ID: ThemeId = "ocean-teal";

/**
 * Broad families, used by the Appearance screen's filter.
 *
 * Four groups of roughly equal size is enough to make fifteen cards quick to
 * scan; more would be a menu for a menu.
 */
export const THEME_CATEGORIES = ["Cool", "Warm", "Neutral", "Natural"] as const;

export type ThemeCategory = (typeof THEME_CATEGORIES)[number];

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  /** One line, shown under the name on the preview card. */
  readonly blurb: string;
  readonly category: ThemeCategory;
}

export const THEME_CATALOG: readonly ThemeDefinition[] = [
  {
    id: "midnight-navy",
    name: "Midnight Navy",
    blurb: "Deep navy, slate blue and crisp white type.",
    category: "Cool",
  },
  {
    id: "obsidian-black",
    name: "Obsidian Black",
    blurb: "Near-black surfaces with graphite panels.",
    category: "Neutral",
  },
  {
    id: "ocean-teal",
    name: "Ocean Teal",
    blurb: "Cool teal over calm neutrals. The default.",
    category: "Cool",
  },
  {
    id: "royal-indigo",
    name: "Royal Indigo",
    blurb: "Indigo action with sophisticated blue-purple.",
    category: "Cool",
  },
  {
    id: "emerald-forest",
    name: "Emerald Forest",
    blurb: "Rich emerald and natural greenery.",
    category: "Natural",
  },
  {
    id: "arctic-blue",
    name: "Arctic Blue",
    blurb: "Icy blue, steel edges and cool whites.",
    category: "Cool",
  },
  {
    id: "burgundy-wine",
    name: "Burgundy Wine",
    blurb: "Restrained burgundy over warm neutrals.",
    category: "Warm",
  },
  {
    id: "amethyst-violet",
    name: "Amethyst Violet",
    blurb: "Elegant violet and muted purple surfaces.",
    category: "Cool",
  },
  {
    id: "copper-bronze",
    name: "Copper Bronze",
    blurb: "Refined copper, warm graphite and ivory.",
    category: "Warm",
  },
  {
    id: "crimson-red",
    name: "Crimson Red",
    blurb: "Controlled crimson on quiet neutral surfaces.",
    category: "Warm",
  },
  {
    id: "slate-professional",
    name: "Slate Professional",
    blurb: "Balanced slate and blue-grey, understated.",
    category: "Cool",
  },
  {
    id: "pearl-white",
    name: "Pearl White",
    blurb: "Clean white, soft grey, barely-there borders.",
    category: "Neutral",
  },
  {
    id: "carbon-graphite",
    name: "Carbon Graphite",
    blurb: "Charcoal and silver-grey with few highlights.",
    category: "Neutral",
  },
  {
    id: "sage-green",
    name: "Sage Green",
    blurb: "Muted sage, warm grey and natural surfaces.",
    category: "Natural",
  },
  {
    id: "sandstone",
    name: "Sandstone",
    blurb: "Warm beige, cream, taupe and brown.",
    category: "Warm",
  },
];

/** Whether an untrusted value names a pack this build knows. */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** The catalogue entry for an id. Every id has one; the list is exhaustive. */
export function themeDefinition(id: ThemeId): ThemeDefinition {
  const found = THEME_CATALOG.find((theme) => theme.id === id);
  if (found === undefined) {
    throw new Error(`Unknown theme: ${id}`);
  }
  return found;
}

/**
 * Coerce an untrusted value to a pack id.
 *
 * A database written by a newer build, or edited by hand, must not leave the
 * window with no palette at all; the default is the safe landing place.
 */
export function normaliseThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}
