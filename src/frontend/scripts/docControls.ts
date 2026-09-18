// The control page's document UI: the Documents dropdown, the rename dialog
// and the delete confirmation. The DOM half of doc.ts, split so that storage
// stays DOM-free and testable — the same arrangement as
// themes.ts / themeControls.ts.

import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaIcon from "@awesome.me/webawesome/dist/components/icon/icon.js";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";

import { type Doc, DocStorage, newDocName } from "./doc.ts";
import { escapeHtml } from "./dom.ts";

type WaSelectEvent = CustomEvent<{ item: WaDropdownItem }>;

export class DocControls {
  drpDocuments: WaDropdown;

  #btnNew: WaButton;
  #dlgNew: WaDialog;
  #dlgRename: WaDialog;
  #dlgDelete: WaDialog;
  storage = new DocStorage();

  constructor() {
    this.#btnNew = document.querySelector("#btnNew")!;
    this.drpDocuments = document.querySelector("#drpDocuments")!;
    this.#dlgNew = document.querySelector("#dlgNew")!;
    this.#dlgRename = document.querySelector("#dlgRename")!;
    this.#dlgDelete = document.querySelector("#dlgDelete")!;

    this.#btnNew.addEventListener("click", () => this.promptNew());
    this.drpDocuments.addEventListener(
      "wa-select",
      this.#listenSelect.bind(this) as EventListener,
    );

    this.#dlgNew.querySelector("wa-button[name=cancel]")!
      .addEventListener("click", () => {
        this.#dlgNew.open = false;
      });
    // The same one-handler-for-both-ways-in as the rename form below: Create
    // is the form's submitter, so a click and an Enter in the field arrive
    // here identically, and nothing listens to the button itself or a click
    // would create two documents.
    this.#dlgNew.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      this.#confirmNew();
    });

    this.#dlgRename.querySelector("wa-button[name=cancel]")!
      .addEventListener("click", () => {
        this.#dlgRename.open = false;
      });
    // One handler for both ways in: the Save button is the form's submitter,
    // so a click and an Enter in the field arrive here identically. Nothing
    // listens to the button directly, or clicking it would rename twice.
    //
    // preventDefault because this form has nowhere to go — a plain form that
    // submits navigates, and reloading the control page drops every display's
    // link for as long as renegotiation takes. `method="dialog"` would avoid
    // that natively but only inside a real <dialog> ancestor, and this form is
    // slotted into wa-dialog's light DOM rather than nested in the <dialog>
    // in its shadow root.
    this.#dlgRename.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      this.#confirmRename();
    });

    this.#dlgDelete.querySelector("wa-button[name=cancel]")!
      .addEventListener("click", () => {
        this.#dlgDelete.open = false;
      });
    this.#dlgDelete.querySelector("wa-button[name=delete]")!
      .addEventListener("click", () => this.#confirmDelete());

    // Content writes are throttled, so the last few seconds of typing can be
    // sitting on a timer when the page goes away. pagehide covers navigation
    // and close; visibilitychange covers being backgrounded, which on mobile
    // is often the last callback a page gets. Deliberately not beforeunload /
    // unload: they don't reliably fire and they disqualify the page from the
    // back-forward cache.
    addEventListener("pagehide", () => this.storage.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.storage.flush();
    });

    this.#renderItems();
    // Deliberately no initial load here. The "load" event is how the control
    // page learns which document to put in the editor, and its listener is
    // attached *after* this constructor returns — an initial dispatch from
    // here would go nowhere, which is exactly why the old code loaded twice.
    // Teleprompter calls loadCurrent() once it has wired up.
  }

  /** Open the stored current document, telling the control page to render it. */
  loadCurrent() {
    this.load(this.storage.getCurrentID());
  }

  /** Persist editor content into the open document. */
  setContent(content: string) {
    this.storage.setContent(content);
  }

  /** Put a document in the editor. Also a palette command. */
  load(id: string) {
    const doc = this.storage.get(id);
    if (!doc) {
      console.warn(`failed to load document ${id} because it doesn't exist`);
      return;
    }
    this.storage.setCurrent(id);
    this.drpDocuments.dispatchEvent(
      new CustomEvent<Doc>("load", {
        detail: doc,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Ask what to call the new document, prefilled with the generated name.
   *
   * Prefilled *and selected*, which is the whole design: Enter alone keeps the
   * name the old button would have given silently, and typing replaces it
   * without a keystroke spent clearing the field. Naming a document is worth
   * offering — "document_20260918-101500" tells an operator nothing when they
   * come back to a dropdown of six of them — but it must not become a step
   * that has to be completed with a service about to start.
   *
   * Nothing is created until the dialog is confirmed. Creating first and
   * renaming afterwards would leave an empty document behind on Cancel, and
   * would switch the editor away from the open script before the operator had
   * agreed to anything.
   */
  promptNew() {
    const input = <WaInput> this.#dlgNew.querySelector("wa-input");
    input.value = newDocName();
    this.#dlgNew.open = true;
    // After the dialog opens: wa-dialog moves focus to its autofocus element
    // as it shows, and a selection made before that is thrown away by the
    // focus that follows.
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  #confirmNew() {
    const input = <WaInput> this.#dlgNew.querySelector("wa-input");
    this.#dlgNew.open = false;
    // Storage trims and falls back for a blank name, the same as rename —
    // one answer to "what is a usable name" rather than two.
    this.create(input.value ?? "");
  }

  create(name?: string) {
    const id = this.storage.create(name?.trim() || undefined);
    this.storage.setCurrent(id);
    this.#renderItems();
    // "new" means "give me a blank editor", as distinct from "load", which
    // carries content to restore.
    this.drpDocuments.dispatchEvent(
      new CustomEvent("new", {
        detail: { id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // One idempotent rebuild from storage, called after every mutation. The old
  // code hand-patched the dropdown in three separate places, each of which was
  // a chance for the menu to disagree with what was stored — and each of which
  // threw "menu item does not exist" if it ever did.
  #renderItems() {
    for (const el of this.drpDocuments.querySelectorAll("[data-doc-item]")) {
      el.remove();
    }
    for (const [id, doc] of this.storage.list()) {
      this.drpDocuments.appendChild(this.#genMenuItem(id, doc.name));
    }
  }

  #genMenuItem(id: string, name: string): WaDropdownItem {
    const item = new WaDropdownItem();
    item.dataset.docItem = "";
    item.value = id;
    item.innerHTML = `${escapeHtml(name)}
      <wa-icon slot="icon" name="file-lines"></wa-icon>
      <wa-dropdown-item slot="submenu">Open
        <wa-icon slot="icon" name="folder-open" label="Open"></wa-icon>
      </wa-dropdown-item>
      <wa-dropdown-item slot="submenu">Rename
        <wa-icon slot="icon" name="pencil" label="Rename"></wa-icon>
      </wa-dropdown-item>
      <wa-dropdown-item slot="submenu" variant="danger">Delete
        <wa-icon slot="icon" name="trash" label="Delete"></wa-icon>
      </wa-dropdown-item>
    `;
    // Set as a property, not in the innerHTML template: an id in an attribute
    // position is one more place a name-shaped string could break the markup.
    // wa-select reports the item that was chosen, not its parent, so the
    // submenu entries need it too.
    for (const sub of item.querySelectorAll("[slot=submenu]")) {
      (<WaDropdownItem> sub).value = id;
    }
    return item;
  }

  #listenSelect(e: WaSelectEvent) {
    const item = e.detail.item;
    // Only the submenus carry actions. Keyed on the slot rather than on the
    // first child's icon name, which is what the old code did — and on a
    // *parent* item the first element child is a submenu entry, which has no
    // `name`, so every top-level selection fell through to `throw`.
    if (item.slot !== "submenu") {
      this.load(item.value);
      return;
    }

    const action = (<WaIcon> item.querySelector("wa-icon")).name;
    switch (action) {
      case "folder-open":
        this.load(item.value);
        break;
      case "pencil":
        this.#openRename(item.value);
        break;
      case "trash":
        this.#openDelete(item.value);
        break;
      default:
        throw new Error(`unimplemented document action ${action}`);
    }
  }

  #openRename(id: string) {
    const doc = this.storage.get(id);
    if (!doc) return;
    const input = <WaInput> this.#dlgRename.querySelector("wa-input");
    const hidden = <HTMLInputElement> this.#dlgRename.querySelector("input");
    hidden.value = id;
    input.value = doc.name;
    this.#dlgRename.open = true;
    input.select();
  }

  #confirmRename() {
    const hidden = <HTMLInputElement> this.#dlgRename.querySelector("input");
    const input = <WaInput> this.#dlgRename.querySelector("wa-input");
    const id = hidden.value;
    this.#dlgRename.open = false;
    if (!this.storage.get(id)) return;

    // Storage trims and defaults the name, and renames in place — the id is
    // stable, so the open document is unaffected unless it *is* this one.
    this.storage.rename(id, input.value ?? "");
    this.#renderItems();
  }

  #openDelete(id: string) {
    const doc = this.storage.get(id);
    if (!doc) return;
    const hidden = <HTMLInputElement> this.#dlgDelete.querySelector("input");
    hidden.value = id;
    // Say which one. textContent, so a name is never parsed as markup.
    const body = this.#dlgDelete.querySelector("#pDeleteDoc")!;
    body.textContent = `Delete "${doc.name}"? This cannot be undone.`;
    this.#dlgDelete.open = true;
  }

  #confirmDelete() {
    const hidden = <HTMLInputElement> this.#dlgDelete.querySelector("input");
    const id = hidden.value;
    this.#dlgDelete.open = false;
    if (!id) return;

    const wasCurrent = this.storage.getCurrentID() === id;
    // remove() repairs `current` for us — to a survivor, or to a freshly
    // seeded document if that was the last one.
    this.storage.remove(id);
    this.#renderItems();
    // Deleting the document under the editor has to swap what's on screen,
    // or the next keystroke would write it straight back.
    if (wasCurrent) this.loadCurrent();
  }
}
