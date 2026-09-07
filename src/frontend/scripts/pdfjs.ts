// Bundle entry for the pdf.js library, built standalone (see the
// "bundle-pdfjs" task) so it lands at an un-hashed /pdfjs.js that pdfview.ts
// can import by URL at runtime.
//
// The alternative — a plain `import("pdfjs-dist")` left to --code-splitting —
// works, but names the emitted chunk after the source module's path expressed
// relative to the outdir: a ladder of "_.._" segments whose length depends on
// where the repository happens to be checked out. Same treatment as the
// worker, and for the same reason: a URL we can write down.
export * from "pdfjs-dist";
