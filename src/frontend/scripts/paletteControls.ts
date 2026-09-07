// The control page's command palette and key bindings: the DOM half of
// commands.ts, in the same arrangement as docControls.ts / doc.ts. It adopts
// #dlgPalette from index.html the way the other controls adopt their markup,
// and it owns the tinykeys installation because the palette and the bindings
// have to read the same list to stay honest with each other.

import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import { type KeyBindingMap, tinykeys } from "tinykeys";

import {
  type Command,
  type CommandProvider,
  type CommandSpec,
  filterCommands,
  formatShortcut,
  type PaletteMode,
  toTinykeys,
} from "./commands.ts";
import { escapeHtml } from "./dom.ts";

interface PaletteOptions {
  /**
   * Whether the script editor holds focus.
   *
   * A callback, not the editor itself: `Teleprompter.editor` is *reassigned*
   * every time a document loads, so a captured instance would soon be
   * reporting the focus of an editor that is no longer on the page.
   */
  isEditorFocused(): boolean;
  /**
   * Sources of commands that come and go — the stored documents, the viewer
   * layouts. Called on every open rather than cached, so the palette can't
   * offer a document that has since been deleted.
   */
  providers?: CommandProvider[];
}

/**
 * Whether this node takes typed text.
 *
 * Checked against `composedPath()[0]`, never `event.target`. At a window-level
 * listener the event has been retargeted: for a keypress inside a wa-input's
 * shadow <input>, `target` is the wa-input host and searching it for an
 * <input> finds nothing — so a guard written against `target` reads correctly
 * and silently lets every shortcut fire while the operator types.
 */
export function isTypingTarget(node: EventTarget | null | undefined): boolean {
  if (!(node instanceof Element)) return false;
  // Covers Wordgard's contentDOM and CodeMirror's .cm-content.
  if (node instanceof HTMLElement && node.isContentEditable) return true;
  const tag = node.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  // The light-DOM case: focus is on the Web Awesome host itself.
  return node.closest("wa-input, wa-textarea, wa-select, wa-slider") !== null;
}

/**
 * Whether Space or Enter would activate this node.
 *
 * Without this the likeliest bug report writes itself: click "Send Message",
 * focus stays on the button, and the next Space both re-sends the message and
 * toggles the scroll.
 */
export function isActivatable(node: EventTarget | null | undefined): boolean {
  if (!(node instanceof Element)) return false;
  const tag = node.tagName.toLowerCase();
  if (tag === "button" || tag === "summary") return true;
  return node.closest(
    "button, a[href], [role=button], wa-button, wa-dropdown-item, wa-tab",
  ) !== null;
}

