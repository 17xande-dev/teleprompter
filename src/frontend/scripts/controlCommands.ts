// The control page's actual commands: the table, and how each one acts.
//
// Two things about the shape of this file are deliberate.
//
// COMMAND_SPECS is a plain array literal and nothing at module scope touches
// the DOM, so commands_test.ts can import the *real* table and check it for
// conflicts. That check is the only reason "the palette and the keys can't
// disagree" is a fact rather than a hope.
//
// And it does not import teleprompter.ts, not even for a type. That import
// would pull the control page's raw CSS imports into the test's module graph,
// which only the bundler can resolve — the failure deno.jsonc documents as the
// reason `deno test` runs --no-check. CommandHost describes what a command
// needs instead, and Teleprompter satisfies it structurally.

import type { Command, CommandSpec, PaletteMode } from "./commands.ts";

/** A slider the commands nudge. Web Awesome's wa-slider satisfies this. */
interface Slider {
  value: number;
  dispatchEvent(event: Event): boolean;
}

interface Clickable {
  click(): void;
}

/**
 * What the commands need from the control page.
 *
 * Every member here is something `Teleprompter` already exposes, with one
 * exception (`toggleAutoScroll`) that is a move of its old Space-bar handler.
 */
export interface CommandHost {
  btnPop: Clickable;
  btnMessage: Clickable;
  rngSpeed: Slider;
  rngScale: Slider;
  tpClockControl: {
    btnStart: Clickable;
    btnStop: Clickable;
    btnReset: Clickable;
  };
  docControls: { create(): void };
  lnkViewerLink: { href: string };
  palette: { open(mode: PaletteMode): void };
  closePdf(): void;
  toggleAutoScroll(): void;
}

/** How far one nudge moves each slider. */
const SPEED_STEP = 10;
const SPEED_STEP_LARGE = 50;
const SCALE_STEP = 5;

export const COMMAND_SPECS: CommandSpec[] = [
  {
    id: "scroll.toggle",
    label: "Start / stop scrolling",
    group: "Scroll",
    shortcut: "Space",
    keywords: ["play", "pause", "resume"],
  },
  {
    id: "speed.up",
    label: "Scroll faster",
    group: "Scroll",
    shortcut: "Mod+ArrowUp",
    repeatable: true,
  },
  {
    id: "speed.down",
    label: "Scroll slower",
    group: "Scroll",
    shortcut: "Mod+ArrowDown",
    repeatable: true,
  },
  {
    id: "speed.up.large",
    label: "Scroll faster (large step)",
    group: "Scroll",
    shortcut: "Mod+Shift+ArrowUp",
    repeatable: true,
  },
  {
    id: "speed.down.large",
    label: "Scroll slower (large step)",
    group: "Scroll",
    shortcut: "Mod+Shift+ArrowDown",
    repeatable: true,
  },
  {
    // Distinct from pausing: this leaves the pacer running at zero, which is
    // what the operator wants when the next cue is a jump rather than a
    // resume.
    id: "speed.zero",
    label: "Set scroll speed to zero",
    group: "Scroll",
    shortcut: "Mod+Alt+Digit0",
    keywords: ["stop", "halt", "still"],
  },
  {
    id: "scale.up",
    label: "Bigger text",
    group: "Text",
    shortcut: "Mod+Alt+Equal",
    keywords: ["zoom", "larger", "scale"],
    repeatable: true,
  },
  {
    id: "scale.down",
    label: "Smaller text",
    group: "Text",
    shortcut: "Mod+Alt+Minus",
    keywords: ["zoom", "scale"],
    repeatable: true,
  },
  {
    // The one binding that earns its keep most: type the message, send it
    // without reaching for the mouse.
    id: "message.send",
    label: "Send message",
    group: "Message",
    shortcut: "Mod+Enter",
    allowWhileTyping: true,
  },
  {
    id: "message.clear",
    label: "Clear message",
    group: "Message",
    keywords: ["blank", "remove"],
  },
  { id: "clock.start", label: "Start countdown", group: "Clocks" },
  { id: "clock.stop", label: "Stop countdown", group: "Clocks" },
  { id: "clock.reset", label: "Reset countdown", group: "Clocks" },
  { id: "document.new", label: "New document", group: "Document" },
  { id: "pdf.close", label: "Close PDF", group: "Document" },
  {
    id: "viewer.pop",
    label: "Pop out viewer window",
    group: "Viewers",
    shortcut: "Mod+Alt+KeyP",
    keywords: ["popup", "screen", "display"],
  },
  {
    id: "viewer.copyLink",
    label: "Copy viewer link",
    group: "Viewers",
    keywords: ["share", "url"],
  },
  {
    id: "palette.open",
    label: "Command palette",
    group: "Help",
    shortcut: "Mod+K",
    allowWhileTyping: true,
  },
  {
    id: "help.shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    shortcut: "Mod+/",
    keywords: ["cheatsheet", "keys", "help"],
    allowWhileTyping: true,
  },
];

