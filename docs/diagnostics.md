---
mdlineage:
  schema: 1
  id: docs.diagnostics
  kind: reference
  status: active
  created_at: 2026-09-24
  updated_at: 2026-09-30
---

# Diagnostic code reference

Every problem MDLineage reports carries a stable `MDLxxx` code. Codes and
severities are versioned identifiers: messages may improve over time, but a
code's meaning and severity do not change without a schema version bump. The
machine-readable source of truth is
[`schemas/diagnostic-codes.json`](../schemas/diagnostic-codes.json); this page
is the human-facing companion, with fix guidance for each code.

Severity defaults can be overridden per code in the `diagnostics:` block of
`mdlineage.config.yaml` (see [configuration.md](configuration.md)). Examples
below are real outputs from the CLI; the scratch file names are abbreviated.

Related pages: [frontmatter-spec.md](frontmatter-spec.md) (metadata format),
[usage.md](usage.md) (CLI), [line-ending-management.md](line-ending-management.md)
(line-ending policy).

## Which entry point reports which codes

MDLineage validates at two layers. **Single-document** rules need only the file
in front of the validator; **cross-file** rules need a workspace snapshot that
knows every document id and every file path. This distinction is the single
most common source of confusion: a cross-file problem (say, a duplicate id) is
invisible when you validate one file alone.

| Entry point | Layer | Codes it can report |
| --- | --- | --- |
| remark plugin (`remark-lint-mdlineage`) | single document | MDL001–MDL003, MDL101–MDL104, MDL201–MDL203, MDL501, MDL601, MDL602, MDL801 |
| `mdlineage check <file> --no-incremental` | single document | MDL001–MDL003, MDL101–MDL104, MDL201–MDL203, MDL501, MDL601, MDL602, MDL801 |
| MCP `validate_document` | single document | MDL001–MDL003, MDL101–MDL104, MDL201–MDL203, MDL501, MDL601, MDL602, MDL801 |
| `mdlineage check .` (full tree) | workspace | all of the above **plus** MDL301–MDL306, MDL401, MDL402, MDL801 (Git clock) |
| `mdlineage index rebuild` | workspace | all of the above plus MDL301–MDL306, MDL401, MDL402, MDL801 (Git clock) |
| Language server (LSP) | workspace | all of the above plus MDL301–MDL306, MDL401, MDL402, MDL801 (Git clock) |
| MCP `validate_repository` | workspace | all of the above plus MDL301–MDL306, MDL401, MDL402, MDL801 (Git clock) |

Two caveats verified by running the CLI:

- `mdlineage check <single-file>` **without** `--no-incremental` is a special
  case: it still runs the cross-file rules, but against the snapshot it has —
  one that may not contain the *other* documents involved. It reported a
  spurious `MDL302` for a target that existed in a sibling file, and an
  `MDL401` for a link to an existing file. Treat single-file cross-file
  results as best-effort hints, not verdicts; run `check .` to be sure.
