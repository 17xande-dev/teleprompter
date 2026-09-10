// The generated reference must match the command table it is generated from.
//
// Without this the generator is only as good as someone remembering to run it,
// and a stale docs/shortcuts.md is worse than none: it is a table of bindings
// that reads as authoritative and is wrong. The hand-written table this
// replaced had "scroll faster" on Ctrl+Up when the binding is Ctrl+Down — the
// same direction confusion that once ran a show backwards.
//
// Deliberately compares against the file on disk rather than a fixture, and
// calls the same renderShortcuts() the generator does, so it cannot be
// satisfied by a stale generator agreeing with itself.
import { assertEquals } from "@std/assert";

import { renderShortcuts, SHORTCUTS_PATH } from "../../../tools/gen-docs.ts";

Deno.test("docs/shortcuts.md is up to date with COMMAND_SPECS", async () => {
  const onDisk = await Deno.readTextFile(SHORTCUTS_PATH);
  assertEquals(
    onDisk,
    renderShortcuts(),
    `${SHORTCUTS_PATH} is stale — run \`deno task docs\``,
  );
});
