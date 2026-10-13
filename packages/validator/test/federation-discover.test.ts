/**
 * `init --discover-federations` pure helpers (Issue #4 Phase 3).
 *
 * These functions are filesystem-free: the CLI scans directories and hands the
 * candidates here, so scope assignment and proposal shaping are deterministic
 * and unit-testable without a temp tree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DISCOVERY_SKIP_DIRS,
  MAX_DISCOVER_UP_LEVELS,
  FEDERATION_SCOPE_PATTERN,
  RESERVED_SCOPES,
  slugifyScopeName,
  assignDiscoveryScopes,
  buildFederationProposal,
  renderFederationYaml,
} from '../src/index.js';

describe('slugifyScopeName', () => {
  it('lowercases and folds a plain directory name', () => {
    assert.equal(slugifyScopeName('SkillsRepo'), 'skillsrepo');
    assert.equal(slugifyScopeName('Skills Repo'), 'skills-repo');
  });

  it('replaces underscores, dots and other separators with a hyphen', () => {
    assert.equal(slugifyScopeName('my_repo.name'), 'my-repo-name');
  });

  it('strips accents (NFKD) before slugging', () => {
    assert.equal(slugifyScopeName('café-repo'), 'cafe-repo');
  });

  it('prefixes a leading digit with repo-', () => {
    assert.equal(slugifyScopeName('2024-notes'), 'repo-2024-notes');
    assert.ok(FEDERATION_SCOPE_PATTERN.test(slugifyScopeName('2024-notes')));
  });

  it('returns an empty string for a name with no ASCII alphanumerics', () => {
    assert.equal(slugifyScopeName('中文仓库'), '');
    assert.equal(slugifyScopeName('...'), '');
  });

  it('truncates to 32 characters', () => {
    const slug = slugifyScopeName('a'.repeat(60));
    assert.equal(slug.length, 32);
    assert.ok(FEDERATION_SCOPE_PATTERN.test(slug));
  });

  it('truncates a digit-prefixed name after adding the repo- prefix', () => {
    const slug = slugifyScopeName('9'.repeat(60));
    assert.ok(slug.length <= 32, `slug was ${slug}`);
    assert.ok(FEDERATION_SCOPE_PATTERN.test(slug));
  });

  it('is always pattern-valid or empty', () => {
    for (const name of ['SkillsRepo', '2024-notes', '--weird--', 'a_b.c', '中文']) {
      const slug = slugifyScopeName(name);
      assert.ok(slug === '' || FEDERATION_SCOPE_PATTERN.test(slug), `${name} -> ${slug}`);
    }
  });
});

describe('assignDiscoveryScopes', () => {
  it('avoids a taken scope name by numbering from 2', () => {
    const taken = new Set(['skills', 'skills-2']);
    const out = assignDiscoveryScopes([{ root: '/b/skills', basename: 'skills' }], taken);
    assert.deepEqual(out, [{ root: '/b/skills', scope: 'skills-3' }]);
  });

  it('avoids a reserved scope name (home)', () => {
    const taken = new Set([...RESERVED_SCOPES]);
    const out = assignDiscoveryScopes([{ root: '/b/home', basename: 'home' }], taken);
    assert.equal(out[0]!.scope, 'home-2');
  });

  it('falls back to repo for an unsluggable basename, then repo-2 on collision', () => {
    const out = assignDiscoveryScopes(
      [
        { root: '/x/中文', basename: '中文' },
        { root: '/y/符号', basename: '符号' },
      ],
      new Set<string>(),
    );
    assert.deepEqual(
      out.map((a) => a.scope),
      ['repo', 'repo-2'],
    );
  });

  it('is deterministic regardless of input order (sorted by root)', () => {
    const a = assignDiscoveryScopes(
      [
        { root: '/z/repo', basename: 'repo' },
        { root: '/a/repo', basename: 'repo' },
        { root: '/m/repo', basename: 'repo' },
      ],
      new Set<string>(),
    );
    const b = assignDiscoveryScopes(
      [
        { root: '/m/repo', basename: 'repo' },
        { root: '/z/repo', basename: 'repo' },
        { root: '/a/repo', basename: 'repo' },
      ],
      new Set<string>(),
    );
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.map((s) => s.scope),
      ['repo', 'repo-2', 'repo-3'],
    );
  });
});

describe('buildFederationProposal', () => {
  it('produces a readonly/warn entry with a POSIX relative localPath and alias', () => {
    const proposal = buildFederationProposal(
      '/work/home',
      [{ root: '/work/skills-repo', scope: 'skills-repo' }],
      new Set<string>(),
    );
    assert.deepEqual(proposal.skipped, []);
    assert.deepEqual(proposal.entries, [
      {
        scope: 'skills-repo',
        localPath: '../skills-repo',
        alias: 'skills-repo',
        trust: 'readonly',
        missing: 'warn',
        include: ['**/*.md'],
      },
    ]);
  });

  it('skips a candidate whose physical root is already declared', () => {
    const proposal = buildFederationProposal(
      '/work/home',
      [{ root: '/work/other', scope: 'other' }],
      new Set(['/work/other']),
    );
    assert.deepEqual(proposal.entries, []);
    assert.deepEqual(proposal.skipped, [{ root: '/work/other', scope: 'other', reason: 'already-declared' }]);
  });

  it('skips a candidate at or above the home root (empty alias)', () => {
    const proposal = buildFederationProposal(
      '/work/home',
      [{ root: '/work/home', scope: 'self' }],
      new Set<string>(),
    );
    assert.deepEqual(proposal.entries, []);
    assert.equal(proposal.skipped[0]!.reason, 'at-or-above-home');
  });

  it('renders a schema-valid federations block with 2-space indentation', () => {
    const proposal = buildFederationProposal(
      '/work/home',
      [{ root: '/work/skills-repo', scope: 'skills-repo' }],
      new Set<string>(),
    );
    const yaml = renderFederationYaml(proposal.entries);
    assert.equal(
      yaml,
      [
        'federations:',
        '  skills-repo:',
        '    local:',
        '      path: ../skills-repo',
        '    trust: readonly',
        '    missing: warn',
        '    include:',
        "      - '**/*.md'",
        '',
      ].join('\n'),
    );
  });

  it('renders nothing for an empty proposal', () => {
    assert.equal(renderFederationYaml([]), '');
  });
});

describe('discovery constants', () => {
  it('exposes the skip set and the depth ceiling', () => {
    for (const dir of ['.git', 'node_modules', 'dist', '__pycache__']) {
      assert.ok(DISCOVERY_SKIP_DIRS.has(dir), `${dir} must be skipped`);
    }
    assert.equal(MAX_DISCOVER_UP_LEVELS, 2);
  });
});
