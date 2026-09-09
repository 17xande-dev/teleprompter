// The Settings dialog: the DOM half of settings.ts, split the same way
// docControls.ts is split from doc.ts.
//
// There is no save or cancel. Every control in here is a preference that takes
// effect on the operator's next gesture, so it is written as it is changed —
// which also means a dialog dismissed by Escape or the backdrop leaves nothing
// half-committed, the case themeControls.ts has to work to handle.

import WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";

import { SettingsStorage } from "./settings.ts";

// Prevent treeshaking so the element upgrades; the same reason and the same
// idiom as the block at the top of teleprompter.ts.
void WaSwitch;

export class SettingsControls {
  storage = new SettingsStorage();

  #dialog: WaDialog;
  #swInvertWheel: WaSwitch;

  constructor() {
    this.#dialog = document.querySelector("#dlgSettings")!;
    this.#swInvertWheel = document.querySelector("#swInvertWheel")!;
    (<WaButton> document.querySelector("#btnSettings")).addEventListener(
      "click",
      () => this.open(),
    );
    this.#dialog.querySelector("wa-button[name=close]")!
      .addEventListener("click", () => this.#dialog.open = false);

    this.#swInvertWheel.addEventListener("change", () => {
      this.storage.invertWheel = this.#swInvertWheel.checked;
    });
  }

  /** Also the palette's "Settings" command. */
  open() {
    // Read out of storage on the way in rather than once at construction: it
    // is the only state the dialog has, and re-reading means the switch cannot
    // drift from what the wheel handlers are actually using.
    this.#swInvertWheel.checked = this.storage.invertWheel;
    this.#dialog.open = true;
  }

  /** What the wheel handlers ask, per event — never cached. */
  get invertWheel(): boolean {
    return this.storage.invertWheel;
  }

  /**
   * Whether edits go out as they are typed.
   *
   * Read and written through here rather than off `storage` directly, so
   * every preference has one accessor and the control page never has to know
   * which of them this dialog happens to own a switch for. Its switch is in
   * the Sync card, not this dialog: the operator reaches for it mid-session,
   * beside the other "what do the displays have" actions, and a preference
   * being remembered is not the same as it belonging behind a gear icon.
   */
  get liveEditing(): boolean {
    return this.storage.liveEditing;
  }

  set liveEditing(value: boolean) {
    this.storage.liveEditing = value;
  }
}
