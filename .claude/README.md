# .claude

Project-scoped Claude Code configuration.

`settings.json` turns on the `deno-lsp` plugin, which points Claude Code's LSP
tool at `deno lsp` for `.ts` files — the right language server for this repo,
since the imports are bare specifiers resolved through `deno.jsonc` and the CSS
imports in `teleprompter.ts` mean `tsserver` would report errors that are not
errors here.

The plugin itself lives outside the repo, at `~/.claude/skills/deno-lsp/`, and
is loaded as `deno-lsp@skills-dir`. It is switched **off** in
`~/.claude/settings.json` and back **on** here, so `deno lsp` is used for
TypeScript in this project and nowhere else. A checkout without that directory
simply has no TypeScript LSP; nothing else is affected.

To recreate it:

```sh
mkdir -p ~/.claude/skills/deno-lsp/.claude-plugin
cat > ~/.claude/skills/deno-lsp/.claude-plugin/plugin.json <<'JSON'
{ "name": "deno-lsp", "description": "Deno language server", "version": "1.0.0" }
JSON
cat > ~/.claude/skills/deno-lsp/.lsp.json <<'JSON'
{
  "deno": {
    "command": "deno",
    "args": ["lsp"],
    "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript" },
    "initializationOptions": { "enable": true, "lint": true, "unstable": true }
  }
}
JSON
```

Then set `"deno-lsp@skills-dir": false` in `~/.claude/settings.json`, and
restart the session — LSP servers are read once at startup.
