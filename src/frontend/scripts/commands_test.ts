// Tests for the command mechanism. No fakes and no DOM at all — that is what
// the commands.ts / paletteControls.ts split buys, and it is why the real
// command table is a plain array this file can import and check directly.
import { assert, assertEquals } from "@std/assert";
import {
  applyPadBindings,
  type Command,
  type CommandSpec,
  filterCommands,
  formatShortcut,
  parseShortcut,
  shortcutHasModifier,
  toTinykeys,
  validateCommands,
} from "./commands.ts";
import {
  buildCommands,
  COMMAND_SPECS,
  documentCommands,
  layoutCommands,
} from "./controlCommands.ts";
import { PAD_BINDINGS, PAD_LABELS, type PadButton } from "./gamepad.ts";

function cmd(spec: Partial<Command> & { label: string }): Command {
  return {
    id: spec.id ?? spec.label.toLowerCase().replaceAll(" ", "."),
    group: spec.group ?? "Scroll",
    run: spec.run ?? (() => {}),
    ...spec,
  };
}

Deno.test("a chord parses into its modifiers and key", () => {
  assertEquals(parseShortcut("Mod+K"), { modifiers: ["Mod"], key: "K" });
  assertEquals(parseShortcut("Mod+Shift+ArrowUp"), {
    modifiers: ["Mod", "Shift"],
    key: "ArrowUp",
  });
  assertEquals(parseShortcut("Space"), { modifiers: [], key: "Space" });
});

Deno.test("modifiers are ordered so the same chord always renders the same", () => {
  // Written either way round, Mod+Alt+Digit0 must display and normalize
  // identically — otherwise two spellings of one chord would look like two
  // different bindings to validateCommands.
  assertEquals(
    parseShortcut("Alt+Mod+Digit0"),
    parseShortcut("Mod+Alt+Digit0"),
  );
  assertEquals(toTinykeys("Alt+Mod+Digit0"), toTinykeys("Mod+Alt+Digit0"));
});

Deno.test("a shortcut that could never fire is rejected rather than bound", () => {
  // Each of these would install a binding that silently never matches.
  assertEquals(parseShortcut(""), null);
  assertEquals(parseShortcut("Mod+"), null);
  assertEquals(parseShortcut("Ctrl Alt"), null);
  assertEquals(parseShortcut("Mod+Shift"), null);
  assertEquals(parseShortcut("Mod+Mod+K"), null);
  assertEquals(parseShortcut("Cmd+K"), null);
  assertEquals(parseShortcut(" Mod+K"), null);
  assertEquals(toTinykeys("Mod+"), null);
});

Deno.test("only Mod is translated for tinykeys; the key passes through", () => {
  // tinykeys spells the platform modifier "$mod" and lowercases the rest
  // itself. The key is left alone because tinykeys matches it against both
  // event.key ("K") and event.code ("Digit0", "Space").
  assertEquals(toTinykeys("Mod+K"), "$mod+K");
  assertEquals(toTinykeys("Mod+Shift+ArrowUp"), "$mod+Shift+ArrowUp");
  assertEquals(toTinykeys("Mod+Alt+Digit0"), "$mod+Alt+Digit0");
  assertEquals(toTinykeys("Space"), "Space");
  assertEquals(toTinykeys("Mod+/"), "$mod+/");
});

Deno.test("a shortcut renders for the platform it is shown on", () => {
  assertEquals(formatShortcut("Mod+K", { apple: false }), "Ctrl+K");
  assertEquals(formatShortcut("Mod+K", { apple: true }), "⌘K");
  assertEquals(
    formatShortcut("Mod+Shift+ArrowUp", { apple: false }),
    "Ctrl+Shift+↑",
  );
  assertEquals(formatShortcut("Mod+Shift+ArrowUp", { apple: true }), "⌘⇧↑");
  assertEquals(formatShortcut("Mod+Enter", { apple: false }), "Ctrl+Enter");
  assertEquals(formatShortcut("Mod+Enter", { apple: true }), "⌘↩");
});

