# Configuration and Front Matter reference

MDLineage reads configuration from two places, and the boundary between them is
deliberate:

1. **Front Matter in each Markdown document** — the `mdlineage:` key holds the
   document's own metadata: its identity (`id`), classification (`kind`,
   `status`, `authority`) and its confirmed `relations`. This is the
   authoritative fact source.
2. **`mdlineage.config.yaml` at the repository root** — a declarative,
   non-executable file that states the *rules and the scope*: which files are
   validated, which vocabulary values are legal, how strict each relation type
   is, and how severe each diagnostic code is.

The config file is **not executable**: it is data, never code, and a preset named
in `extends` is read, never run. It holds no document identity and no relations —
those live only in the Markdown, so the corpus stays valid even if every config
file is deleted. The config can never make a document's metadata true or false;
it only decides whether an authored value or relation is acceptable.

The machine-readable truth sources for this page are
[`../schemas/mdlineage-config.schema.json`](../schemas/mdlineage-config.schema.json)
(repository configuration) and
[`../schemas/mdlineage-v1.schema.json`](../schemas/mdlineage-v1.schema.json)
(metadata); codes are registered in
[`../schemas/diagnostic-codes.json`](../schemas/diagnostic-codes.json) and
explained in [diagnostics.md](diagnostics.md).

## Two layers, one boundary

| Question | Answered by |
|---|---|
| What is this document? Who does it depend on? | Front Matter (`mdlineage:` key) |
| Which files are in scope? Which values are legal? How loud is a failure? | `mdlineage.config.yaml` |

### Where the config file is found

- `check`, `fix` and `suggest` search **upward from the current working
  directory**, so a run inside a subdirectory still finds the repository config.
- `--config <path>` names a file explicitly. A missing *implicit* config is a
  legal state (built-in defaults apply, silently); a missing *explicit* path is
  an error. `mdlineage config validate` schema-checks the file alone.
- When a config cannot be parsed or fails the schema, the run reports **MDL900**,
  falls back to the built-in defaults, and document validation continues. A
  broken config never blocks the corpus.

## Repository configuration reference

Only `configVersion` is required; every other key is optional. All defaults below
are read from `schemas/mdlineage-config.schema.json` and from `defaultConfig()` in
`packages/validator/src/config.ts`.

### Top-level keys

| Key | Type | Default | What it controls | Diagnostics |
|---|---|---|---|---|
| `configVersion` | number, must be `1` | — (required) | Configuration schema version | MDL900 on any other value |
| `files` | object | see below | Discovery scope for workspace indexing | none directly |
| `metadata` | object | see below | Front matter extraction behaviour | MDL003, MDL104 |
| `vocabulary` | object | see below | Legal `kind` / `status` / `authority` values | MDL103 |
| `relations` | object | see below | Per-relation-type strictness | MDL103, MDL304, MDL305 |
| `lifecycle` | object | see below | Deprecated reference blocking and staleness | MDL306, MDL801 |
| `diagnostics` | object | see below | Severity override per code | every overridable code |
| `eolPolicy` | `lf` \| `crlf` \| `cr` | `lf` | Line-ending policy | MDL601, MDL602 |
| `schemaFile` | string | unset | Path to a repository-specific metadata schema | MDL102, MDL104, MDL900 |
| `extends` | array of strings | unset | Organization presets to inherit | MDL900 |
| `layout` | array | unset | Directory layout conventions | MDL501 |
| `policies` | object | unset | Reserved for repository policy rules | none (not implemented) |

Unknown top-level keys are rejected: the config schema sets
`additionalProperties: false`, so a typo such as `diagnostic:` is an MDL900
config error rather than a silently ignored block.

### `files` — discovery scope

| Key | Type | Default | Notes |
|---|---|---|---|
| `include` | array of globs | `['**/*.md']` | Candidate files for the workspace scan |
| `exclude` | array of globs | `['node_modules/**', 'dist/**', 'vendor/**']` | Directories and paths to skip |

