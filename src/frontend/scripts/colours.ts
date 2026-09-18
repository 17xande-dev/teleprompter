// The colours an operator can mark a script with, and how they are searched.
//
// DOM-free and apart from the editor for the usual reason: the list and the
// matching are checkable without a browser, while applying a mark needs
// Wordgard (see textColour.ts). The palette dialog turns each of these into a
// Command, so the search, the arrow keys and Enter are the ones the command
// palette already has — there is one fuzzy matcher in this app, not two.
//
// **Every colour here is checked against the viewer's black background**, by
// colours_test.ts, using the same `contrastOnBlack` and `MIN_TEXT_LUMINANCE`
// that decide whether a *pasted* colour needs brightening. That is the point
// of shipping a list rather than a picker: a colour chosen here is one the
// talent can read at ten feet through glass, and the obvious palette does not
// pass — plain `blue` (#0000ff) is 2.44:1 on black, which is why the blue
// below is a much lighter cornflower. The operator can still reach any colour
// at all through the editor's own picker; this is the set with a keystroke.

/** One entry in the colour palette. */
export interface ScriptColour {
  /** Stable id, used in command ids and in the remembered "last colour". */
  id: string;
  /** What the palette shows. */
  name: string;
  /**
   * The CSS colour applied as a mark, or "" for the entry that clears it.
   *
   * Empty means *remove the mark*, not "black": a cleared run inherits
   * `--viewer-color`, so it follows a user theme instead of being pinned to a
   * white that a light theme would make invisible. Same reasoning as
   * contrast.ts dropping a grey rather than replacing it with white.
   */
  hex: string;
  /** Extra words the search should match, e.g. what an operator calls it. */
  keywords?: string[];
}

/** The id of the entry that clears the colour. */
export const DEFAULT_COLOUR_ID = "default";

/**
 * The palette, in the order the dialog lists it.
 *
 * Default first, because "put it back" is the entry reached in a hurry and the
 * one an operator wants without reading. The rest run warm to cool, which is
 * roughly how often a prompter script uses them: yellow and amber for a cue,
 * red for a warning, the cool end for speaker parts and stage directions.
 */
export const SCRIPT_COLOURS: ScriptColour[] = [
  {
    id: DEFAULT_COLOUR_ID,
    name: "Default",
    hex: "",
    keywords: ["none", "clear", "remove", "white", "normal", "reset"],
  },
  { id: "white", name: "White", hex: "#ffffff", keywords: ["plain"] },
  {
    id: "yellow",
    name: "Yellow",
    hex: "#ffd400",
    keywords: ["cue", "emphasis", "highlight"],
  },
  { id: "amber", name: "Amber", hex: "#ff9e2c", keywords: ["orange"] },
  {
    id: "red",
    name: "Red",
    hex: "#ff5c5c",
    keywords: ["warning", "stop", "danger"],
  },
  {
    id: "green",
    name: "Green",
    hex: "#5cff8f",
    keywords: ["go", "safe", "action"],
  },
  { id: "cyan", name: "Cyan", hex: "#5cd8ff", keywords: ["teal", "aqua"] },
  {
    id: "blue",
    name: "Blue",
    hex: "#7aa2ff",
    keywords: ["cornflower", "speaker"],
  },
  { id: "magenta", name: "Magenta", hex: "#ff7ae0", keywords: ["pink"] },
];

/** Look one up by id, for a command or a remembered choice. */
export function colourByID(id: string): ScriptColour | undefined {
  return SCRIPT_COLOURS.find((c) => c.id === id);
}

/**
 * The keywords a palette row should match on, as one string.
 *
 * Kept here rather than built at the call site so the palette's rows and any
 * test agree about what "searchable" means for a colour.
 */
export function colourSearchText(colour: ScriptColour): string {
  return [colour.name, ...(colour.keywords ?? [])].join(" ");
}