Deno.test("physical key names are not shown to the operator", () => {
  // KeyP and Digit0 exist so the binding survives a non-US layout and macOS's
  // Option-glyph substitution. The operator should still just see P and 0.
  assertEquals(formatShortcut("Mod+Alt+KeyP", { apple: false }), "Ctrl+Alt+P");
  assertEquals(
    formatShortcut("Mod+Alt+Digit0", { apple: false }),
    "Ctrl+Alt+0",
  );
  assertEquals(formatShortcut("Mod+Alt+Equal", { apple: false }), "Ctrl+Alt+=");
  assertEquals(formatShortcut("Mod+Alt+Minus", { apple: false }), "Ctrl+Alt+-");
  assertEquals(
    formatShortcut("Mod+Alt+BracketRight", { apple: false }),
    "Ctrl+Alt+]",
  );
  assertEquals(
    formatShortcut("Mod+Alt+BracketLeft", { apple: false }),
    "Ctrl+Alt+[",
  );
});

Deno.test("an unparseable shortcut formats as nothing rather than as itself", () => {
  // The palette renders this straight into a <kbd>; showing "Mod+" there would
  // advertise a binding that does not exist.
  assertEquals(formatShortcut("Mod+", { apple: false }), "");
});

Deno.test("a bare key carries no modifier and a chord does", () => {
  assert(!shortcutHasModifier("Space"));
  assert(shortcutHasModifier("Mod+K"));
  assert(shortcutHasModifier("Shift+ArrowUp"));
});

Deno.test("an empty query lists every command in group order", () => {
  const commands = [
    cmd({ label: "Second", group: "Text" }),
    cmd({ label: "First", group: "Scroll" }),
    cmd({ label: "Third", group: "Help" }),
  ];
  assertEquals(
    filterCommands(commands, "").map((c) => c.label),
    ["First", "Second", "Third"],
  );
  // Whitespace is not a query.
  assertEquals(filterCommands(commands, "   ").length, 3);
});

Deno.test("a closer match to the label ranks higher", () => {
  const commands = [
    cmd({ label: "Copy the viewer link", keywords: ["scale"] }),
    cmd({ label: "Bigger text scale" }),
    cmd({ label: "Scale text down" }),
    cmd({ label: "Scale" }),
  ];
  assertEquals(
    filterCommands(commands, "scale").map((c) => c.label),
    [
      "Scale", // exact
      "Scale text down", // label prefix
      "Bigger text scale", // word prefix inside the label
      "Copy the viewer link", // keyword only
    ],
  );
});

Deno.test("searching is case-insensitive and covers keywords and groups", () => {
  const commands = [
    cmd({ label: "Start / stop scrolling", keywords: ["play", "pause"] }),
    cmd({ label: "Send message", group: "Message" }),
  ];
  assertEquals(filterCommands(commands, "SCROLL").length, 1);
  assertEquals(
    filterCommands(commands, "pause")[0].label,
    "Start / stop scrolling",
  );
  assertEquals(filterCommands(commands, "message").length, 1);
  assertEquals(filterCommands(commands, "nothing here").length, 0);
});

Deno.test("a query with regex punctuation in it is treated as text", () => {
  // "Start / stop scrolling" is a real label, and the word-boundary rule
  // builds a RegExp from the query — an unescaped "/" or "(" would throw or
  // match the wrong thing while the operator was mid-word.
  const commands = [cmd({ label: "Start / stop scrolling" })];
  assertEquals(filterCommands(commands, "/").length, 1);
  assertEquals(filterCommands(commands, "(").length, 0);
  assertEquals(filterCommands(commands, "sto(p").length, 0);
});

Deno.test("equally good matches keep a stable order", () => {
  // The top row is what Enter runs, so it must not flicker between renders.
  const commands = [
    cmd({ id: "a", label: "Scroll faster" }),
    cmd({ id: "b", label: "Scroll slower" }),
    cmd({ id: "c", label: "Scroll to zero" }),
  ];
  const once = filterCommands(commands, "scroll").map((c) => c.id);
  const twice = filterCommands(commands, "scroll").map((c) => c.id);
  assertEquals(once, ["a", "b", "c"]);
  assertEquals(once, twice);
});

Deno.test("a table with nothing wrong with it reports no problems", () => {
  const specs: CommandSpec[] = [
    {
      id: "scroll.toggle",
      label: "Start / stop",
      group: "Scroll",
      shortcut: "Space",
    },
    {
      id: "palette.open",
      label: "Commands",
      group: "Help",
      shortcut: "Mod+K",
      allowWhileTyping: true,
    },
    { id: "pdf.close", label: "Close PDF", group: "Document" },
  ];
  assertEquals(validateCommands(specs), []);
});

