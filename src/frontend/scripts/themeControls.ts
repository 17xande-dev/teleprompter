// The control page's UI for viewer themes: the layout dropdown, the CSS
// editor dialog and the delete confirmation. The DOM half of themes.ts, split
// out for the same reason DocControls is split from DocStorage — and so
// themes.ts can stay DOM-free and therefore testable.

import WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import type WaIcon from "@awesome.me/webawesome/dist/components/icon/icon.js";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import type { EditorView } from "@codemirror/view";

import { cssText, newCssEditor } from "./cssEditor.ts";
import { escapeHtml } from "./dom.ts";
import type { ThemeMessage } from "./protocol.ts";
import {
  DEFAULT_LAYOUT,
  findThemeCssProblems,
  isUserLayout,
  type Theme,
  THEME_TEMPLATE,
  ThemeStorage,
} from "./themes.ts";

type WaSelectEvent = CustomEvent<{ item: WaDropdownItem }>;

// How long to sit on a keystroke before pushing the CSS to every viewer.
// Each push is a whole stylesheet on the reliable channel, which shares an
// SCTP association with the scroll channel — the same reasoning as
// #pushSettings' per-frame coalescing, just at a coarser grain because a
// stylesheet is far bigger than a slider value and nobody types at 60Hz.
const CSS_PUSH_DEBOUNCE_MS = 200;

export class ThemeControls {
  storage = new ThemeStorage();
  drpLayouts: WaDropdown;

  #dlgTheme: WaDialog;
  #dlgDelete: WaDialog;
  #txtName: WaInput;
  #editorMount: HTMLDivElement;
  #problems: HTMLDivElement;
  #trigger: HTMLElement;
  #editor: EditorView | null = null;
  // Not `number`: with the deno libs in play setTimeout is typed as returning
  // a Timeout, which is what the long-standing clock.ts:192 error is about.
  #pushTimer: ReturnType<typeof setTimeout> | undefined;

  // Dialog session state. A theme is applied *while* it is being edited —
  // that is what makes the preview beside the dialog a live feedback loop —
  // so cancelling has to undo both the edit and the activation.
  #editingSlug = "";
  #isNew = false;
  #restoreLayout = DEFAULT_LAYOUT;
  #restoreTheme: Theme | null = null;

