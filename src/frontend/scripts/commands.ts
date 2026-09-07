// The control page's command mechanism: what a command is, how its shortcut is
// written down, and how the palette searches them. Deliberately DOM-free so it
// is testable, the same arrangement as doc.ts / docControls.ts — the DOM half
// is paletteControls.ts, and the actual table of commands is controlCommands.ts.
//
// One list feeds both the palette and the key bindings, so the shortcut shown
// to the operator and the shortcut that fires cannot disagree. validateCommands
// is what turns that from an intention into a checked property.

/** Palette section headings, in the order the palette shows them. */
export const COMMAND_GROUPS = [
  "Scroll",
  "Text",
  "Message",
  "Clocks",
  "Document",
  "Viewers",
  "Help",
] as const;

export type CommandGroup = typeof COMMAND_GROUPS[number];

/**
 * Everything about a command except what it does.
 *
 * Pure data, which is the point: controlCommands.ts can export the real table
 * as an array literal, and a test with no DOM can import it and assert it has
 * no conflicts.
 */
export interface CommandSpec {
  /** Stable identity, e.g. "scroll.toggle". Used as the action-map key. */
  id: string;
  label: string;
  group: CommandGroup;
  /** Readable form, e.g. "Mod+K". Absent means palette-only. */
  shortcut?: string;
  /** Search terms that aren't in the label — "play"/"pause" for a toggle. */
  keywords?: string[];
  /**
   * Whether holding the key fires repeatedly. keydown repeats while held,
   * which is wanted for the speed and scale nudges and would make a toggle
   * like Space strobe the pacer.
   */
  repeatable?: boolean;
  /**
   * Whether this may fire while focus is in a text field. Only chords should
   * set it — a bare key that fires while typing is unusable in an input, which
   * validateCommands rejects.
   */
  allowWhileTyping?: boolean;
}

/** A spec bound to behaviour: what the palette lists and a key binding runs. */
export interface Command extends CommandSpec {
  run(): void | Promise<void>;
}

/**
 * What the palette is showing. "shortcuts" is the cheatsheet: the same dialog,
 * renderer and list, filtered to the commands that have a binding — so the
 * cheatsheet cannot fall out of step with what actually fires.
 */
export type PaletteMode = "all" | "shortcuts";

/**
 * A source of commands, called every time the palette opens.
 *
 * Re-reading on open is what guarantees a dynamic list agrees with storage,
 * the same reasoning as docControls' idempotent rebuild. Only commands without
 * a shortcut may come from a provider, so the key bindings can be installed
 * once at construction and never need rebinding.
 */
export type CommandProvider = () => Command[];

/** The modifier tokens a shortcut may carry. "Mod" is Ctrl, or Cmd on a Mac. */
const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = typeof MODIFIERS[number];

/** Display order for modifiers, so two chords never render inconsistently. */
const MODIFIER_ORDER: Modifier[] = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];

export interface Chord {
  modifiers: Modifier[];
  /** The non-modifier key: "K", "ArrowUp", "Digit0", "Space", "/". */
  key: string;
}

function isModifier(token: string): token is Modifier {
  return (MODIFIERS as readonly string[]).includes(token);
}

/**
 * Split a written shortcut into its modifiers and key, or null if it isn't one.
 *
 * Returning null rather than throwing lets validateCommands collect every
 * problem in the table at once instead of failing on the first.
 */
export function parseShortcut(shortcut: string): Chord | null {
  if (shortcut !== shortcut.trim() || shortcut === "") return null;

  const tokens = shortcut.split("+");
  const key = tokens.pop();
  // A trailing "+" ("Mod+") leaves an empty key, and a modifier in the key
  // position ("Mod+Shift") is a chord that can never fire.
  if (!key || isModifier(key)) return null;
  // "Ctrl Alt" — space-separated, or anything else with whitespace in it —
  // parses as a single unknown key rather than a chord, so reject it here
  // instead of installing a binding that silently never matches.
  if (/\s/.test(key)) return null;

  const modifiers: Modifier[] = [];
  for (const token of tokens) {
    if (!isModifier(token)) return null;
    // A repeated modifier ("Mod+Mod+K") is a typo, not a chord.
    if (modifiers.includes(token)) return null;
    modifiers.push(token);
  }

  return {
    modifiers: MODIFIER_ORDER.filter((m) => modifiers.includes(m)),
    key,
  };
}

/** Whether a chord carries any modifier. A bare key carries none. */
export function shortcutHasModifier(shortcut: string): boolean {
  const chord = parseShortcut(shortcut);
  return chord !== null && chord.modifiers.length > 0;
}

/**
 * Convert a written shortcut into tinykeys' binding syntax.
 *
 * Only "Mod" needs translating — tinykeys spells the platform modifier "$mod"
 * and lowercases the rest itself. The key is passed through untouched, because
 * tinykeys matches it against both `event.key` (case-insensitively) and
 * `event.code`: "K" matches the key, "Digit0" and "Space" match the code.
 */
export function toTinykeys(shortcut: string): string | null {
  const chord = parseShortcut(shortcut);
  if (!chord) return null;
  const mods = chord.modifiers.map((m) => (m === "Mod" ? "$mod" : m));
  return [...mods, chord.key].join("+");
}

