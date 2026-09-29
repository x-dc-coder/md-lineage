/**
 * Tests for PathFilter: built-in exclusions, negation rules, literal includes, and hard-pruning.
 *
 * Run with: node --import tsx --test packages/validator/test/path-filter.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_EXCLUDE_GLOBS,
  compileRules,
  excludedByRules,
  isLiteralPath,
  PathFilter,
  defaultConfig,
  type Config,
} from '../src/index.js';

describe('PathFilter — rule compilation and pattern matching', () => {
  it('detects literal paths correctly', () => {
    assert.equal(isLiteralPath('archive/important.md'), true);
    assert.equal(isLiteralPath('docs/guide.md'), true);
    assert.equal(isLiteralPath('**/*.md'), false);
    assert.equal(isLiteralPath('docs/*.md'), false);
    assert.equal(isLiteralPath('src/{a,b}.ts'), false);
    assert.equal(isLiteralPath('test/?/foo.md'), false);
    assert.equal(isLiteralPath('dir/[a-z]/bar.md'), false);
  });

  it('compiles rules with built-ins and negation tags', () => {
    const rules = compileRules(BUILTIN_EXCLUDE_GLOBS, ['archive/**', '!archive/important.md']);
    assert.equal(rules.length, 5);
    assert.equal(rules[0]!.pattern, '**/node_modules/**');
    assert.equal(rules[0]!.negate, false);
    assert.equal(rules[3]!.pattern, 'archive/**');
    assert.equal(rules[3]!.negate, false);
    assert.equal(rules[4]!.pattern, 'archive/important.md');
    assert.equal(rules[4]!.negate, true);
  });

  it('evaluates rules using last-match-wins', () => {
    const rules = compileRules(['archive/**', '!archive/important.md', 'archive/important.md']);
    // last rule is positive for archive/important.md -> excluded
    assert.equal(excludedByRules('archive/important.md', rules), true);

    const rules2 = compileRules(['archive/**', 'archive/important.md', '!archive/important.md']);
    // last rule is negated -> not excluded
    assert.equal(excludedByRules('archive/important.md', rules2), false);
    assert.equal(excludedByRules('archive/other.md', rules2), true);
  });
});

describe('PathFilter — built-in exclusions', () => {
  it('excludes node_modules, dist, and vendor by default', () => {
    const filter = new PathFilter();
    assert.equal(filter.inUniverse('node_modules/pkg/README.md'), false);
    assert.equal(filter.inUniverse('dist/bundle.js'), false);
    assert.equal(filter.inUniverse('vendor/lib/index.js'), false);
    assert.equal(filter.inUniverse('sub/node_modules/pkg/a.md'), false);

    assert.equal(filter.inReportSet('node_modules/pkg/README.md'), false);
    assert.equal(filter.inReportSet('dist/bundle.md'), false);
    assert.equal(filter.inReportSet('docs/guide.md'), true);
  });
});

describe('PathFilter — negation pull-back rules (! prefix)', () => {
  it('pulls back negated paths via CLI extraExclude', () => {
    const filter = new PathFilter({
      extraExclude: ['archive/**', '!archive/important.md'],
    });

    assert.equal(filter.inReportSet('archive/other.md'), false);
    assert.equal(filter.inReportSet('archive/important.md'), true);
    assert.equal(filter.inUniverse('archive/important.md'), true);
  });
});

describe('PathFilter — literal include whitelist pull-back', () => {
  it('pulls back literal include paths even when matched by exclude rules', () => {
    const base = defaultConfig();
    const config: Config = {
      ...base,
      files: {
        include: ['archive/important.md'],
        exclude: ['archive/**', ...BUILTIN_EXCLUDE_GLOBS],
      },
    };

    const filter = new PathFilter({ config });

    assert.equal(filter.isLiteralInclude('archive/important.md'), true);
    assert.equal(filter.isLiteralInclude('archive/other.md'), false);

    // Whitelist takes top priority
    assert.equal(filter.inUniverse('archive/important.md'), true);
    assert.equal(filter.inReportSet('archive/important.md'), true);

    assert.equal(filter.inUniverse('archive/other.md'), false);
    assert.equal(filter.inReportSet('archive/other.md'), false);
  });
});

describe('PathFilter — hard pruning logic', () => {
  it('hard-prunes exclude patterns when there are no conflicting negation or literal include rules', () => {
    const base = defaultConfig();
    const filter = new PathFilter({
      config: base,
      extraExclude: ['temp/**'],
    });

    const prune = filter.hardPrunePatterns();
    assert.ok(prune.includes('**/node_modules/**'));
    assert.ok(prune.includes('**/dist/**'));
    assert.ok(prune.includes('**/vendor/**'));
    assert.ok(prune.includes('temp/**'));
  });

  it('does NOT hard-prune patterns that conflict with negation rules', () => {
    const filter = new PathFilter({
      extraExclude: ['archive/**', '!archive/important.md'],
    });

    const prune = filter.hardPrunePatterns();
    assert.ok(!prune.includes('archive/**'), 'archive/** should not be hard-pruned due to negation conflict');
    assert.ok(prune.includes('**/node_modules/**'));
  });

  it('does NOT hard-prune patterns that conflict with literal includes', () => {
    const base = defaultConfig();
    const config: Config = {
      ...base,
      files: {
        include: ['archive/important.md'],
        exclude: ['archive/**', ...BUILTIN_EXCLUDE_GLOBS],
      },
    };

    const filter = new PathFilter({ config });
    const prune = filter.hardPrunePatterns();
    assert.ok(!prune.includes('archive/**'), 'archive/** should not be hard-pruned due to literal include conflict');
    assert.ok(prune.includes('**/node_modules/**'));
  });
});

describe('PathFilter — M1 matrix: ../ prefix paths', () => {
  it('default **/*.md accepts ../other_repo/docs/a.md, rejects ../other_repo node_modules and vendor', () => {
    const filter = new PathFilter({ config: defaultConfig() });
    assert.equal(filter.inReportSet('../other_repo/docs/a.md'), true);
    assert.equal(filter.inReportSet('../other_repo/node_modules/pkg/a.md'), false);
    assert.equal(filter.inReportSet('../other_repo/vendor/a.md'), false);
  });

  it('include narrowed to docs/** rejects ../other_repo/docs/a.md but accepts ../docs/a.md', () => {
    const base = defaultConfig();
    const config: Config = {
      ...base,
      files: {
        ...base.files,
        include: ['docs/**'],
      },
    };
    const filter = new PathFilter({ config });
    assert.equal(filter.inReportSet('../other_repo/docs/a.md'), false);
    assert.equal(filter.inReportSet('../docs/a.md'), true);
  });

  it('exclude skip/** rejects ../skip/a.md', () => {
    const base = defaultConfig();
    const config: Config = {
      ...base,
      files: {
        include: ['**/*.md'],
        exclude: ['skip/**', ...BUILTIN_EXCLUDE_GLOBS],
      },
    };
    const filter = new PathFilter({ config });
    assert.equal(filter.inReportSet('../skip/a.md'), false);
  });
});
