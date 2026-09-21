# Fixture contract tests

Machine-readable acceptance contract for the MDLineage validator (M0 deliverable).
Future validators (M1 `@mdlineage/validator`, the remark plugin, the CLI, the
dedicated LSP, the MCP server) must reproduce exactly the codes declared here —
`docs/remark-language-server-solution.md` §14.4 makes that a one-fixture,
many-entries consistency promise.

## Layout

```text
fixtures/
├── manifest.json        # one entry per fixture: path, valid, expectedCodes
├── README.md            # this file
├── valid/               # must produce zero diagnostics
├── invalid/             # produces at least one MDLxxx code
└── workspace/           # individually valid; exercises cross-file rules as a set
```

## manifest.json semantics

Each entry has:

| Key | Type | Meaning |
|---|---|---|
| `path` | string | Fixture path relative to `fixtureRoot` (`test/fixtures`). |
| `valid` | boolean | The intended outcome, not the current tool's output. `true` means the validator must report nothing for this file; `false` means it must report at least one code. |
| `expectedCodes` | string[] | Codes decidable from this single document. Empty means "no code at this layer" — not "uninteresting". |
| `layers` | string[] | Which rule layers the fixture targets. Useful because a fixture's `expectedCodes` only ever covers layers that run inside the unit under test. |
| `workspace` | boolean | Present and `true` only for fixtures that participate in cross-file rules. Such fixtures are validated against the whole `workspace/` set, never alone. |
| `description` | string | What the fixture pins, and why. |

Rules of the contract:

1. **Only single-document-decidable codes go in `expectedCodes`.** Front matter
   syntax (MDL001–MDL003) and JSON Schema (MDL101–MDL104) are always decidable.
   Single-document semantics (MDL201, MDL202) are also decidable from one file —
   they live in `invalid/` as schema-valid front matter whose code comes from the
   document-semantic layer. Only workspace semantics (MDL301, MDL302, MDL303,
   MDL305) and cross-file links/anchors (MDL401, MDL402) need more than one file,
   and those are carried by the `workspace/` set with `workspace: true`.
   Concretely: `workspace/` holds no document-semantic fixtures, and `invalid/`
   holds no cross-file fixtures.
2. **Line-ending codes are not schema codes.** MDL601/MDL602 come from the
   raw-buffer scan that runs before AST parsing
   (`docs/line-ending-management.md` §4.1). Their fixtures therefore have
   `expectedCodes: []` plus `layers: ["eol-scan"]`; a schema-only harness must
   accept them, and an EOL harness must flag them.
3. **`expectedCodes` is not exhaustive across layers.** `e09` carries
   `["MDL102"]` because the schema layer is what a schema harness runs; the
   workspace layer would add MDL304 for the same file. Likewise `e12` is
   `["MDL103"]` at the schema layer and would also carry MDL302 at the workspace
   layer. Layer-scoped harnesses take their slice; full-pipeline harnesses may
   see a superset, but the listed codes must always be present.
4. **Failing to parse is a valid outcome, not a broken fixture.** `e01` and
   `e02` have no extractable metadata; any harness must treat "no front matter
   object" as the expected result for MDL001/MDL002, not as a harness error.
5. **Fixture files are LF except the two EOL fixtures**, which deliberately
   contain CRLF bytes (`e16`) and a mix of LF and CRLF (`e15`). Git's
   `.gitattributes` (`* text=auto eol=lf`) normalizes blobs, so the CRLF
   survives on disk only because it is committed through the attributes path;
   do not "fix" those two files. A checkout on any platform keeps their bytes.
6. **Vocabulary values stay unconstrained.** All `kind`/`status`/`authority`
   values here come from the example vocabulary in
   `docs/remark-language-server-solution.md` §7.1. `mdlineage-v1.schema.json`
   only checks their type, so a harness must load the config's `vocabulary` to
   catch MDL103 enum violations.

## Coverage

Every initial code in `schemas/diagnostic-codes.json` that is decidable from a
single document has a fixture: MDL001, MDL002, MDL003, MDL101, MDL102, MDL103,
MDL104, MDL601, MDL602. MDL201 and MDL202 need document semantics (anchor
presence, duplicate relations) and are carried by `invalid/e10` (MDL202) and
`invalid/e17` (MDL201) — both are schema-valid front matter, which is exactly
why they belong in `invalid/` rather than `workspace/`: the code comes from the
single-document semantic layer, not from cross-file state. `workspace/` carries
only cross-file codes: MDL301 (`dup-id-a` + `dup-id-b`), MDL302 (`dup-id-b`),
MDL305 (`cycle-a` + `cycle-b`). MDL304's structural component is `e09`; its
semantic component is the workspace layer.

Deliberately uncovered codes:

- **MDL303** is reserved for M2: it can only fire under optional alias or path
  fallback resolution. Under the pure-id resolution that M0 contracts, MDL301
  guarantees id uniqueness and MDL303 is unreachable, so no fixture can pin it
  without first inventing that resolution mode.
- **MDL9xx** (config and internal-state failures) has no assigned code numbers
  yet — see the reserved ranges in `schemas/diagnostic-codes.json`. Fixtures for
  them land with the numbers, in the config-validation milestone.
- **MDL401** needs a Markdown link in the body pointing at a missing path; it is
  a body-scan code rather than a front-matter code, so it is deferred to the same
  link-scan milestone as MDL201/MDL402 body checks.

## Schema decisions recorded here (not in docs/)

Two red-team findings from the M0 review changed the contract; docs were left
untouched per the milestone constraint, so the rationale lives here.

1. **No `identity.pattern` in `mdlineage-config.schema.json`.** The v1 schema
   hard-codes the id/target pattern and the config used to allow a second
   writable pattern next to it. Two sources of truth drift apart silently, and
   each still looks authoritative when they disagree. `identity` was removed
   entirely; the only override path is a copy of `mdlineage-v1.schema.json`
   referenced by `schemaFile`, which is a single truth source by construction.
   The `identity:` block in the §7.1 example config is therefore stale as
   written and is ignored by the config schema (`additionalProperties: false` at
   the top level rejects it) — repositories copying that example must drop it.
2. **`evidence` accepts Unicode anchors.** The pattern is `^#\S+$`, not an ASCII
   character class, because GFM slug generation preserves letters outside ASCII:
   a heading `## 缓存有效期` produces the anchor `#缓存有效期`, and a schema
   that rejected it would contradict the Chinese-alias fixture `v01`. The loose
   pattern still rejects every malformed case the ASCII one did: a missing `#`
   (`e11` uses `cache-key`), an empty anchor, and interior whitespace. Validation
   of the anchor's *existence* is not a schema concern (MDL201/MDL402).

## Adding fixtures

Append to `manifest.json` (`fixtureRoot` stays `test/fixtures`), keep
`expectedCodes` minimal and layer-honest, and add a row here if you introduce a
new rule layer.

## EOL fixtures

`e15-mixed-eol.md` and `e16-crlf-eol.md` carry literal CRLF/mixed bytes and are
exempted from the repository's `text=auto eol=lf` policy via `-text` entries in
`.gitattributes`, so their bytes survive checkout on every platform.