/**
 * What the document commands need. `DocControls` satisfies it.
 *
 * Structural again, so a test can hand these providers a plain object and
 * check what they produce without a DOM or a localStorage.
 */
export interface DocumentHost {
  storage: {
    list(): [string, { name: string }][];
    getCurrentID(): string;
  };
  load(id: string): void;
}

/** What the layout commands need. `ThemeControls` satisfies it. */
export interface LayoutHost {
  storage: {
    layouts(): [string, string][];
    getLayout(): string;
  };
  apply(layout: string): void;
}

/**
 * One "open this document" command per stored document.
 *
 * A provider rather than part of COMMAND_SPECS because the list changes as
 * documents come and go, and it is re-read on every palette open so it cannot
 * show a document that has been deleted. None of these carry a shortcut —
 * that is the rule that lets the key bindings be installed exactly once.
 */
export function documentCommands(host: DocumentHost): Command[] {
  const current = host.storage.getCurrentID();
  return host.storage.list().map(([id, doc]): Command => ({
    id: `document.open.${id}`,
    // Prefixed so the whole set is reachable by typing "open", and so a
    // document called "Scroll faster" can't be mistaken for the command.
    label: `Open: ${doc.name}`,
    group: "Document",
    hint: id === current ? "open" : undefined,
    keywords: ["document", "script"],
    run: () => host.load(id),
  }));
}

/** One "wear this layout" command per layout, built-in and user-authored. */
export function layoutCommands(host: LayoutHost): Command[] {
  const current = host.storage.getLayout();
  return host.storage.layouts().map(([layout, name]): Command => ({
    id: `layout.apply.${layout}`,
    label: `Layout: ${name}`,
    group: "Layout",
    hint: layout === current ? "current" : undefined,
    keywords: ["theme", "viewer"],
    run: () => host.apply(layout),
  }));
}

/**
 * Move a slider and tell the page, exactly as dragging it would.
 *
 * The "input" event is what listenRangeSpeed/listenRangeScale already listen
 * for, so a command and a drag end up in the same handler and cannot diverge.
 * Clamping is left to the component, which is also what listenSpeedWheel does.
 */
function nudge(slider: Slider, delta: number) {
  slider.value += delta;
  slider.dispatchEvent(new Event("input"));
}

/**
 * Bind the table to the control page.
 *
 * Commands act by pressing the controls the operator would have clicked. That
 * is not laziness: it means a command and a click are the same code path. The
 * clock is the case that proves it — clock.ts's click handler both dispatches
 * the event teleprompter.ts listens for *and* drives the local countdown, and
 * that event doesn't bubble, so a synthetic one would do half the job.
 */
export function buildCommands(host: CommandHost): Command[] {
  const actions: Record<string, () => void | Promise<void>> = {
    "scroll.toggle": () => host.toggleAutoScroll(),
    "speed.up": () => nudge(host.rngSpeed, SPEED_STEP),
    "speed.down": () => nudge(host.rngSpeed, -SPEED_STEP),
    "speed.up.large": () => nudge(host.rngSpeed, SPEED_STEP_LARGE),
    "speed.down.large": () => nudge(host.rngSpeed, -SPEED_STEP_LARGE),
    "speed.zero": () => {
      host.rngSpeed.value = 0;
      host.rngSpeed.dispatchEvent(new Event("input"));
    },
    "scale.up": () => nudge(host.rngScale, SCALE_STEP),
    "scale.down": () => nudge(host.rngScale, -SCALE_STEP),
    "message.send": () => host.btnMessage.click(),
    "message.clear": () => {
      // Queried here rather than held on the host because that is what
      // listenMessage itself does — the input is read fresh every send.
      const input = document.querySelector<HTMLInputElement>("#txtMessage");
      if (input) input.value = "";
      host.btnMessage.click();
    },
    "clock.start": () => host.tpClockControl.btnStart.click(),
    "clock.stop": () => host.tpClockControl.btnStop.click(),
    "clock.reset": () => host.tpClockControl.btnReset.click(),
    "document.new": () => host.docControls.create(),
    "pdf.close": () => host.closePdf(),
    "viewer.pop": () => host.btnPop.click(),
    "viewer.copyLink": () =>
      navigator.clipboard.writeText(host.lnkViewerLink.href),
    // Read through the host when the key fires, not now: the palette is
    // constructed *from* this list, so it does not exist yet.
    "palette.open": () => host.palette.open("all"),
    "help.shortcuts": () => host.palette.open("shortcuts"),
  };

  return COMMAND_SPECS.map((spec) => {
    const run = actions[spec.id];
    if (!run) {
      // Reachable only by adding a spec and forgetting its action, in which
      // case the palette would list a row that does nothing when picked.
      throw new Error(`command ${spec.id} has no action`);
    }
    return { ...spec, run };
  });
}
