// Tests for the command mechanism. No fakes and no DOM at all — that is what
// the commands.ts / paletteControls.ts split buys, and it is why the real
// command table is a plain array this file can import and check directly.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  type Command,
  type CommandSpec,
  filterCommands,
  formatShortcut,
  parseShortcut,
  shortcutHasModifier,
  toTinykeys,
  validateCommands,
} from "./commands.ts";
import { COMMAND_SPECS } from "./controlCommands.ts";

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

Deno.test("only Space is bound bare, and every other binding is a chord", () => {
  // The operator asked for chords precisely so shortcuts stay out of the way
  // while typing. Space predates that and is guarded by focus instead; a new
  // bare key slipping in is the regression this catches.
  const bare = COMMAND_SPECS
    .filter((s) => s.shortcut && !shortcutHasModifier(s.shortcut))
    .map((s) => s.shortcut);
  assertEquals(bare, ["Space"]);
});