/** Whether a chord modifier is held. Shift alone still counts as a bare key. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

function detectApple(): boolean {
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export class PaletteControls {
  #dlg: WaDialog;
  #input: WaInput;
  #list: HTMLDivElement;

  #commands: Command[];
  #providers: CommandProvider[];
  /** The dynamic commands as of the current open. Empty while closed. */
  #dynamic: Command[] = [];
  #isEditorFocused: () => boolean;
  #apple = detectApple();

  #mode: PaletteMode = "all";
  /** What the list is currently showing — the array Enter indexes into. */
  #shown: Command[] = [];
  #selected = 0;

  constructor(commands: Command[], options: PaletteOptions) {
    this.#commands = commands;
    this.#providers = options.providers ?? [];
    this.#isEditorFocused = options.isEditorFocused;

    this.#dlg = document.querySelector("#dlgPalette")!;
    this.#input = document.querySelector("#txtPalette")!;
    this.#list = document.querySelector("#divPaletteList")!;

    this.#input.addEventListener("input", () => {
      this.#selected = 0;
      this.#renderList();
    });
    // On the dialog rather than the input, because the cheatsheet mode hides
    // the input and its keys still have to work.
    this.#dlg.addEventListener(
      "keydown",
      this.#listenKeys.bind(this) as EventListener,
    );
    this.#list.addEventListener("pointermove", this.#listenHover.bind(this));
    this.#list.addEventListener("click", this.#listenClick.bind(this));
    this.#dlg.addEventListener("wa-after-show", () => this.#input.focus());
    // Clear on the way out, so the next open starts from everything rather
    // than from whatever the operator typed last time.
    this.#dlg.addEventListener("wa-after-hide", () => {
      this.#input.value = "";
      // Dropped rather than kept: holding document names open would mean the
      // next open briefly rendered a stale list before the providers ran.
      this.#dynamic = [];
    });

    this.#bindShortcuts();
    this.#renderList();
  }

  /** Show the palette, either as the command list or as the cheatsheet. */
  open(mode: PaletteMode) {
    this.#mode = mode;
    // Re-read every time, so the list matches storage rather than whatever it
    // held when the page loaded. `shortcut` is stripped because these are
    // never bound: advertising a key that does nothing is exactly the drift
    // the one-list arrangement exists to prevent.
    this.#dynamic = this.#providers
      .flatMap((provider) => provider())
      .map((command) => ({ ...command, shortcut: undefined }));
    this.#input.value = "";
    this.#input.hidden = mode === "shortcuts";
    this.#dlg.label = mode === "shortcuts" ? "Keyboard Shortcuts" : "Commands";
    this.#selected = 0;
    this.#renderList();
    this.#dlg.open = true;
  }

  close() {
    this.#dlg.open = false;
  }

  /**
   * Install every binding in the table, once.
   *
   * Once is all it takes because a command that carries a shortcut is always
   * static — the rule that keeps a dynamic palette list from ever needing the
   * keymap torn down and reinstalled.
   */
  #bindShortcuts() {
    const map: KeyBindingMap = {};
    for (const command of this.#commands) {
      if (!command.shortcut) continue;
      const binding = toTinykeys(command.shortcut);
      // Unparseable or duplicated bindings are a table bug, caught by
      // validateCommands in commands_test.ts rather than papered over here.
      if (!binding) continue;
      map[binding] = (event) => {
        if (this.#shouldIgnore(command, event)) return;
        event.preventDefault();
        command.run();
      };
    }
    tinykeys(globalThis as unknown as Window, map);
  }

  /** Whether a command must sit this keypress out. */
  #shouldIgnore(spec: CommandSpec, event: KeyboardEvent): boolean {
    // keydown repeats while held. Wanted for the nudges; a toggle that
    // repeated would strobe the pacer.
    if (event.repeat && !spec.repeatable) return true;

    // Any open dialog is modal and owns the keyboard — the theme editor's
    // CodeMirror, the rename prompt, both delete confirmations, and anything
    // added later, in one check. The palette is included deliberately: while
    // it is open it handles its own keys and tinykeys is inert.
    //
    // The `open` *property* is read rather than matching wa-dialog[open],
    // because Web Awesome reflects that attribute on a microtask: a keypress
    // is always a later task so the selector would in fact work, but a guard
    // this load-bearing shouldn't rest on another library's render timing.
    if (this.#anyDialogOpen()) return true;

    if (spec.allowWhileTyping) return false;

    if (this.#isEditorFocused()) return true;
    const deep = event.composedPath()[0];
    if (isTypingTarget(deep)) return true;
    if (!hasModifier(event) && isActivatable(deep)) return true;
    return false;
  }

  #anyDialogOpen(): boolean {
    return [...document.querySelectorAll<WaDialog>("wa-dialog")]
      .some((dialog) => dialog.open);
  }

  #listenKeys(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        this.#consume(event);
        this.#move(1);
        break;
      case "ArrowUp":
        this.#consume(event);
        this.#move(-1);
        break;
      case "Home":
        this.#consume(event);
        this.#select(0);
        break;
      case "End":
        this.#consume(event);
        this.#select(this.#shown.length - 1);
        break;
      case "Enter":
        this.#consume(event);
        this.#run(this.#selected);
        break;
      default:
        // Everything else belongs to the input.
    }
  }

  // Stopped as well as prevented: this dialog's keys bubble to the window,
  // where tinykeys is listening, and Enter would otherwise reach a binding.
  #consume(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  #listenHover(event: PointerEvent) {
    const index = this.#indexOf(event.target);
    // Hover and the keyboard share one highlight — two of them moving
    // independently reads as a bug, and Enter only follows one of them.
    if (index !== null && index !== this.#selected) this.#select(index);
  }

  #listenClick(event: MouseEvent) {
    const index = this.#indexOf(event.target);
    if (index !== null) this.#run(index);
  }

  #indexOf(target: EventTarget | null): number | null {
    if (!(target instanceof Element)) return null;
    const row = target.closest("[data-palette-index]");
    if (!row) return null;
    return Number(row.getAttribute("data-palette-index"));
  }

  #move(delta: number) {
    this.#select(this.#selected + delta);
  }

  #select(index: number) {
    if (this.#shown.length === 0) return;
    // Clamped rather than wrapped: holding ArrowDown should come to rest at
    // the end of the list, not cycle past it.
    this.#selected = Math.max(0, Math.min(index, this.#shown.length - 1));
    this.#renderList();
    this.#list.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }

  #run(index: number) {
    const command = this.#shown[index];
    if (!command) return;
    // Close first: a command that opens another dialog would otherwise fight
    // this one for focus as it closes.
    this.close();
    command.run();
  }

  /** One idempotent rebuild, as docControls does for its dropdown. */
  #renderList() {
    // The cheatsheet lists bindings, and a dynamic command can never have
    // one, so it is drawn from the static table alone.
    const pool = this.#mode === "shortcuts"
      ? this.#commands.filter((c) => c.shortcut)
      : [...this.#commands, ...this.#dynamic];
    this.#shown = filterCommands(pool, this.#input.value ?? "");
    if (this.#selected >= this.#shown.length) {
      this.#selected = Math.max(0, this.#shown.length - 1);
    }

    if (this.#shown.length === 0) {
      this.#list.innerHTML =
        `<div class="palette-empty">No matching command</div>`;
      return;
    }

    let html = "";
    let group = "";
    this.#shown.forEach((command, index) => {
      if (command.group !== group) {
        group = command.group;
        html += `<div class="palette-group">${escapeHtml(group)}</div>`;
      }
      // Labels are escaped because the dynamic commands carry operator-typed
      // document and theme names, and the control page holds the room key —
      // the same reasoning as dom.ts's own comment.
      const keys = command.shortcut
        ? `<kbd class="palette-keys">${
          escapeHtml(formatShortcut(command.shortcut, { apple: this.#apple }))
        }</kbd>`
        : command.hint
        ? `<span class="palette-hint">${escapeHtml(command.hint)}</span>`
        : "";
      html +=
        `<div class="palette-item" role="option" data-palette-index="${index}" aria-selected="${
          index === this.#selected
        }"><span class="palette-label">${
          escapeHtml(command.label)
        }</span>${keys}</div>`;
    });
    this.#list.innerHTML = html;
  }
}
