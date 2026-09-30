---
mdlineage:
  schema: 1
  id: docs.editor-setup
  kind: guide
  status: active
  created_at: 2026-09-24
  updated_at: 2026-09-24
---

# Editor & agent setup

MDLineage ships three integrations, each aimed at a different consumer:

| Channel | Command / package | Best for |
| --- | --- | --- |
| A. remark | `remark-language-server` + `@mdlineage/remark-lint-mdlineage` | Markdown editors that already speak remark; live linting while you type |
| B. Dedicated LSP | `mdlineage server --stdio` (bin `mdlineage-lsp`) | Editors that want the full language feature set: completion, definition, references, rename, hover, symbols, quick fixes |
| C. MCP server | `mdlineage mcp --stdio` (bin `mdlineage-mcp`) | LLM agents and MCP clients that need to validate, inspect, and (guarded) patch documents |

All channels require Node >= 20. This is a five-package monorepo; the `mdlineage` bin belongs to `@mdlineage/cli`. The always-works invocation is the direct `node` path: `node packages/cli/dist/main.js`, `node packages/language-server/dist/server-entry.js`, `node packages/mcp-server/dist/entry.js`. After `npm install && npm run build`, the `node_modules/.bin/` links `mdlineage`, `mdlineage-lsp`, and `mdlineage-mcp` also exist and are executable — but they are created only if the bin targets already exist when npm installs: a clean `npm ci` before any build skips them. This repository is in the process of restoring them during `npm run build`; if you find them missing after a first install, that is the known case — re-run `npm install` (or `npm run build` on a fixed version) and they appear.

Related pages: [usage.md](usage.md), [configuration.md](configuration.md), [diagnostics.md](diagnostics.md).

## Channel A — remark

### What this repository actually provides

The repository wires the plugin chain in `.remarkrc.mjs`:

1. `remark-gfm`
2. `remark-frontmatter` with `['yaml']`, so unsaved buffers are validated from the in-memory VFile rather than the disk copy
3. `remark-preset-lint-recommended`
4. `[<mdlineage plugin>, { configFile: './mdlineage.config.yaml' }]` (`@mdlineage/remark-lint-mdlineage`)
5. `remarkLintMdlineage.restoreSeverity`, which restores error-level severities that `unified-lint-rule` would otherwise demote

One honest caveat: `remark-language-server` is pinned in the root `package.json` devDependencies (and locked by the lockfile), but it is **not referenced by any code or configuration in this repository**. The pinned version only guarantees a known-good host if you choose to run it. The channel works because *your editor* launches a remark language server and this repository supplies the plugin plus `.remarkrc.mjs`. "Pinned" here does not mean "active inside the repo".

`.vscode/settings.json` contains one functional setting (plus a `//` comment key):

```json
{ "remark.requireConfig": true }
```

`remark.requireConfig: true` means a repository without a `.remarkrc.*` file is not processed at all. This prevents a contributor's personal remark plugins from silently producing diagnostics that differ from CI.

### VS Code

Install the `vscode-remark` extension (it is the consumer of the `remark.*` settings, including `remark.requireConfig`). The extension bundles its own language server; no extra launch configuration is needed. The repository's `.remarkrc.mjs` and `mdlineage.config.yaml` are picked up automatically when you open the workspace root. The exact extension behavior has not been verified against a specific VS Code build in this repository.

### Neovim / Emacs / other stdio LSP clients

Register a stdio LSP client whose command is:

```
node_modules/.bin/remark-language-server --stdio
```

