// Copy pdf.js's non-JS side-files into the bundle output.
//
// `deno bundle` emits JS and CSS and nothing else — which is why index.html's
// favicon is missing from dist today. pdf.js fetches two directories at
// runtime by URL: standard_fonts/ (the base-14 fonts, for PDFs that don't
// embed their own) and wasm/ (JPEG2000/JBIG2/colour-management decoders). Both
// have JS fallbacks, so a missing copy degrades quietly rather than throwing —
// which is exactly why it's worth copying them deliberately instead of
// discovering later that some documents render wrong.

import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0";

const OUT_DIR = join("src", "backend", "dist", "pdfjs");
const DIRS = ["standard_fonts", "wasm"];

// Resolve through the module graph rather than guessing at Deno's npm cache
// layout, which is an implementation detail and version-dependent.
const pkgRoot = dirname(dirname(
  fromFileUrl(import.meta.resolve("pdfjs-dist/build/pdf.mjs")),
));

for (const dir of DIRS) {
  const src = join(pkgRoot, dir);
  const dest = join(OUT_DIR, dir);
  // Not a merge: a stale font left behind from an older pdfjs-dist would be
  // served in preference to nothing and is harder to debug than an absence.
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    if (!entry.isFile) continue;
    await Deno.copyFile(join(src, entry.name), join(dest, entry.name));
  }
}

console.log(`copied pdf.js assets (${DIRS.join(", ")}) to ${OUT_DIR}`);