  constructor() {
    this.drpLayouts = document.querySelector("#drpLayouts")!;
    this.#dlgTheme = document.querySelector("#dlgTheme")!;
    this.#dlgDelete = document.querySelector("#dlgThemeDelete")!;
    this.#txtName = document.querySelector("#txtThemeName")!;
    this.#editorMount = document.querySelector("#divThemeEditor")!;
    this.#problems = document.querySelector("#divThemeProblems")!;
    this.#trigger = this.drpLayouts.querySelector("[slot=trigger]")!;

    this.drpLayouts.addEventListener(
      "wa-select",
      this.#listenSelect.bind(this) as EventListener,
    );

    this.#dlgTheme.querySelector("wa-button[name=save]")!
      .addEventListener("click", () => this.#saveDialog());
    this.#dlgTheme.querySelector("wa-button[name=cancel]")!
      .addEventListener("click", () => this.#cancelDialog());
    // The dialog's own dismissal paths (Escape, the close button, the
    // backdrop) don't go through the Cancel button, and leaving a
    // half-committed edit applied to every viewer is the worst outcome here.
    this.#dlgTheme.addEventListener("wa-hide", () => {
      if (this.#editingSlug) this.#cancelDialog();
    });

    this.#dlgDelete.querySelector("wa-button[name=delete]")!
      .addEventListener("click", () => this.#confirmDelete());
    this.#dlgDelete.querySelector("wa-button[name=cancel]")!
      .addEventListener("click", () => {
        this.#dlgDelete.open = false;
      });

    this.#renderItems();
    this.#renderTrigger();
  }

  /**
   * The message that puts a viewer in the current layout. Read by the control
   * page both when the operator changes layout and — the path that is easy to
   * forget — when a viewer joins or reconnects, which is the only way a
   * reloaded viewer ever learns its theme.
   */
  themeMessage(): ThemeMessage {
    const layout = this.storage.getLayout();
    const theme = isUserLayout(layout) ? this.storage.get(layout) : undefined;
    return { type: "theme", layout, css: theme?.css ?? null };
  }

  #emit() {
    this.drpLayouts.dispatchEvent(
      new CustomEvent<ThemeMessage>("theme", {
        detail: this.themeMessage(),
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Put every viewer in this layout. Also a palette command. */
  apply(layout: string) {
    if (!this.storage.has(layout)) return;
    this.storage.setLayout(layout);
    this.#renderTrigger();
    this.#emit();
  }

  #renderTrigger() {
    // Naming the active layout on the trigger beats a checkmark buried in a
    // closed menu: on a control page driving a live service, "which layout am
    // I on" has to be answerable without opening anything.
    const layout = this.storage.getLayout();
    this.#trigger.textContent = `Layout: ${this.storage.layoutName(layout)}`;
    const icon = document.createElement("wa-icon");
    icon.setAttribute("slot", "start");
    icon.setAttribute("name", "window-maximize");
    this.#trigger.prepend(icon);
  }

  #renderItems() {
    for (const el of this.drpLayouts.querySelectorAll("[data-theme-item]")) {
      el.remove();
    }
    const divider = this.drpLayouts.querySelector("#divThemeSplit")!;
    for (const [slug, theme] of this.storage.list()) {
      divider.before(this.#genMenuItem(slug, theme.name));
    }
  }

  // Same shape as DocControls.genMenuItem: a parent item carrying the name,
  // with the actions in its submenu, dispatched on the icon name.
  #genMenuItem(slug: string, name: string): WaDropdownItem {
    const item = new WaDropdownItem();
    item.dataset.themeItem = "";
    item.value = slug;
    item.innerHTML = `${escapeHtml(name)}
      <wa-icon slot="icon" name="palette"></wa-icon>
      <wa-dropdown-item slot="submenu">Apply
        <wa-icon slot="icon" name="folder-open" label="Apply"></wa-icon>
      </wa-dropdown-item>
      <wa-dropdown-item slot="submenu">Edit CSS
        <wa-icon slot="icon" name="code" label="Edit CSS"></wa-icon>
      </wa-dropdown-item>
      <wa-dropdown-item slot="submenu" variant="danger">Delete
        <wa-icon slot="icon" name="trash" label="Delete"></wa-icon>
      </wa-dropdown-item>
    `;
    // The submenu items carry the slug too: wa-select reports the item that
    // was chosen, not its parent.
    for (const sub of item.querySelectorAll("[slot=submenu]")) {
      (<WaDropdownItem> sub).value = slug;
    }
    return item;
  }

  #listenSelect(e: WaSelectEvent) {
    const item = e.detail.item;
    if (item.id === "mniNewTheme") {
      this.#openNew();
      return;
    }
    // A top-level item is a layout to wear; only the theme submenus carry
    // actions. Keyed on the slot rather than on the icon name so restyling a
    // built-in's icon can't silently turn it into a different action.
    if (item.slot !== "submenu") {
      this.apply(item.value);
      return;
    }

    const action = (<WaIcon> item.querySelector("wa-icon")).name;
    switch (action) {
      case "folder-open":
        this.apply(item.value);
        break;
      case "code":
        this.#openEdit(item.value);
        break;
      case "trash": {
        this.#dlgDelete.open = true;
        const hidden = <HTMLInputElement> this.#dlgDelete.querySelector("input");
        hidden.value = item.value;
        break;
      }
      default:
        throw new Error(`unimplemented theme action ${action}`);
    }
  }

  #openNew() {
    // Created in storage up front rather than held aside: it needs a slug
    // before it can be applied, and applying it is what makes the editing
    // session previewable. Cancel removes it again.
    const name = `Theme ${this.storage.list().length + 1}`;
    const slug = this.storage.create(name, THEME_TEMPLATE);
    this.#renderItems();
    this.#openDialog(slug, true);
  }

  #openEdit(slug: string) {
    if (!this.storage.get(slug)) return;
    this.#openDialog(slug, false);
  }