(If this package is not installed in your project, the pinned version in this repository's lockfile is `^3.0.0`.) Suggested root markers: `.remarkrc.mjs`, `mdlineage.config.yaml`, `.git`.

Neovim sketch — replace the paths with your own project root:

```lua
-- ~/.config/nvim/after/lspconfig/remark.lua or equivalent
vim.lsp.start({
  name = 'remark',
  cmd = { vim.fn.getcwd() .. '/node_modules/.bin/remark-language-server', '--stdio' },
  root_dir = vim.fs.dirname(vim.fs.find({ '.remarkrc.mjs', 'mdlineage.config.yaml', '.git' }, { upward = true })[1]),
})
```

Emacs (Eglot) sketch:

```elisp
(add-to-list 'eglot-server-programs
             '((markdown-mode gfm-mode)
               . ("node_modules/.bin/remark-language-server" "--stdio")))
```

### Capability limits of the remark channel

- unified lint severities are only 0/1/2, so MDLineage **Information and Hint diagnostics collapse to Warning** on this channel.
- The `unified-language-server` QuickFix path only consumes the `expected` array carried by a diagnostic and emits a single `TextEdit.replace`. Fixes that require **multi-line YAML structure edits are not available** on this channel. Use the dedicated LSP or the MCP server for those.

## Channel B — dedicated LSP (`mdlineage server --stdio`)

One server instance provides the full feature set; it is designed to replace the remark host entirely. The capability table below was captured from a real `initialize` handshake over stdio:

```
textDocument.synchronization: { openClose: true, change: 2 (incremental), save: { includeText: false } }
textDocument.completion:      triggerCharacters [":", " "], resolveProvider: false
textDocument.definition / references / hover
textDocument.rename:          prepareSupport: true
textDocument.documentSymbol:  hierarchicalDocumentSymbolSupport: true
textDocument.codeAction:      kinds ["quickfix"], resolveProvider: false
workspace.workspaceFolders:   supported: true, changeNotifications: true
workspace.symbol
```

Workspace resolution: `initialize` prefers `workspaceFolders`; for older clients it also accepts the deprecated `rootUri` / `rootPath`. If the value points at a file, the parent directory is used; if it points at a nonexistent path, the hint is ignored.

Renaming is guarded: renaming an id to one that is already in use is rejected with an error.

### VS Code

There is no published VS Code extension in this repository. Use a generic LSP client extension (for example `vscode-lsp-client`-style extensions) or define a custom client via the VS Code extension API, launching:

```
node_modules/.bin/mdlineage-lsp --stdio
```

equivalently `node <repo>/packages/language-server/dist/server-entry.js --stdio`. This path has not been verified against a specific VS Code setup.

### Neovim

```lua
vim.lsp.start({
  name = 'mdlineage',
  cmd = { vim.fn.getcwd() .. '/node_modules/.bin/mdlineage-lsp', '--stdio' },
  root_dir = vim.fs.dirname(vim.fs.find({ '.git', 'mdlineage.config.yaml' }, { upward = true })[1]),
})
```

### Relationship to channel A

Channel A is a compatibility route: it works with any remark-based tooling but loses severity fidelity and structured quick fixes. Channel B offers everything in one server (lint plus language features). If you enable both on the same buffer, expect duplicate diagnostics; pick one. For editors already standardized on remark, A is the low-friction start; for anything else, prefer B.

## Channel C — MCP server (`mdlineage mcp --stdio`)

Transport is stdio. Pass `--root <dir>` to select the workspace; it defaults to the current working directory. Tools (as listed by `tools/list`, in order):

| Tool | Notes |
| --- | --- |
| `validate_document` | Validate a file; pass `content` to validate an **unsaved buffer** |
| `validate_repository` | Validate the whole workspace |
| `get_schema` | Return a schema |
| `list_document_ids` | Enumerate document ids |
| `resolve_relation_target` | Resolve a relation to its target |
| `suggest_metadata` | Pure analysis, writes nothing; each returned proposal's `id` field is the `proposal_id` to pass to `apply_metadata_patch` |
| `apply_metadata_patch` | Apply a proposal; **not** a read-only tool |

Two readable resources are exposed: `urn:mdlineage:schema:mdlineage-v1` and `urn:mdlineage:schema:mdlineage-config`.

### Write boundary and safety model (read this before enabling writes)

`apply_metadata_patch` by default applies the proposal **in memory only** and returns TextEdits, `patchedContent`, and a unified `diff`. It writes to disk **only** when you explicitly pass `write: true`, in which case the Front Matter is written atomically. The tool is annotated `readOnlyHint: false` and `destructiveHint: true` precisely because it can overwrite file content.

A disk write is refused when:

- the target resolves outside the workspace (including via symlinks);
- the target file does not exist on disk (proposals for unsaved buffers follow a different path);
- the file is not writable;
- the file content no longer matches the text the proposal was computed from (guards against clobbering someone else's edit).

`apply_metadata_patch` requires the `id` of a proposal returned by `suggest_metadata` (passed as `proposal_id`). The proposal queue lives in memory and is lost when the server restarts, so suggest-then-apply must happen within one server session.

### Client configuration (generic JSON)

MCP clients launch the server as a stdio subprocess. Example for Claude Desktop / Claude Code style configuration — replace `<repo>` with the absolute path of your checkout (or any directory you want to treat as the workspace root):

```json
{
  "mcpServers": {
    "mdlineage": {
      "command": "node",
      "args": ["<repo>/packages/cli/dist/main.js", "mcp", "--stdio", "--root", "<repo>"]
    }
  }
}
```

Alternative without a path into the repo (requires a local install):

```json
{
  "mcpServers": {
    "mdlineage": {
      "command": "npx",
      "args": ["--no-install", "mdlineage", "mcp", "--stdio"]
    }
  }
}
```

These snippets follow the standard MCP client configuration format but have not been verified inside any specific client application in this repository.

### Manual smoke test

The repository ships `mcp-stdio-smoke.mjs`, which connects a real MCP client over stdio, lists tools, and calls `validate_document` on a fixture. Run it from the repository root (build first; the first argument is the path to the MCP entry):

```
node mcp-stdio-smoke.mjs packages/mcp-server/dist/entry.js
```

Expected output includes the server version, the capabilities object, the seven tool names listed above, and diagnostics for the intentionally invalid fixture.

## Running the channels side by side

- **One channel is enough** for most users: channel B covers editing features end to end; channel C is for agents.
- Use **B + C** when both humans and agents work in the same repository: the editor gets language features, the agent gets validated, guarded patching.
- Use **A** only when you must stay inside existing remark tooling, and accept the severity collapse and missing structured quick fixes.
- The lint rules themselves come from one shared validator (`@mdlineage/validator`), so diagnostics are consistent across channels; see [diagnostics.md](diagnostics.md). Configuration overrides live in `mdlineage.config.yaml`; see [configuration.md](configuration.md).

## Troubleshooting

- **No diagnostics at all (channel A).** `remark.requireConfig: true` means the file is skipped entirely when no `.remarkrc.*` is found above it. Open the workspace at the repository root, not a parent directory.
- **Server binary not executable.** Run `npm run build`; the build restores the executable bit on the bins. Or invoke via `node <repo>/packages/cli/dist/main.js ...` directly.
- **MCP tool calls fail after a server restart.** Proposal `id`s from `suggest_metadata` are in-memory; re-run `suggest_metadata` after restarting the server.
- **`apply_metadata_patch` with `write: true` is refused.** Check the four refusal cases above: target inside the workspace (no symlink escape), file exists on disk, file writable, file unchanged since the proposal.
- **Workspace looks empty in the LSP/MCP.** Ensure the client sends `workspaceFolders` (or `rootUri`/`rootPath`) pointing at the repository root, or pass `--root <dir>` to the MCP server.
- **Lint gate divergence.** CI runs `npm run lint:md` with the same `.remarkrc.mjs`; if your editor shows different diagnostics, a personal plugin is likely active — that is what `remark.requireConfig` is there to prevent.