/**
 * How a key renders in the palette. Keys named after a physical position
 * ("Digit0", "KeyP") exist so the binding survives a non-US layout and macOS's
 * Option-glyph substitution, but the operator should never see those names.
 */
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Equal: "=",
  Minus: "-",
  Escape: "Esc",
};

const APPLE_KEY_LABELS: Record<string, string> = {
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
};

const MODIFIER_LABELS: Record<Modifier, string> = {
  Mod: "Ctrl",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Meta",
};

const APPLE_MODIFIER_LABELS: Record<Modifier, string> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Meta: "⌘",
};

function keyLabel(key: string, apple: boolean): string {
  if (apple && key in APPLE_KEY_LABELS) return APPLE_KEY_LABELS[key];
  if (key in KEY_LABELS) return KEY_LABELS[key];
  // "KeyP" → "P", "Digit0" → "0": strip the physical-position prefix.
  const physical = /^(?:Key([A-Z])|Digit(\d))$/.exec(key);
  if (physical) return physical[1] ?? physical[2];
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Render a shortcut for display.
 *
 * `apple` is injected rather than sniffed here so both branches are testable;
 * the DOM half decides it once from the platform. A palette that lies about
 * its own bindings is worse than one with no shortcuts at all.
 */
export function formatShortcut(
  shortcut: string,
  { apple }: { apple: boolean },
): string {
  const chord = parseShortcut(shortcut);
  if (!chord) return "";
  const labels = chord.modifiers.map((m) =>
    apple ? APPLE_MODIFIER_LABELS[m] : MODIFIER_LABELS[m]
  );
  const key = keyLabel(chord.key, apple);
  // Apple convention runs the symbols together (⌘⌥0); everywhere else the
  // parts are joined with "+".
  return apple ? [...labels, key].join("") : [...labels, key].join("+");
}

/** Rank buckets, best first. The gaps leave room to insert finer rules. */
const Score = {
  LabelExact: 100,
  LabelPrefix: 80,
  LabelWordPrefix: 60,
  LabelSubstring: 40,
  KeywordMatch: 20,
  GroupMatch: 10,
  None: 0,
} as const;

function scoreCommand(command: Command, query: string): number {
  const label = command.label.toLowerCase();
  if (label === query) return Score.LabelExact;
  if (label.startsWith(query)) return Score.LabelPrefix;
  // A match at a word boundary is what the operator means by "scale" when the
  // command is "Text scale larger".
  if (new RegExp(`\\b${escapeRegExp(query)}`).test(label)) {
    return Score.LabelWordPrefix;
  }
  if (label.includes(query)) return Score.LabelSubstring;
  if (command.keywords?.some((k) => k.toLowerCase().includes(query))) {
    return Score.KeywordMatch;
  }
  if (command.group.toLowerCase().includes(query)) return Score.GroupMatch;
  return Score.None;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Commands in palette order: by group, then as registered. */
export function orderCommands(commands: Command[]): Command[] {
  return commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => {
      const group = COMMAND_GROUPS.indexOf(a.command.group) -
        COMMAND_GROUPS.indexOf(b.command.group);
      return group !== 0 ? group : a.index - b.index;
    })
    .map(({ command }) => command);
}

/**
 * The palette's search: matching commands, best first.
 *
 * Ties break on the command's position in the ordered list rather than being
 * left to the sort, because a palette whose top row flickers between renders
 * reads as a bug — and the top row is what Enter runs.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const ordered = orderCommands(commands);
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return ordered;

  return ordered
    .map((command, index) => ({
      command,
      index,
      score: scoreCommand(command, trimmed),
    }))
    .filter(({ score }) => score !== Score.None)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map(({ command }) => command);
}

/**
 * Everything wrong with a command table, as human-readable problems.
 *
 * Run over the real table by commands_test.ts. A duplicate shortcut is the
 * failure this exists for: tinykeys would bind both and only one would ever
 * fire, while the palette went on advertising each of them.
 */
export function validateCommands(specs: CommandSpec[]): string[] {
  const problems: string[] = [];
  const seenIDs = new Set<string>();
  const seenBindings = new Map<string, string>();

  for (const spec of specs) {
    if (seenIDs.has(spec.id)) problems.push(`duplicate id ${spec.id}`);
    seenIDs.add(spec.id);

    if (!(COMMAND_GROUPS as readonly string[]).includes(spec.group)) {
      problems.push(`${spec.id} has unknown group ${spec.group}`);
    }

    if (spec.shortcut === undefined) {
      // A palette-only command can't be typed at, so the flag would be a lie.
      if (spec.allowWhileTyping) {
        problems.push(`${spec.id} sets allowWhileTyping with no shortcut`);
      }
      continue;
    }

    const binding = toTinykeys(spec.shortcut);
    if (!binding) {
      problems.push(`${spec.id} has unparseable shortcut ${spec.shortcut}`);
      continue;
    }

    const owner = seenBindings.get(binding);
    if (owner) {
      problems.push(
        `${spec.id} and ${owner} both bind ${spec.shortcut}`,
      );
    }
    seenBindings.set(binding, spec.id);

    if (spec.allowWhileTyping && !shortcutHasModifier(spec.shortcut)) {
      problems.push(
        `${spec.id} lets bare ${spec.shortcut} fire while typing`,
      );
    }
  }

  return problems;
}
