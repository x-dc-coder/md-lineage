---
mdlineage:
  schema: 1
  id: docs.usage
  kind: guide
  status: active
---

# CLI usage

**`mdlineage`** validates Markdown repositories: front-matter metadata, cross-file relations, links, anchors, and line-ending hygiene. This page is the operator's manual — read it if you have cloned this repository, or if you want to run MDLineage over your own Markdown. For the metadata model itself, see [frontmatter-spec.md](frontmatter-spec.md); for editor integration, [editor-setup.md](editor-setup.md).

## Install and build

MDLineage is a five-package npm workspace: `@mdlineage/validator` (the rule core), `@mdlineage/remark-lint-mdlineage`, `@mdlineage/cli`, `@mdlineage/language-server`, and `@mdlineage/mcp-server`. Node 20 or newer is required (root `package.json`, `engines`).

From a fresh clone, at the repository root:

```shell
npm ci
npm run build
```

`build` runs `tsc -b && node scripts/ensure-bin-exec.mjs`; the second half adds the execute bit to the CLI's `bin` entry, which `npm ci` alone does not guarantee on every platform. After it succeeds, invoke the CLI directly:

```shell
node packages/cli/dist/main.js --version
```

The `node_modules/.bin/mdlineage*` links (and `npx --no-install mdlineage --version`) depend on the bin targets existing when npm installs: a clean `npm ci` before any build skips creating them. This repository is in the process of restoring them during `npm run build`; if you find them missing after a first install, that is the known case — re-run `npm install` (or `npm run build` on a fixed version) and they appear. The direct `node` path above always works.

```text
mdlineage 0.1.0
```

Useful scripts at the repository root:

| Script | What it does |
|---|---|
| `npm test` | Builds, then runs the full suite (519 passing tests) |
| `npm run lint:md` | The remark gate over `docs/` and `README.md` (`--frail`) |
| `npm run check:md` | `mdlineage check .` |
| `npm run check:md:changed` | `mdlineage check --changed` |
| `npm run clean` | `tsc -b --clean` |

## Quick start in your own repository

Five minutes, no commitment: everything below defaults to a dry run or a read.

```shell
cd /path/to/your/docs
mdlineage init          # dry run: prints the plan, writes nothing
mdlineage init --write  # writes mdlineage.config.yaml, .gitattributes, schemas/
```

`init` is idempotent, and an existing `.gitattributes` is only ever appended to, never rewritten:

```text
mdlineage: create mdlineage.config.yaml (metadata.required: false)
mdlineage: create .gitattributes:
mdlineage: +* text=auto eol=lf
mdlineage: create schemas/ (empty schema directory)
mdlineage: dry run, nothing written (3 changes; pass --write to apply)
```

The generated config adopts MDLineage gradually — `metadata.required: false` — so documents without metadata are not errors. Turn it on file by file once the corpus is on board.

Now write a document with metadata and validate it:

```shell
mdlineage check .
```

```text
mdlineage: 1 file checked, no diagnostics
```

Break it on purpose:

```shell
mdlineage check .
```

```text
getting-started.md:3:3 MDL102 error Missing required mdlineage field: kind
getting-started.md:3:3 MDL102 error Missing required mdlineage field: status
getting-started.md:5:3 MDL104 error Unknown mdlineage field: tpoics
getting-started.md:11:5 MDL401 warning Markdown link target does not exist: cache-policy.md
mdlineage: 1 file checked, 4 diagnostics (3 errors, 1 warning), 0 unreadable files
```

The exit code was `1`: three errors. Let the machine fix what it can fix without judgement, and read what it refuses to touch:

```shell
mdlineage fix            # dry run
mdlineage fix --write
```

```text
getting-started.md:7: [status] MDL102 requires 'status'; proposed from the configured vocabulary (first member of statuses).
getting-started.md:7: [kind] MDL102 requires 'kind'; proposed from the configured vocabulary (first member of kinds).
  +   status: draft
  +   kind: policy
mdlineage fix: 2 fixes in 1 file
```

Re-check: the two MDL102 errors are gone, but MDL104 and the dangling link remain — `fix` never renames a field or rewrites a link, because both need a human decision.

```text
getting-started.md:5:3 MDL104 error Unknown mdlineage field: tpoics
getting-started.md:13:5 MDL401 warning Markdown link target does not exist: cache-policy.md
mdlineage: 1 file checked, 2 diagnostics (1 error, 1 warning), 0 unreadable files
```

