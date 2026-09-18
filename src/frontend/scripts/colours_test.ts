// The palette is a fixed list, so what is worth testing is not that it parses
// but that every entry is *usable*: readable on a display, unambiguous to
// search, and reachable by the commands that name it.
import { assert, assertEquals } from "@std/assert";

import {
  colourByID,
  colourSearchText,
  DEFAULT_COLOUR_ID,
  SCRIPT_COLOURS,
} from "./colours.ts";
import {
  contrastOnBlack,
  MIN_TEXT_LUMINANCE,
  parseCssColor,
  relativeLuminance,
} from "./contrast.ts";

Deno.test("every colour is readable on a display's black background", () => {
  // The same bar a *pasted* colour has to clear before brightenTextColor
  // leaves it alone. Shipping a list rather than a picker is only worth
  // anything if the list passes it: the obvious palette does not — plain blue
  // (#0000ff) measures 2.44:1 here, which is why the blue in the list is a
  // pale cornflower.
  for (const colour of SCRIPT_COLOURS) {
    if (colour.hex === "") continue; // clears the mark; inherits the theme
    const rgb = parseCssColor(colour.hex);
    assert(rgb, `${colour.name} (${colour.hex}) is not a parseable colour`);
    const lum = relativeLuminance(rgb);
    assert(
      lum >= MIN_TEXT_LUMINANCE,
      `${colour.name} (${colour.hex}) has luminance ${
        lum.toFixed(3)
      }, under the ${MIN_TEXT_LUMINANCE} a pasted colour would be brightened to`,
    );
    // Stated in the units the requirement is written in as well, so a future
    // edit can see what it is trading away.
    assert(
      contrastOnBlack(rgb) >= 4.5,
      `${colour.name} is ${contrastOnBlack(rgb).toFixed(2)}:1 on black`,
    );
  }
});

Deno.test("the palette is unambiguous", () => {
  const ids = SCRIPT_COLOURS.map((c) => c.id);
  assertEquals(new Set(ids).size, ids.length, "two colours share an id");
  const names = SCRIPT_COLOURS.map((c) => c.name.toLowerCase());
  assertEquals(new Set(names).size, names.length, "two colours share a name");
  const hexes = SCRIPT_COLOURS.filter((c) => c.hex).map((c) => c.hex);
  assertEquals(new Set(hexes).size, hexes.length, "two colours are the same");
});

Deno.test("the clearing entry is first, and is the only empty one", () => {
  // First because "put it back" is the row reached in a hurry, and empty
  // because a cleared run has to inherit --viewer-color rather than be pinned
  // to a white a light theme would hide.
  assertEquals(SCRIPT_COLOURS[0].id, DEFAULT_COLOUR_ID);
  assertEquals(SCRIPT_COLOURS[0].hex, "");
  assertEquals(SCRIPT_COLOURS.filter((c) => c.hex === "").length, 1);
});

Deno.test("a colour is searchable by what an operator would call it", () => {
  const find = (id: string) => colourSearchText(colourByID(id)!).toLowerCase();
  // The words are the point: someone reaching for a warning colour types
  // "warn", not "red", and someone clearing one types "clear" or "none".
  assert(find("red").includes("warning"));
  assert(find("amber").includes("orange"));
  assert(find("blue").includes("cornflower"));
  assert(find(DEFAULT_COLOUR_ID).includes("clear"));
  assert(find(DEFAULT_COLOUR_ID).includes("none"));
});

Deno.test("colourByID answers for every entry and nothing else", () => {
  for (const colour of SCRIPT_COLOURS) {
    assertEquals(colourByID(colour.id), colour);
  }
  assertEquals(colourByID("puce"), undefined);
  assertEquals(colourByID(""), undefined);
});