- The remark plugin also surfaces configuration problems as `MDL900` (see
  [reserved ranges](#reserved-ranges) below).

## Code summary

| Code | Severity | Layer | Auto-fixable | One-line meaning |
| --- | --- | --- | --- | --- |
| MDL001 | error | front matter | no | Front matter block is not closed |
| MDL002 | error | front matter | no | Front matter YAML could not be parsed |
| MDL003 | error | front matter | no | Missing mdlineage metadata while `metadata.required` is on |
| MDL101 | error | schema | no | Unsupported metadata schema version |
| MDL102 | error | schema | yes | Missing required mdlineage field |
| MDL103 | error | schema | partially | Invalid type, pattern, or value |
| MDL104 | error | schema | no | Unknown mdlineage field |
| MDL201 | warning | document | no | Evidence anchor does not exist in this document |
| MDL202 | warning | document | yes | Duplicate relation in one document |
| MDL203 | warning | document | no | Same-page link anchor does not exist |
| MDL301 | error | workspace | no | Duplicate document id |
| MDL302 | error | workspace | no | Relation target does not exist |
| MDL303 | error | workspace | — | Ambiguous relation target (reserved; unreachable today) |
| MDL304 | warning | workspace | no | Reason-required relation has an empty reason |
| MDL305 | error | workspace | no | Relations of a forbidden-cycle type form a loop |
| MDL306 | warning | workspace | no | Active document references deprecated target |
| MDL401 | warning | link | no | Markdown link target path does not exist |
| MDL402 | warning | link | no | Cross-document anchor does not exist |
| MDL501 | warning | policy | no | Layout rule violation |
| MDL601 | warning | EOL scan | yes | Mixed line endings within one file |
| MDL602 | warning | EOL scan | yes | Line endings do not match repository policy |
| MDL801 | warning | policy | no | Document has not been updated within staleAfterDays |

## MDL0xx — front matter structure

### MDL001 — Front matter block is not closed (error)

The opening `---` has no matching closing `---`. A dedicated boundary scanner
runs before AST parsing because remark-frontmatter would otherwise degrade the
unclosed block to ordinary text. Fix: close the block, or delete the stray
opening fence.

```text
docs/s1.md:1:1 MDL001 error Front matter block is not closed
```

### MDL002 — Front matter YAML could not be parsed (error)

The YAML between the fences is rejected by a safe loader: bad indentation,
duplicate keys, tab characters, multi-document markers (`---` inside the
block), or an unsafe type. Fix the YAML; the message quotes the parser's
reason.

```text
docs/t2.md:3:7 MDL002 error Front matter YAML could not be parsed: Map keys must be unique at line 3, column 3:
```

### MDL003 — Missing mdlineage metadata (error)

The document has no `mdlineage` key (or no front matter at all) while
`metadata.required` is enabled. With `metadata.required: false` the code is
suppressed entirely; under `metadata.required: true` a layout rule with
`require.frontmatter: optional` suppresses it per path — this repository
requires it for `docs/**` and exempts everything else. Adoption debt can also
be recorded via the baseline instead of tripping this error.

```text
docs/s3.md:1:1 MDL003 error Missing mdlineage metadata: no 'mdlineage' key
```

## MDL1xx — metadata schema

### MDL101 — Unsupported metadata schema version (error)

The `schema` field is not a version the validator supports. Schema v1 accepts
only `1`. Fix: set `schema: 1` (or migrate to a supported version when one
exists).

```text
docs/t1.md:3:11 MDL101 error Unsupported metadata schema version
```

### MDL102 — Missing required mdlineage field (error)

A required field (`schema`, `id`, `kind`, `status`, or a non-empty `reason` on
a strong relation) is absent or empty. Auto-fixable: `mdlineage fix` inserts
skeleton lines for missing fields, proposing the first legal value from the
configured vocabulary — review the proposal before writing.

```text
docs/t1.md:3:3 MDL102 error Missing required mdlineage field: id
docs/b.md:11:7 MDL102 error Missing required mdlineage field: reason
```

### MDL103 — Invalid type, pattern, or value (error)

A field has the wrong type, fails its pattern (`id`, relation `target`,
evidence anchor), or falls outside the configured vocabulary. Vocabulary
membership comes from `mdlineage.config.yaml`, not the schema. Partially
auto-fixable: `mdlineage fix` normalizes an enum-like value only when it has a
unique case-insensitive match in the vocabulary; ambiguous values are left for
a human and noted on stderr.

```text
docs/a.md:5:9 MDL103 error 'kind' value "doc" is outside the configured vocabulary (policy, guide, architecture, reference).
docs/t4.md:11:7 MDL103 error Invalid type, pattern, or value at /relations/0/evidence
```

### MDL104 — Unknown mdlineage field (error)

A key inside the `mdlineage` object is not part of schema v1 (enforced via
`additionalProperties: false`). This catches model-suggested misspellings and
invented fields — note that `evidence` is only valid **inside a relation
entry**, not at the top of `mdlineage`:

```text
docs/a.md:11:3 MDL104 error Unknown mdlineage field: evidence
```

Editors offer a code action for MDL104 on scalar unknown fields (delete), and
for MDL102/MDL202; see [editor-setup.md](editor-setup.md).

## MDL2xx — document-internal semantics

### MDL201 — Evidence anchor does not exist (warning)

An evidence anchor does not resolve to a heading of the **current** document.
An anchor that resolves against a different document is MDL402 instead. Fix:
point the anchor at an existing heading in this document (or link to the other
document explicitly).

```text
docs/t4.md:11:7 MDL201 warning Evidence anchor does not exist: #missing-heading
```

### MDL202 — Duplicate relation (warning)

The same `(type, target)` pair is declared more than once in one document.
Safe to auto-fix: `mdlineage fix` deletes the redundant entry.

```text
docs/d.md:11:7 MDL202 warning Duplicate relation: refines → docs.a
```

### MDL203 — Same-page anchor does not exist (warning)

A same-page Markdown link (`[x](#sec)`) names a fragment that no heading of
the document produces. A bare fragment has an empty path, so it is neither
MDL401 (path check) nor MDL402 (another document's fragment); the check lives
at the document layer, where the target headings exist. Empty fragments
(`[x](#)`) are not checked. Fix: rename the fragment or add the heading.

```text
docs/b.md:14:1 MDL203 warning Same-page anchor does not exist: #missing
```

## MDL3xx — cross-document identity and relations

These codes need the whole tree; use a workspace entry point (see the table
above).

### MDL301 — Duplicate document id (error)

The `id` is already claimed by another document. Under single-document
validation this is at best a best-effort, snapshot-based report. Fix: give one
of the two documents a fresh id (and update relations pointing at it).

```text
docs/c.md:4:7 MDL301 error Duplicate document id: docs.a (first claimed by docs/a.md)
```

### MDL302 — Relation target does not exist (error)

A relation target resolves to zero known document ids. Fix the target id —
`mdlineage fix` will not invent or rewrite ids.

```text
docs/a.md:8:7 MDL302 error Relation target does not exist: docs.b
```

### MDL303 — Ambiguous relation target (error, reserved)

Reserved: this code can only fire when alias or path fallback resolution is
enabled in configuration. Under the current pure-id resolution, MDL301
guarantees that an id is unique, so a target resolves to at most one document
and MDL303 is **unreachable today**. No fix exists because no configuration
can trigger it yet.

### MDL304 — Relation is missing a reason (warning)

A relation whose type is configured with `reasonRequired: true` has an empty
or absent `reason`. Note the split: a **strong** relation with the `reason`
field missing entirely is a schema failure reported by MDL102 (error); a
reason-required relation with a blank value is this warning. Fix: write the
reason.

```text
docs/b.md:10:7 MDL304 warning Relation contradicts → docs.a has an empty reason
```

### MDL305 — Relation forms a forbidden cycle (error)

Relations of a type configured with `cycles: forbidden` close a loop in the
derived graph. The cycle is reported **once per strongly connected
component**, anchored at the lexicographically smallest path in that
component, so a two-document loop produces one diagnostic, not two. Fix:
remove or redirect one edge in the loop.

```text
docs/a.md:8:7 MDL305 error refines cycle among 2 documents: docs.a → docs.b → docs.a
```

### MDL306 — Active document references deprecated target (warning)

An active document (`status` in `lifecycle.activeStatuses`, default `['active']`)
references a deprecated target (`status` in `lifecycle.deprecatedStatuses`, default `['deprecated']`)
via a blocking relation (`lifecycle.blockingRelations`, defaults to `depends_on`, `implements`, `refines`).
`supersedes` is deliberately excluded by default to allow documenting migrations. Fix: update the
target document's status, or replace the dependency.

```text
docs/a.md:8:7 MDL306 warning Active document references deprecated target: depends_on → docs.b (status deprecated)
```

## MDL4xx — links and anchors

### MDL401 — Markdown link target does not exist (warning)

An ordinary Markdown link points to a path that is absent from the repository.
Links are parsed as `links_to` edges in the derived layer and are not validated
against relations. Fix: correct the path or add the file.

```text
docs/a.md:16:29 MDL401 warning Markdown link target does not exist: docs/zzz.md
```

### MDL402 — Markdown heading anchor does not exist (warning)

An evidence anchor or link fragment resolves against **another** document and
does not match a heading there. Cross-file anchor resolution is checked at the
workspace layer. Fix: update the fragment to a heading the target document
actually has.

```text
docs/a.md:16:5 MDL402 warning Markdown link fragment does not exist in docs/b.md: #nope
```

## MDL6xx — line-ending hygiene

Both codes come from a fast raw-buffer scan that runs **before** AST parsing,
so they stay exact even when the Markdown below fails to parse. Both are safe
to auto-fix: `mdlineage fix` normalizes the whole file to the configured
policy while preserving AST and front matter semantics. Details in
[line-ending-management.md](line-ending-management.md).

### MDL601 — Mixed line endings within one file (warning)

More than one line-ending style (LF, CRLF, CR) appears in a single file.

```text
docs/eol.md:2:1 MDL601 warning Mixed line endings within one file
```

### MDL602 — Line ending does not match repository policy (warning)

The file's line endings differ from the configured policy (default LF).

```text
docs/eol.md:1:1 MDL602 warning Line ending does not match repository policy (expected LF)
```

## MDL5xx — policy and layout conventions

### MDL501 — Layout rule violation (warning)

Document metadata violates repository layout policy (`forbidStatus`, `require.kind`, `require.authority`).
Fix: adjust document metadata or update layout configuration rules.

```text
docs/a.md:1:1 MDL501 warning Layout rule violation: status 'draft' is forbidden for 'docs/**'
```

## MDL8xx — lifecycle and freshness

### MDL801 — Document is stale (warning)

The document has not been updated within the configured `lifecycle.staleAfterDays`
threshold (only active when `staleAfterDays > 0`). The validator checks authored
metadata timestamps first (`updated_at` prioritized over `created_at`); if neither is
present, the workspace layer falls back to Git commit timestamps via `git log`.
`reviewed_at` is never used as a clock. Fix: review and update the document, updating
`updated_at` (or committing changes in git), or configure `lifecycle.exempt` for archived paths.

```text
docs/a.md:7:15 MDL801 warning Document not updated in over 180 days (updated_at 2020-01-01T00:00:00Z)
```

## Reserved ranges

These ranges appear in the registry with codes assigned or reserved:

- **MDL5xx** — repository policy, including directory layout. MDL501 is assigned for layout rule violations.
- **MDL6xx (extension)** — extended line-ending hygiene. Encoding checks (BOM,
  non-UTF-8) are a named later addition to this block, with codes still
  pending.
- **MDL7xx** — fallback block for layout codes should MDL5xx crowd out other
  policy rules. No codes assigned.
- **MDL8xx** — lifecycle and freshness policy. MDL801 is assigned for document staleness.
- **MDL9xx** — configuration and internal state: unparseable
  `mdlineage.config.yaml`, a `schemaFile` that does not exist or fails to
  load, or validator-internal errors. Registry says codes are pending with
  severity defaulting to error, because integrity failures cannot be
  downgraded. In practice the current CLI and remark plugin already emit
  `MDL900` for config-schema failures, e.g.
  `mdlineage: MDL900 error Configuration .../mdlineage.config.yaml fails the config schema at /relations: ...`.
  Treat MDL900 as the de-facto first code of this range, but expect the
  registry to catch up before finer-grained 9xx codes are assigned.

## Auto-fix reference

`mdlineage fix` runs in dry-run by default; pass `--write` to apply. It only
handles categories that are safe to fix mechanically:

- **MDL102** — insert skeleton lines for missing fields, proposing the first
  legal value from the configured vocabulary; a relation's `reason` is the
  exception and gets the placeholder
  `TODO: explain this relationship (proposed by mdlineage)`.
- **MDL202** — delete exact in-document duplicate relations.
- **MDL103** — normalize a value only when it has a unique case-insensitive
  match in the vocabulary; ambiguous values are flagged on stderr for a human
  decision.
- **MDL601 / MDL602** — normalize the whole file's line endings to the
  configured policy.

Everything else is suggestion-only: changing an `id`, changing a relation's
`type`/`target`, adding strong relations, and deleting unknown fields whose
values are blocks are not auto-fixed, because the right answer requires
context the tool does not have. Example dry-run output:

```text
docs/eol.md:0: [line-endings] line endings normalized CRLF -> LF (MDL601)
docs/t1.md:4: [status] MDL102 requires 'status'; proposed from the configured vocabulary (first member of statuses).
mdlineage fix: would fix 3 issues in 13 files (dry run; use --write to apply)
```