Deno.test("two commands cannot claim the same binding", () => {
  // The failure this check exists for: tinykeys binds both, only one ever
  // fires, and the palette goes on advertising each of them.
  const problems = validateCommands([
    {
      id: "speed.up",
      label: "Faster",
      group: "Scroll",
      shortcut: "Mod+ArrowUp",
    },
    { id: "scale.up", label: "Bigger", group: "Text", shortcut: "Mod+ArrowUp" },
  ]);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("scale.up"));
  assert(problems[0].includes("speed.up"));
});

Deno.test("the same chord written two ways is still one binding", () => {
  const problems = validateCommands([
    { id: "a", label: "A", group: "Scroll", shortcut: "Mod+Alt+Digit0" },
    { id: "b", label: "B", group: "Scroll", shortcut: "Alt+Mod+Digit0" },
  ]);
  assertEquals(problems.length, 1);
});

Deno.test("a duplicate id is reported", () => {
  const problems = validateCommands([
    { id: "speed.up", label: "Faster", group: "Scroll" },
    { id: "speed.up", label: "Also faster", group: "Scroll" },
  ]);
  assertEquals(problems, ["duplicate id speed.up"]);
});

Deno.test("an unparseable shortcut is reported against its command", () => {
  const problems = validateCommands([
    { id: "speed.up", label: "Faster", group: "Scroll", shortcut: "Mod+" },
  ]);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("speed.up"));
});

Deno.test("an unknown group is reported", () => {
  const problems = validateCommands([
    // A group the palette has no heading for would render nowhere.
    { id: "x", label: "X", group: "Nowhere" as never },
  ]);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("Nowhere"));
});

Deno.test("a bare key may not fire while the operator is typing", () => {
  // Space that fires from inside #txtMessage makes the input unusable.
  const problems = validateCommands([
    {
      id: "scroll.toggle",
      label: "Start / stop",
      group: "Scroll",
      shortcut: "Space",
      allowWhileTyping: true,
    },
  ]);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("while typing"));
});

Deno.test("a palette-only command may not claim to fire while typing", () => {
  const problems = validateCommands([
    {
      id: "pdf.close",
      label: "Close PDF",
      group: "Document",
      allowWhileTyping: true,
    },
  ]);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("no shortcut"));
});

// The checks above are only worth having if they run against the table that
// actually ships, which is why controlCommands.ts keeps COMMAND_SPECS free of
// any DOM access at module scope.

Deno.test("the real command table has nothing wrong with it", () => {
  assertEquals(validateCommands(COMMAND_SPECS), []);
});

Deno.test("every controller button runs a command that exists", () => {
  // PAD_BINDINGS holds ids, and gamepadControls.ts looks them up in the bound
  // table. A typo there would be a button that silently does nothing.
  const ids = new Set(COMMAND_SPECS.map((s) => s.id));
  for (const [button, id] of Object.entries(PAD_BINDINGS)) {
    assert(ids.has(id), `${button} is bound to unknown command ${id}`);
  }
});

Deno.test("the bound table shows the button that actually fires", () => {
  // The pad label is stamped from PAD_BINDINGS rather than written by hand, so
  // the palette can't advertise a button the pad doesn't press.
  const stamped = buildCommands(fakeCommandHost());
  for (const [button, id] of Object.entries(PAD_BINDINGS)) {
    const command = stamped.find((c) => c.id === id)!;
    assertEquals(command.pad, PAD_LABELS[button as PadButton]);
  }
  // And nothing else claims one.
  assertEquals(
    stamped.filter((c) => c.pad).length,
    Object.keys(PAD_BINDINGS).length,
  );
  assertEquals(validateCommands(stamped), []);
});

Deno.test("two commands cannot claim the same controller button", () => {
  // The same failure as a duplicate shortcut, from the other input device: the
  // pad dispatches one command per button, so the second would never fire.
  const specs = applyPadBindings(
    [
      { id: "a", label: "A", group: "Scroll" },
      { id: "b", label: "B", group: "Scroll" },
    ],
    { r1: "a", l1: "b" },
    { r1: "R1", l1: "R1" },
  );
  const problems = validateCommands(specs);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("pad R1"));
});

