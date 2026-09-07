// Copy src/frontend/icons/ into the bundle output.
//
// `deno bundle` emits JS and CSS and nothing else, so index.html's
// `<link rel="icon" href="/icons/tv-solid-full.svg">` pointed at a file that
// was never in dist/ — a 404 on every page load, and the tab fell back to
// Chrome's generic globe. Deliberately its own step rather than a branch of
// copy-pdfjs-assets.ts: that one resolves files out of the pdfjs-dist package
// through the module graph, and these are our own source assets.
//
// Kept as a whole-directory copy so adding an icon needs no change here.

import { join } from "jsr:@std/path@^1.0.0";

const SRC_DIR = join("src", "frontend", "icons");
const OUT_DIR = join("src", "backend", "dist", "icons");

// Not a merge: an icon deleted from source but left behind in dist/ would go on
// being served, which is harder to notice than an absence.
await Deno.remove(OUT_DIR, { recursive: true }).catch(() => {});
await Deno.mkdir(OUT_DIR, { recursive: true });

let count = 0;
for await (const entry of Deno.readDir(SRC_DIR)) {
  if (!entry.isFile) continue;
  await Deno.copyFile(join(SRC_DIR, entry.name), join(OUT_DIR, entry.name));
  count++;
}

console.log(`copied ${count} icon(s) to ${OUT_DIR}`);