The CLI, the language server and the MCP server all respect `files.exclude`.
The built-in exclusions (`node_modules/**`, `dist/**`, `vendor/**`) are always
prepended; setting `exclude: []` does not remove built-in exclusions. The CLI's
repeatable `--exclude <pattern>` flag appends further patterns to the exclusion list.

### `metadata` — Front Matter extraction

| Key | Type | Default | Effect | Diagnostics |
|---|---|---|---|---|
| `key` | string | `mdlineage` | Which front matter key holds the metadata | MDL003 |
| `required` | boolean | `true` | A document without the key reports MDL003; `false` suppresses it repository-wide | MDL003 |
| `preserveUnknownTopLevelFields` | boolean | `true` | Declares that unknown top-level front matter fields written by other tools are kept | none |
| `rejectUnknownMdlineageFields` | boolean | `true` | Unknown keys *inside* the `mdlineage` object are rejected | MDL104 |

`preserveUnknownTopLevelFields` documents rule 8 of
[frontmatter-spec.md](frontmatter-spec.md), but no rule reads it today: unknown
top-level fields are never diagnosed either way (verified — flipping the key to
`false` changed nothing). `rejectUnknownMdlineageFields` is in the same state:
it loads and passes the config schema, but no rule consumes it, so setting it to
`false` does **not** relax MDL104 — unknown keys inside `mdlineage` still report
MDL104 unconditionally (verified), because the check comes from the
`additionalProperties: false` clause of `mdlineage-v1.schema.json`. See
[Keys accepted but not yet enforced](#keys-accepted-but-not-yet-enforced).

### `vocabulary` — the only source of value validity

| Key | Type | Default (from `defaultConfig()`) | Effect |
|---|---|---|---|
| `kinds` | array of strings | `policy`, `guide`, `architecture`, `reference` | Legal `kind` values |
| `statuses` | array of strings | `draft`, `active`, `deprecated` | Legal `status` values |
| `authorities` | array of strings | `canonical`, `supporting` | Legal `authority` values |

`mdlineage-v1.schema.json` constrains these fields by type only, **on purpose**:
the vocabulary is repository-local. A value outside the configured list reports
**MDL103**. The diagnostic message names the allowed values, for example:

```text
doc.md:5:9 MDL103 error 'kind' value "note" is outside the configured
vocabulary (policy, guide, architecture, reference).
```

Declaring one list leaves the other two at their defaults; an empty array means
"unconstrained" (`vocabularyAllows` treats a missing or empty list as allowing
everything).

### `relations` — per-type validation switches

Keys must be one of the seven v1 relation types (`depends_on`, `implements`,
`refines`, `supersedes`, `contradicts`, `example_of`, `related_to`); a misspelled
key is an MDL900 config error. **Direction is not configurable here** — it is
fixed per type by the vocabulary in [frontmatter-spec.md](frontmatter-spec.md) and
read as `A <type> B`.

Built-in defaults (read from `defaultConfig()`; `—` means the switch is absent):

| Type | `impact` | `reasonRequired` | `selfReference` | `cycles` | `severity` |
|---|---|---|---|---|---|
| `depends_on` | `true` | `true` | `forbidden` | — | — |
| `implements` | `true` | `true` | — | — | — |
| `refines` | `true` | `true` | — | — | — |
| `supersedes` | `true` | `true` | — | `forbidden` | — |
| `contradicts` | — | `true` | — | — | `warning` |
| `example_of` | `false` | — | — | — | — |
| `related_to` | `false` | — | — | — | — |

- `impact` drives change-impact analysis in the derived layer; it produces no
  diagnostic.
- `reasonRequired: true` makes a blank `reason` on that type report **MDL304**. A
  *missing* `reason` on a strong type is still the schema's structural check
  (**MDL102**); MDL304 covers a present-but-empty value and is also how a
  repository promotes a weak type without editing the JSON Schema.
- `selfReference: forbidden` reports **MDL103** ("self-reference is forbidden for
  relation type ...") when a relation targets its own document's id. Only
  `depends_on` forbids it by default.
- `cycles: forbidden` reports **MDL305**, once per strongly connected component.
  Only `supersedes` forbids cycles by default.

Two behaviours worth knowing, both verified:

- **A type the config names is taken in full.** The entry *replaces* the
  defaults for that type; it does not merge key by key. Writing
  `relations: {contradicts: {severity: error}}` silently drops the shipped
  `reasonRequired: true` for `contradicts`, and MDL304 stops firing for it.
- **A type the config omits keeps its defaults.** A partial `relations` block
  means "the rest stay as shipped", so saying nothing about `supersedes` does not
  switch off cycle detection.

The per-type `severity` switch is accepted by the schema but no rule reads it
yet (verified: promoting `contradicts` to `severity: error` while keeping
`reasonRequired: true` still reported MDL304 as a warning). Use the
`diagnostics` block to change severities.

### `lifecycle` — deprecated reference blocking and staleness

Governs whether active documents may reference deprecated documents (MDL306)
and whether document ages exceed repository thresholds (MDL801).

| Key | Type | Default | Meaning | Diagnostics |
|---|---|---|---|---|
| `activeStatuses` | string[] | `['active']` | Statuses considered active; empty array disables MDL306 | MDL306 |
| `deprecatedStatuses` | string[] | `['deprecated']` | Statuses considered deprecated targets | MDL306 |
| `blockingRelations` | string[] | `['depends_on', 'implements', 'refines']` | Relation types that trigger MDL306 | MDL306 |
| `staleAfterDays` | integer | `0` | Max age in days before staleness warning; `0` disables MDL801 | MDL801 |
| `staleStatuses` | string[] | `['active']` | Document statuses subject to staleness check | MDL801 |
| `exempt` | string[] | `[]` | Path globs exempt from staleness checks | none |

- **Why `supersedes` is omitted from `blockingRelations` by default**:
  A new active document replacing a deprecated document naturally points at it
  via `supersedes`. Blocking `supersedes` would prevent documenting migrations.
- **Two-tier clock for MDL801**:
  When `staleAfterDays > 0`, the validator first inspects authored metadata
  timestamps: `updated_at` takes precedence, followed by `created_at`. If both
  are absent, the workspace layer falls back to Git commit timestamps batched via
  `git log`. `reviewed_at` is never used as a clock.
- **Exemptions**:
  Paths matching `exempt` globs (for example `exempt: ['archive/**', 'docs/archive/**']`)
  are never reported as stale.

### `diagnostics` — severity overrides

Keys are diagnostic codes, values are `error`, `warning`, `information` or
`hint`. Only the 22 codes registered in
[`../schemas/diagnostic-codes.json`](../schemas/diagnostic-codes.json) may carry
an override:

```text
MDL001  MDL002  MDL003  MDL101  MDL102  MDL103  MDL104
MDL201  MDL202  MDL203  MDL301  MDL302  MDL303  MDL304
MDL305  MDL306  MDL401  MDL402  MDL501  MDL601  MDL602
MDL801
```

An unknown code such as `MDL999`, or a code from a reserved range (MDL7xx,
MDL9xx), is rejected with MDL900. Built-in defaults are the registry
defaults — errors for parse, schema, duplicate-id, unresolved-target and
forbidden-relation failures; warnings for missing reasons, anchors, deprecated
references, staleness, layout violations, and line endings.

Escalating a warning to an error changes the exit code of `mdlineage check`
(0 → 1) without touching any document. Verified end to end in a scratch
repository — a `refines` relation whose `evidence` anchor exists in neither the
current nor the target document:

```yaml
configVersion: 1
diagnostics:
  MDL201: error
```

```text
# before (registry default, warning): exit code 0
doc.md:11:7 MDL201 warning Evidence anchor does not exist: #nope
# after (override): exit code 1
doc.md:11:7 MDL201 error Evidence anchor does not exist: #nope
```

Downgrading works the same way (`MDL201: hint` reported as a hint, exit code
still 0). The remark plugin collapses `information` and `hint` to `warning`
(unified lint has only three levels); the dedicated language server preserves
all four severities one-to-one, so a downgrade is visible in
the CLI, JSON, SARIF and dedicated-LSP outputs, and only invisible on the
remark channel.

### `eolPolicy` — line endings

| Value | Meaning | MDL602 expectation | `.gitattributes` line written by `mdlineage init` |
|---|---|---|---|
| `lf` (default) | Files must use LF | LF | ``* text=auto eol=lf`` |
| `crlf` | Files must use CRLF | CRLF | ``* text=auto eol=crlf`` |
| `cr` | Files must use CR | CR | ``* text=auto`` |

git's `eol` attribute has no CR form, so a `cr` policy maps to the bare
normalization rule. The `.gitattributes` column above is what `mdlineage init`
writes; verified by running it (dry run) under each of the three policies.

The policy also decides MDL601 (mixed endings inside one file) and MDL602
(endings differing from the policy): a pure-CRLF file is silent under
`eolPolicy: crlf` and reports `MDL602 ... (expected LF)` under the default `lf`.
See [line-ending-management.md](line-ending-management.md) for the incident
behind this feature.

### `schemaFile` — custom repository schema

`schemaFile` names a custom JSON Schema file extending `mdlineage-v1.schema.json`
with repository-specific fields. When configured, custom fields declared in the
schema are allowed without triggering MDL104, and schema constraints (such as
required fields, format patterns, or enums) are validated, reporting MDL102 or
MDL103 accordingly. If the referenced file does not exist or fails to compile,
an MDL900 configuration error is reported.

### `extends` — organization presets

`extends` is an array of preset files or package names, for sharing organization
rules without forking every repository:

- **Resolution.** A name containing a path separator (`./`, `../`, `/`) resolves
  against the extending file's directory; a bare name resolves to
  `node_modules/<name>/mdlineage.config.yaml`. On POSIX a scoped name such as
  `@acme/preset` contains `/` and is therefore treated as a path — verified: it
  resolved to `./@acme/preset` and reported MDL900 `Config file not found`.
- **Merge order.** Presets are merged *before* the file's own keys, which then
  overlay them; multiple presets merge in list order, **later entries win**. Maps
  merge key by key (`relations`, `metadata`, `diagnostics`, `vocabulary`), while
  arrays and scalars replace, so a preset's `statuses` list is not unioned with
  the repository's. A preset may itself `extends`, to any depth.
- **Cycles are a hard refusal.** `a extends b extends a` reports MDL900
  `Circular extends: ... is already being extended (a → b → a)`; the config falls
  back to defaults.

Verified chain (repository config → `./org-preset.yaml` →
`node_modules/acme-preset/mdlineage.config.yaml`): the package preset contributed
`vocabulary.kinds: [policy, note]` and `MDL201: error`, the intermediate preset
`vocabulary.statuses: [active]`, and the repository file only
`metadata.required: false`:

```text
# 'note' accepted (inherited kinds), MDL201 escalated (inherited override),
# 'draft' rejected (the preset's statuses replaced, not unioned):
doc.md:6:11 MDL103 error 'status' value "draft" is outside the configured
vocabulary (active).
doc.md:11:7 MDL201 error Evidence anchor does not exist: #nope
mdlineage: config OK (.../mdlineage.config.yaml)
```

A missing preset is an MDL900 (`Config file not found: ./missing.yaml (extended
from ...)`) and the run falls back to the defaults.

### `layout` — directory conventions (MDL501)

`layout` defines path-based structural policies. Each rule specifies a `match`
glob and constraints:

- `forbidStatus`: list of status values forbidden under matching paths.
- `require.kind`: required kind(s) for matching documents.
- `require.authority`: required authority value(s).
- `require.frontmatter`: `required` (default) or `optional` (exempts MDL003).

Violations produce `MDL501` warnings. `policies` remains reserved for future DSL extensions.

## Front Matter reference

The full field semantics, the relationship vocabulary with directions, and
worked examples live in [frontmatter-spec.md](frontmatter-spec.md); this section
is only the checklist a configuration author needs.

Inside the front matter key named by `metadata.key` (default `mdlineage`):

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Metadata schema version; only `1` is supported (MDL101 otherwise) |
| `id` | yes | Stable repository-wide document id; unique (MDL301), pattern-checked (MDL103) |
| `kind` | yes | Document category, checked against `vocabulary.kinds` |
| `status` | yes | Lifecycle state, checked against `vocabulary.statuses` |
| `authority` | no | Source-of-truth designation, checked against `vocabulary.authorities` |
| `topics` | no | Concepts for filtering and discovery |
| `aliases` | no | Alternate names and search terms |
| `relations` | no | Typed relationships to other document ids |

Each relation entry carries `type` (one of the seven v1 types), `target` (**a
document id, never a path**), an optional `reason`, and an optional `evidence`
anchor written as `"#anchor"`. `reason` is required and non-empty for the strong
types (`depends_on`, `implements`, `refines`, `supersedes`, `contradicts`) by the
JSON Schema; a blank one reports MDL304. The `evidence` anchor resolves against
the relation's **target** document — failure there is MDL402, while an anchor
missing from the **current** document is MDL201. Direction is fixed per type and
is never configured per relation. Unknown top-level front matter fields are
preserved and never diagnosed; unknown keys *inside* the `mdlineage` object
report **MDL104** regardless of `rejectUnknownMdlineageFields` (not yet
enforced — see above).

## Recipes

### Gradual adoption in an existing repository

```yaml
configVersion: 1
metadata:
  required: false
```

MDL003 stays off repository-wide while documents are onboarded file by file, and
accepted debt is recorded with `mdlineage baseline update` (see
[usage.md](usage.md)). This repository's own
[`mdlineage.config.yaml`](../mdlineage.config.yaml) is exactly this file, with
comments explaining the plan.

### Escalate one code to an error

```yaml
configVersion: 1
diagnostics:
  MDL304: error      # blank reasons now fail the run
  MDL201: information # and evidence anchors become informational
```

### Tighten one relation type

```yaml
configVersion: 1
relations:
  example_of:
    reasonRequired: true
```

Weak types stop being reason-optional (MDL304 now fires for them); remember the
replace-not-merge rule and re-declare every switch the type should keep.

### Skip a directory

`files.exclude` in `mdlineage.config.yaml` is respected by `mdlineage check`,
the language server, and the MCP server. The repeatable `--exclude` CLI flag can be
used to add per-run exclusions:

```bash
mdlineage check . --exclude 'generated/**'
```

```yaml
configVersion: 1
files:
  exclude: ['generated/**']
```

### Adopt an organization preset

```yaml
configVersion: 1
extends:
  - ../mdlineage-base.yaml
metadata:
  required: false   # this repository's own key wins over the preset
```

### A CRLF repository

```yaml
configVersion: 1
eolPolicy: crlf
```

then run `mdlineage init` (dry run by default, `--write` to apply) so
`.gitattributes` carries ``* text=auto eol=crlf``, matching what the validator
enforces.

## Keys accepted but not yet enforced

Verified against the current build (2026-09-24): `metadata.preserveUnknownTopLevelFields`,
`metadata.rejectUnknownMdlineageFields`, `relations.<type>.severity`, `schemaFile`,
`layout` and `policies` all load and pass the
config schema, but no rule consumes them yet — see the notes in each section above.