Deno.test("a button bound to nothing stamps nothing", () => {
  // applyPadBindings is fed the whole table, so a binding for a command that
  // isn't in it must be dropped rather than invented as a row.
  const specs = applyPadBindings(
    [{ id: "a", label: "A", group: "Scroll" }],
    { r1: "missing" },
    { r1: "R1" },
  );
  assertEquals(specs.filter((s) => s.pad), []);
});

Deno.test("every real shortcut both binds and displays", () => {
  // A spec that parses for tinykeys but formats to "" (or the reverse) would
  // mean the palette and the keyboard disagreed about the same command.
  for (const spec of COMMAND_SPECS) {
    if (spec.shortcut === undefined) continue;
    assert(
      toTinykeys(spec.shortcut) !== null,
      `${spec.id}: ${spec.shortcut} does not bind`,
    );
    assert(
      formatShortcut(spec.shortcut, { apple: false }) !== "",
      `${spec.id}: ${spec.shortcut} does not display`,
    );
    assert(
      formatShortcut(spec.shortcut, { apple: true }) !== "",
      `${spec.id}: ${spec.shortcut} does not display on a Mac`,
    );
  }
});

// buildCommands is structural over CommandHost, so the bound table can be
// exercised with stubs — no DOM, no Teleprompter. Only message.clear reaches
// for `document`, and only when it is actually run.

function fakeCommandHost() {
  const clicked: string[] = [];
  const click = (name: string) => ({ click: () => clicked.push(name) });
  return {
    clicked,
    btnPop: click("pop"),
    btnMessage: click("message"),
    btnGoToViewers: click("goToViewers"),
    btnSendPosition: click("sendPosition"),
    btnMatchScale: click("matchScale"),
    btnSendScale: click("sendScale"),
    rngSpeed: { value: 0, dispatchEvent: () => true },
    rngScale: { value: 30, dispatchEvent: () => true },
    tpClockControl: {
      btnStart: click("clockStart"),
      btnStop: click("clockStop"),
      btnReset: click("clockReset"),
    },
    docControls: { create: () => clicked.push("newDoc") },
    lnkViewerLink: { href: "" },
    palette: { open: () => clicked.push("palette") },
    closePdf: () => clicked.push("closePdf"),
    toggleAutoScroll: () => clicked.push("toggleAutoScroll"),
  };
}

Deno.test("faster means forward, which is a step toward the slider's minimum", () => {
  // The regression this exists for: "Scroll faster" on Mod+ArrowUp nudged the
  // slider *up*, and because wire speed is -rngSpeed.value, up is Reverse — so
  // the command labelled faster scrolled the show backwards. The slider is
  // inverted on purpose (Forward at the bottom, thumb travelling with the
  // text), so the commands have to carry the sign.
  const host = fakeCommandHost();
  const commands = buildCommands(host);
  const run = (id: string) => commands.find((c) => c.id === id)!.run();

  run("speed.up");
  assert(host.rngSpeed.value < 0, "speed.up must move toward Forward");
  const oneStep = host.rngSpeed.value;

  host.rngSpeed.value = 0;
  run("speed.down");
  assert(host.rngSpeed.value > 0, "speed.down must move toward Reverse");

  // The large variants go the same way, only further.
  host.rngSpeed.value = 0;
  run("speed.up.large");
  assert(host.rngSpeed.value < oneStep, "the large step must be larger");

  host.rngSpeed.value = 0;
  run("speed.down.large");
  assert(host.rngSpeed.value > -oneStep);

  // speed.zero assigns outright, so it is unaffected by any of this.
  run("speed.zero");
  assertEquals(host.rngSpeed.value, 0);
});

Deno.test("the speed arrows point the way the text travels", () => {
  // Down is forward — scrolling on is scrolling down the script — so the
  // faster commands are bound to ArrowDown and the slower ones to ArrowUp.
  // Nothing about getting this backwards looks wrong until a service, and it
  // reads as plausible either way, which is exactly why it is asserted.
  const shortcut = (id: string) =>
    COMMAND_SPECS.find((s) => s.id === id)!.shortcut;
  assertEquals(shortcut("speed.up"), "Mod+ArrowDown");
  assertEquals(shortcut("speed.down"), "Mod+ArrowUp");
  assertEquals(shortcut("speed.up.large"), "Mod+Shift+ArrowDown");
  assertEquals(shortcut("speed.down.large"), "Mod+Shift+ArrowUp");
});