  #openDialog(slug: string, isNew: boolean) {
    const theme = this.storage.get(slug)!;
    this.#editingSlug = slug;
    this.#isNew = isNew;
    this.#restoreLayout = this.storage.getLayout();
    this.#restoreTheme = isNew ? null : { ...theme };

    const hidden = <HTMLInputElement> this.#dlgTheme.querySelector("input");
    hidden.value = slug;
    this.#txtName.value = theme.name;
    this.#dlgTheme.open = true;

    // Built after `open = true` so the subtree isn't display:none — CodeMirror
    // measures its line height and gutter on creation and would render
    // collapsed. But `open = true` only *starts* the open animation (WaDialog
    // awaits it and emits wa-after-show when it settles), so the box is still
    // moving underneath us: re-measure once it has stopped.
    this.#editor = newCssEditor(
      this.#editorMount,
      theme.css,
      (text) => this.#onCssChanged(text),
    );
    this.#dlgTheme.addEventListener(
      "wa-after-show",
      () => this.#editor?.requestMeasure(),
      { once: true },
    );
    this.#showProblems(theme.css);
    // Wear it while editing, so the preview shows what is being typed.
    this.apply(slug);
  }

  #onCssChanged(text: string) {
    // CodeMirror syncs contenteditable edits through a MutationObserver, so an
    // update can land a microtask *after* the dialog closed — a paste or an
    // IME composition finishing right as Save is clicked. Without this,
    // storage.update() would be called with an empty slug and throw out of
    // CodeMirror's own listener.
    if (!this.#editingSlug) return;

    // Written to storage on every keystroke, not just on Save: it is what
    // themeMessage() reads, so a viewer joining mid-edit gets the same CSS
    // everyone else can see rather than the last saved version.
    this.storage.update(this.#editingSlug, {
      name: this.#name(),
      css: text,
    });
    this.#showProblems(text);

    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => this.#emit(), CSS_PUSH_DEBOUNCE_MS);
  }

  #name(): string {
    return (this.#txtName.value ?? "").trim() || "Untitled";
  }

  #showProblems(css: string) {
    const problems = findThemeCssProblems(css);
    this.#problems.hidden = problems.length === 0;
    this.#problems.replaceChildren(
      ...problems.map((p) => {
        const el = document.createElement("wa-callout");
        el.setAttribute("variant", "warning");
        el.textContent = p;
        return el;
      }),
    );
  }

  #saveDialog() {
    const slug = this.#editingSlug;
    if (!slug) return;
    this.storage.update(slug, {
      name: this.#name(),
      css: this.#editor ? cssText(this.#editor) : "",
    });
    this.#closeDialog();
    this.#renderItems();
    this.#renderTrigger();
    this.#emit();
  }

  #cancelDialog() {
    const slug = this.#editingSlug;
    if (!slug) return;
    if (this.#isNew) {
      this.storage.remove(slug);
    } else if (this.#restoreTheme) {
      this.storage.update(slug, this.#restoreTheme);
    }
    this.#closeDialog();
    this.#renderItems();
    // Back to whatever was on screen before, and push it: viewers have been
    // wearing the abandoned edit this whole time.
    this.apply(this.#restoreLayout);
  }

  #closeDialog() {
    clearTimeout(this.#pushTimer);
    this.#pushTimer = undefined;
    // Cleared before #editingSlug so the wa-hide handler doesn't re-enter
    // cancel on the way out.
    this.#editingSlug = "";
    this.#editor?.destroy();
    this.#editor = null;
    this.#editorMount.replaceChildren();
    this.#dlgTheme.open = false;
  }

  #confirmDelete() {
    const hidden = <HTMLInputElement> this.#dlgDelete.querySelector("input");
    const slug = hidden.value;
    this.#dlgDelete.open = false;
    if (!slug) return;
    // remove() falls the active layout back to the default for us if this was
    // the one being worn — otherwise every viewer would keep a class with no
    // stylesheet behind it, which is a blank screen with nothing to explain it.
    const wasActive = this.storage.getLayout() === slug;
    this.storage.remove(slug);
    this.#renderItems();
    this.#renderTrigger();
    if (wasActive) this.#emit();
  }
}