Fix those two by hand (rename `tpoics:` to `topics:` and point the link at a file that exists), and `check` is clean again.

## Command reference

Every command prints the full usage text with `--help` or `-h`; there is no per-subcommand help. Global options: `--format <text|json|sarif>` (default `text`), `--config <path>`, `--changed`, `--no-untracked`, `--exclude <pattern>` (repeatable), `--no-incremental`, `--no-baseline`, `--force`, `--report-only`, `--write`, `--frail`, `--root <dir>`, `--version`/`-v`.

### check

```shell
mdlineage check [paths...]   # default path: the CWD
mdlineage check --changed
```

The authoritative validation. One workspace pass: each document is validated on its own, then cross-file rules add duplicate IDs (MDL301), dead relation targets (MDL302), `supersedes` cycles (MDL305), dead markdown links (MDL401), and dead evidence anchors (MDL402). Paths are resolved against the CWD; `node_modules/**` and `**/dist/**` are excluded by default, and `--exclude` adds to that list rather than replacing it.

`--changed` restricts the run to files `git status --porcelain` reports as changed, compared by worktree bytes — never by `git diff`. With `.gitattributes` in force, a line-ending change produces an empty `git diff` but still shows in `git status`; `--changed` catches it, by design. Untracked files are included by default; `--no-untracked` skips them. In a repository with no changed Markdown the command reports that and exits `0`.

Exit codes: `0` with no error-severity diagnostics, `1` with any error (including an unreadable file or a bad `--config`), `2` on a usage error. `--frail` makes any diagnostic, warnings included, exit `1`.

### baseline

```shell
mdlineage baseline update [--report-only] [--force]
mdlineage baseline show
mdlineage baseline verify
```

A baseline records the violations a repository has **accepted**, so a repo adopting MDLineage mid-flight can land green and tighten over time. It is a committed file at the repository root — `.mdlineage-baseline.json`, version 1, with `generatedAt` and paths grouped by diagnostic code — not a local cache.

`update` runs the full workspace (never `--changed`: a contract written from a subset would silently exempt everything the subset missed) and merges the current violations into the baseline. `--report-only` prints the change set and writes nothing; `--force` is required to overwrite a baseline the tool cannot read, because that write would discard accepted exemptions with no way back:

```text
mdlineage: cannot read the committed baseline /tmp/usage-demo/.mdlineage-baseline.json: not valid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2) (accepted exemptions would be discarded; use --force to write anyway)
```

`show` lists per-code totals. `verify` is the CI gate: exit `0` only when current diagnostics match the baseline exactly — no new violation, and no stale entry. A stale entry is debt that was paid and must be recorded out by hand, because a stale exemption could later cover a reintroduced violation:

```text
- getting-started.md MDL401 (no longer violated)
mdlineage: baseline mismatch: 0 new violations, 1 stale entry
```

Note the markers: `+` new violation, `-` genuinely dropped from the file, `~` stale — an entry `update` **keeps on purpose**. Deleting the line from `.mdlineage-baseline.json` is the only way an accepted entry leaves.

### init

```shell
mdlineage init [--write]
```