Deno.test("only Space is bound bare, and every other binding is a chord", () => {
  // The operator asked for chords precisely so shortcuts stay out of the way
  // while typing. Space predates that and is guarded by focus instead; a new
  // bare key slipping in is the regression this catches.
  const bare = COMMAND_SPECS
    .filter((s) => s.shortcut && !shortcutHasModifier(s.shortcut))
    .map((s) => s.shortcut);
  assertEquals(bare, ["Space"]);
});

// The dynamic commands. Both providers are structural over their host, so
// these run with no DOM and no localStorage — the same seam doc_test.ts's
// fakeStore() gets from DocStorage.

function fakeDocHost(current = "b") {
  const loaded: string[] = [];
  return {
    loaded,
    storage: {
      list: (): [string, { name: string }][] => [
        ["a", { name: "Sunday morning" }],
        ["b", { name: "Notices" }],
      ],
      getCurrentID: () => current,
    },
    load: (id: string) => loaded.push(id),
  };
}

function fakeLayoutHost(current = "theme-default") {
  const applied: string[] = [];
  return {
    applied,
    storage: {
      layouts: (): [string, string][] => [
        ["theme-default", "Clocks & Text"],
        ["theme-big-clock", "Big Clocks"],
        ["theme-user-mine", "Mine"],
      ],
      getLayout: () => current,
    },
    apply: (layout: string) => applied.push(layout),
  };
}

Deno.test("there is one open command per stored document", () => {
  const commands = documentCommands(fakeDocHost());
  assertEquals(commands.map((c) => c.label), [
    "Open: Sunday morning",
    "Open: Notices",
  ]);
  assertEquals(commands.map((c) => c.id), [
    "document.open.a",
    "document.open.b",
  ]);
});

Deno.test("the document already in the editor is marked", () => {
  const commands = documentCommands(fakeDocHost("b"));
  assertEquals(commands.map((c) => c.hint), [undefined, "open"]);
});

Deno.test("running a document command loads that document", () => {
  const host = fakeDocHost();
  documentCommands(host).find((c) => c.label === "Open: Notices")!.run();
  assertEquals(host.loaded, ["b"]);
});

Deno.test("layouts cover the built-ins and the user's own", () => {
  const commands = layoutCommands(fakeLayoutHost());
  assertEquals(commands.map((c) => c.label), [
    "Layout: Clocks & Text",
    "Layout: Big Clocks",
    "Layout: Mine",
  ]);
  assertEquals(commands.map((c) => c.hint), ["current", undefined, undefined]);
});

Deno.test("running a layout command wears that layout", () => {
  const host = fakeLayoutHost();
  layoutCommands(host).find((c) => c.label === "Layout: Mine")!.run();
  assertEquals(host.applied, ["theme-user-mine"]);
});

Deno.test("a dynamic command never carries a shortcut", () => {
  // The bindings are installed once, from the static table, so a shortcut on
  // a command that comes and goes could never fire — and the palette would
  // still print it. The palette strips these defensively; this is the check
  // that the providers don't produce them in the first place.
  const dynamic = [
    ...documentCommands(fakeDocHost()),
    ...layoutCommands(fakeLayoutHost()),
  ];
  assertEquals(dynamic.filter((c) => c.shortcut), []);
});

Deno.test("a dynamic command cannot collide with a static one", () => {
  // Both lists are concatenated into one palette, and the ids are what
  // distinguish rows. A document called "Close PDF" must not shadow the
  // command, which the "Open: " prefix and the id namespaces prevent.
  const ids = new Set(COMMAND_SPECS.map((s) => s.id));
  const dynamic = [
    ...documentCommands(fakeDocHost()),
    ...layoutCommands(fakeLayoutHost()),
  ];
  for (const command of dynamic) {
    assert(
      !ids.has(command.id),
      `${command.id} collides with a static command`,
    );
  }
  assertEquals(validateCommands([...COMMAND_SPECS, ...dynamic]), []);
});
