// .remarkrc.mjs — remark configuration (docs/remark-language-server-solution.md §6.2).
//
// This file is the adapter configuration only. The authoritative MDLineage
// rules live in the transport-independent @mdlineage/validator and, when a
// repository needs overrides, in the non-executable mdlineage.config.yaml.
// This repo ships no mdlineage.config.yaml: the validator defaults already
// pass schemas/mdlineage-config.schema.json.

import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkPresetLintRecommended from 'remark-preset-lint-recommended'
import remarkLintMdlineage from '@mdlineage/remark-lint-mdlineage'

export default {
  plugins: [
    remarkGfm,
    // ['yaml'] keeps the front matter inside `file.value` and exposes it as a
    // `yaml` node; the MDLineage rule reads the raw buffer from the VFile, so
    // unsaved buffers are validated instead of the disk copy (§6.3).
    [remarkFrontmatter, ['yaml']],
    remarkPresetLintRecommended,
    [remarkLintMdlineage, { configFile: './mdlineage.config.yaml' }],
    // unified-lint-rule overwrites `fatal` on every message its rules emit,
    // demoting error-level MDL codes to warnings; this transformer restores
    // the severities from message.data.mdlSeverity. It only owns this rule's
    // messages, so later presets cannot flip them back (verified by review).
    remarkLintMdlineage.restoreSeverity
  ]
}
