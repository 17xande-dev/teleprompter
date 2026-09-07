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

import {
  applyPadBindings,
  type Command,
  type CommandSpec,
  type PaletteMode,
} from "./commands.ts";
import { PAD_BINDINGS, PAD_LABELS } from "./gamepad.ts";

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
  btnGoToViewers: Clickable;
  btnSendPosition: Clickable;
  btnMatchScale: Clickable;
  btnSendScale: Clickable;
  rngSpeed: Slider;
  rngScale: Slider;
  rngEditor: Slider;
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
  resetSliders(): void;
}

/** How far one nudge moves each slider. */
const SPEED_STEP = 10;
const SPEED_STEP_LARGE = 50;
const SCALE_STEP = 5;
// Tenths of a rem, so two is 0.2rem — a smaller step than the viewers' because
// the operator is looking straight at the result and nudges it to taste.
const EDITOR_STEP = 2;

export const COMMAND_SPECS: CommandSpec[] = [
  {
    id: "scroll.toggle",
    label: "Start / stop scrolling",
    group: "Scroll",
    shortcut: "Space",
    keywords: ["play", "pause", "resume"],
  },
  {
    // Down is faster, up is slower: to scroll forward is to scroll *down* the
    // script, so the arrow points the way the text travels. Note this is the
    // opposite of the slider's own geometry — Forward sits at the bottom, so
    // "faster" also steps the thumb downward. The two agree by coincidence of
    // metaphor, not by construction; the sign lives in the action below.
    id: "speed.up",
    label: "Scroll faster",
    group: "Scroll",
    shortcut: "Mod+ArrowDown",
    repeatable: true,
  },
  {
    id: "speed.down",
    label: "Scroll slower",
    group: "Scroll",
    shortcut: "Mod+ArrowUp",
    repeatable: true,
  },
  {
    id: "speed.up.large",
    label: "Scroll faster (large step)",
    group: "Scroll",
    shortcut: "Mod+Shift+ArrowDown",
    repeatable: true,
  },
  {
    id: "speed.down.large",
    label: "Scroll slower (large step)",
    group: "Scroll",
    shortcut: "Mod+Shift+ArrowUp",
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
    // The operator's pane reads ahead of the viewers on purpose, so these two
    // are how the gap gets closed deliberately in either direction.
    id: "position.get",
    label: "Go to viewers' position",
    group: "Scroll",
    shortcut: "Mod+Alt+KeyG",
    keywords: ["jump", "catch up", "where", "sync"],
  },
  {
    id: "position.send",
    label: "Send my position to viewers",
    group: "Scroll",
    shortcut: "Mod+Alt+KeyJ",
    keywords: ["jump", "cue", "skip", "sync"],
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
    // No shortcut on either: they are set-up actions taken once before a
    // service, not things reached for mid-scroll, and the chord set is already
    // long enough to have to be looked up.
    id: "scale.match",
    label: "Match viewers' text size",
    group: "Text",
    keywords: ["sync", "size", "font", "same"],
  },
  {
    id: "scale.send",
    label: "Send my text size to viewers",
    group: "Text",
    keywords: ["sync", "size", "font", "push"],
  },
  {
    // The operator's own pane, not the viewers': same group because "Text" is
    // where an operator looks for a size, and the labels say whose text it is.
    id: "editor.up",
    label: "Bigger editor text",
    group: "Text",
    // Mod+Alt+Equal/Minus are the viewers' size; the brackets are free.
    // Physical key names, as anything carrying Alt must be.
    shortcut: "Mod+Alt+BracketRight",
    keywords: ["zoom", "larger", "script", "mine", "editor"],
    repeatable: true,
  },
  {
    id: "editor.down",
    label: "Smaller editor text",
    group: "Text",
    shortcut: "Mod+Alt+BracketLeft",
    keywords: ["zoom", "script", "mine", "editor"],
    repeatable: true,
  },
  {
    // No shortcut: a right-click on a slider is the gesture, and this is how an
    // operator finds out that it exists.
    id: "transport.reset",
    label: "Reset sliders to defaults",
    group: "Scroll",
    keywords: ["default", "zero", "slider", "speed", "size"],
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
    // A *negative* step is faster. Wire speed is `-rngSpeed.value`, which is
    // what puts Forward at the bottom of the vertical slider so the thumb
    // travels the way the text does (the same metaphor as listenSpeedWheel's
    // `value += -e.deltaY`). These commands are named for the speed the
    // operator wants, not the direction the thumb moves — so speed.up steps
    // the value *down*. The two used to disagree, and "Scroll faster" scrolled
    // backwards; commands_test.ts guards the sign.
    "speed.up": () => nudge(host.rngSpeed, -SPEED_STEP),
    "speed.down": () => nudge(host.rngSpeed, SPEED_STEP),
    "speed.up.large": () => nudge(host.rngSpeed, -SPEED_STEP_LARGE),
    "speed.down.large": () => nudge(host.rngSpeed, SPEED_STEP_LARGE),
    "speed.zero": () => {
      host.rngSpeed.value = 0;
      host.rngSpeed.dispatchEvent(new Event("input"));
    },
    "position.get": () => host.btnGoToViewers.click(),
    "position.send": () => host.btnSendPosition.click(),
    "scale.up": () => nudge(host.rngScale, SCALE_STEP),
    "scale.down": () => nudge(host.rngScale, -SCALE_STEP),
    // No sign inversion on this one, unlike speed.*: the editor slider is
    // max-at-top like any other, and bigger text is a bigger number.
    "editor.up": () => nudge(host.rngEditor, EDITOR_STEP),
    "editor.down": () => nudge(host.rngEditor, -EDITOR_STEP),
    "transport.reset": () => host.resetSliders(),
    "scale.match": () => host.btnMatchScale.click(),
    "scale.send": () => host.btnSendScale.click(),
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

  // The controller buttons are stamped on here rather than written into the
  // table, so the button the palette shows is the button gamepadControls.ts
  // actually dispatches.
  return applyPadBindings(COMMAND_SPECS, PAD_BINDINGS, PAD_LABELS).map(
    (spec) => {
      const run = actions[spec.id];
      if (!run) {
        // Reachable only by adding a spec and forgetting its action, in which
        // case the palette would list a row that does nothing when picked.
        throw new Error(`command ${spec.id} has no action`);
      }
      return { ...spec, run };
    },
  );
}
