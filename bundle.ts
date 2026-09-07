async function bundle() {
  const result = await Deno.bundle({
    entrypoints: ["src/index.html"],
    outputDir: "dist",
    platform: "browser",
  });
  console.log(result);
}

console.log("Bundling...");
await bundle();

// Watch for changes.
const watcher = Deno.watchFs(["src"]);
console.log("Watching for changes in src/...");

for await (const event of watcher) {
  if (event.kind === "modify" || event.kind === "create") {
    console.log("Change detected, rebundling...");
    await bundle();
  }
}