Bootstraps the repository: `mdlineage.config.yaml`, `.gitattributes` (its policy line taken from the config's `eolPolicy`, default `* text=auto eol=lf`), and an empty `schemas/` directory. Dry run by default; `--write` applies. An existing `.gitattributes` only gets missing lines appended. A read-only path fails by name with exit `1` and no stack trace:

```text
mdlineage: cannot write mdlineage.config.yaml: EACCES: permission denied, open '/tmp/ro-test/mdlineage.config.yaml'
```

### fix

```shell
mdlineage fix [paths...] [--write]
```

Applies only repairs that need no judgement:

- insert a missing field (`MDL102`), proposed from the configured vocabulary — except a relation's `reason`, which gets the placeholder `TODO: explain this relationship (proposed by mdlineage)`;
- drop a relation that repeats an earlier one byte-for-byte within the same document (`MDL202`);
- normalize an enum value that matches exactly one vocabulary member case-insensitively (`MDL103`);
- normalize line endings to the configured policy (`MDL601`, `MDL602`).

It never touches an `id`, a relation's `type` or `target`, or the value of an unknown field. An enum that matches several members case-insensitively is reported on stderr and left alone:

```text
mdlineage: amb.md: 'kind: GUIDE' matches 2 vocabulary members (guide, Guide); needs a human decision, not auto-normalized
```

Writes are atomic (temp file plus rename in the same directory). A path that resolves outside the CWD is refused with exit `1`:

```text
mdlineage: refusing path outside the workspace: /tmp/fix-demo/e16-crlf-eol.md
```

### config validate

```shell
mdlineage config validate [--format text|json]
```

Checks that the config loads and passes its schema. A good config prints `mdlineage: config OK (<path>)` and exits `0`. A bad one prints an MDL900 diagnostic, same format as `check`, and exits `1`:

```text
mdlineage: MDL900 error Configuration /tmp/usage-demo/mdlineage.config.yaml fails the config schema at /metadata/required: must be boolean
```

**No config file is a legal state** — a missing config file exits `0`. An explicit `--config` pointing at a nonexistent file fails instead. `--format sarif` is rejected with exit `2`; this command emits text or JSON only.

### index rebuild

```shell
mdlineage index rebuild [--format text|json]
```

Scans the workspace, rebuilds the index in memory, and reports stats and index-level diagnostics. Nothing is persisted: the index is derived data, rebuilt on demand. On this repository:

```text
mdlineage: index rebuilt: 46 files, 39 ids, 14 relations, 328 anchors, 23 diagnostics (18 errors), not persisted
```

That sample is a clean-checkout run; a live tree that carries uncommitted new files reports more, because those files are part of the scan.

### suggest

```shell
mdlineage suggest <file>
```

Read-only. Prints the metadata proposals the MCP `suggest_metadata` tool would return, as JSON, and never writes:

```json
{
  "path": "intro.md",
  "operations": [
    {
      "jsonPointer": "/kind",
      "value": "policy",
      "rationale": "MDL102 requires 'kind'; proposed from the configured vocabulary (first member of kinds)."
    },
    {
      "jsonPointer": "/status",
      "value": "draft",
      "rationale": "MDL102 requires 'status'; proposed from the configured vocabulary (first member of statuses)."
    }
  ],
  "addresses": [
    "MDL102"
  ],
  "source": "rules",
  "generator": "mdlineage/suggest_metadata/rules-v1",
  "contentHash": "7a284541f7a023b77debd22ee996adc3448b0a75bbee9525066e4ab544d34142",
  "id": null,
  "createdAt": null
}
```

### server and mcp

```shell
mdlineage server --stdio   # the language server
mdlineage mcp --stdio      # the MCP server
```

Both take over stdin/stdout for JSON-RPC and print nothing until they start. Omitting the transport or passing an unknown option such as `--http` is a usage error (exit `2`). `--stdio` is the only supported transport. `mcp` accepts `--root <dir>` to name the tree it indexes (default: the CWD). See [editor-setup.md](editor-setup.md) for wiring these into an editor or an agent.

## Output formats

`--format` selects the shape for `check`, `config validate`, and `index rebuild`. The `baseline` subcommands (`show`, `update`, `verify`) currently ignore `--format` and always print text; `server`/`mcp` ignore it too.

**text** (default) — `path:line:column CODE severity message`, one line per diagnostic, then a summary. Config diagnostics are printed as `mdlineage.config.yaml:1:1 …`; an unreadable file as `path:1:1 MDL900 error Could not read file: …`, with the position segment kept so the line format stays parseable by anything splitting on `:`.

**json** — `check` emits `reports`, `unreadable`, `configDiagnostics`, `baseline`, `summary`; each `reports[i]` is `{ path, diagnostics }`, and `summary` carries `files`, `errors`, `warnings`, `information`, `unreadable`, and `byCode`. `config validate` emits `{ source, diagnostics }`, `index rebuild` emits `{ stats: { files, ids, relations, anchors }, diagnostics }`. Config diagnostics go to **stderr** in every format — they describe the run, not the documents — so a stdout-only JSON consumer never has to separate the two streams.

**sarif** — SARIF 2.1.0 for `check` only, with `$schema`, `version`, one `runs[]` entry, and one `driver.rules[]` item per code that appeared, each carrying `defaultConfiguration.level`. MDLineage's `information` and `hint` severities both map to the SARIF `note` level; `properties.mdlineageSeverity` keeps the exact value.

## Baseline workflow and CI

The sequence for a repository that is not yet clean:

```shell
mdlineage check . --no-baseline   # see the raw debt, nothing suppressed
mdlineage baseline update         # record it as accepted
git add .mdlineage-baseline.json  # the baseline is committed, not local
```

From then on `check .` reports the exempted violations as resolved, and the CI gate is:

```shell
mdlineage baseline verify
```

It exits `0` only when diagnostics and baseline agree exactly. The counts in this section come from a run taken while the sibling pages were still being written; re-run `check . --no-baseline` in your own tree for its current debt — the numbers move as files land. What the flag does is stable: it reports everything the baseline would have suppressed. Never copy a `--no-baseline` run into CI: the gate only means something when the baseline is the contract.

Two CI behaviours worth knowing. First, `verify` always validates the whole repository regardless of the caller's CWD, so a job that runs from a subdirectory sees the same graph and the same baseline a root run does. Second, a run with no baseline and no diagnostics exits `0` (clean adoption), while no baseline with violations exits `1` — the gate does not pass an unexempted repository by accident.

## Roots and scoping: where the traps are

Each command anchors "the workspace" differently, on purpose:

| Command | Root | Consequence |
|---|---|---|
| `check`, `fix` | the CWD | Paths resolve against it; `fix` refuses anything outside it |
| `baseline`, `init` | the git repository root (CWD outside a repo) | Both are repository-level contracts |
| config search | walks **up** from the CWD | A run from a subdirectory still finds the root config |

**A single-file run is not a mini workspace run.** `check some-file.md` does run the cross-file rules, but against a snapshot that contains only that file — so a relation target or link that lives in a sibling document is reported as a spurious MDL302/MDL401:

```text
second.md:11:5 MDL401 warning Markdown link target does not exist: getting-started.md
```

Run `check .` over the same tree and those reports disappear, because the full snapshot resolves them. `--no-incremental` is the switch that turns the cross-file rules off entirely (per-file validation only); without it, treat single-file cross-file results as best-effort hints, not verdicts. If you need trustworthy cross-file conclusions, check a directory, not a file.

**`baseline` and `init` ignore the CWD on purpose.** A baseline written from a subdirectory would hold keys a root run could not match, and `verify` run from a subdirectory could pass against a repository that is not clean. Outside a git repository the CWD stands in.

## FAQ

**`check .` says no diagnostics but my documents have no metadata. Is anything happening?**
Yes. `metadata.required: false` — the default `init` generates — suppresses MDL003 entirely, so metadata checks stay off until a repository opts in (writing a front matter block activates that file's contract; a layout rule can scope the requirement to a subtree). This repository now runs that opt-in pilot: `metadata.required: true` with a catch-all layout rule (`require.frontmatter: optional`) that exempts everything except `docs/**`, which must carry front matter — see [configuration.md](configuration.md). If the repository carries a baseline, exempted violations are suppressed too; use `--no-baseline` to see them.

**Why is a warning not failing my CI?**
Only errors produce exit `1` by default. Pass `--frail` when any diagnostic should fail — this repository uses exactly that for its own remark gate (`npm run lint:md`).

**`--changed` reports a file whose `git diff` is empty. Why?**
The command compares worktree bytes via `git status --porcelain`, not `git diff`. A line-ending change is invisible to `git diff` once `.gitattributes` normalizes the index, but the worktree bytes still differ, and that is the case MDLineage exists to catch. See [line-ending-management.md](line-ending-management.md) for the incident that motivated it.

**`fix` fixed my missing fields but not my typo.**
Correct: renaming a field is a judgement call, so it is suggested (`suggest`, or the MCP proposal) but never auto-applied. Only insertions, exact-duplicate relation removal, unambiguous enum normalization, and line-ending normalization are safe enough to run unattended.

**`baseline update` says `~ stale` but the file still has the entry.**
That is intended. `update` merges and keeps accepted debt, so a reintroduced violation cannot slip back under a stale exemption. Open `.mdlineage-baseline.json` and delete that line to record the debt out; `verify` will then pass.

**`check` reports a link to a file I know exists.**
If you ran `check <one-file.md>`, the cross-file rules ran against a snapshot holding only that file, so no sibling target was resolved. Check the containing directory instead. If you ran a directory check and the link is still dead, the target really is missing relative to the linking document.

**The exit code was `2` and I got the whole help text.**
That is a usage error — an unknown command, an unknown option, a bad `--format` value, or a path that matches nothing. The reason is on the line above the help text; it is never a diagnostic.
