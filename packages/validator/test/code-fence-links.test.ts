/**
 * MDL404 — code fence path awareness (Issue #5).
 *
 * Three layers, kept separate like the rest of the suite:
 *   - the line extractor (`extractPathTokens`) as a table: every whitelist
 *     head, every guard, every prompt form, one assertion per row;
 *   - the fence/document extractor and corpus resolver (`extractFenceLinks`,
 *     `resolveCorpusPath`): CRLF-safe positions, the cross-line `cd` breaker,
 *     language gating, escape detection;
 *   - the workspace rule end-to-end: the five real acceptance samples from the
 *     dc-skills audit, false-positive sentinels, the default-`off` guarantee,
 *     the config chain, baseline compatibility and incremental consistency.
 *
 * All fixtures are inline (rule 5 of the merged plan): no test/fixtures change,
 * no .mdlineage-baseline.json change.
 *
 * Run with: node --import tsx --test packages/validator/test/code-fence-links.test.ts
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig, configToSchema, validateConfigSchema, defaultConfigIsValid, loadConfig, resolveSeverity } from '../src/config.js';
import {
  SHELL_FENCE_LANGS,
  isCheckableFenceToken,
  extractPathTokens,
  extractFenceLinks,
  resolveCorpusPath,
} from '../src/code-fence-links.js';
import { createWorkspaceIndex, updateFile, removeFile } from '../src/workspace-index.js';
import { validateWorkspace } from '../src/workspace-validator.js';
import type { WorkspaceDiagnostic } from '../src/workspace-validator.js';
import { parseBaseline, writeBaseline, pruneBaseline } from '../src/baseline.js';
import type { Baseline } from '../src/baseline.js';
import { buildLineMap } from '../src/source-map.js';
import { parseMarkdownSync } from '../src/index.js';
import type { Config } from '../src/index.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/** The corpus configuration: `links.codeFences: 'corpus'` over the defaults. */
function corpusConfig(): Config {
  const base = defaultConfig();
  return { ...base, links: { ...base.links, codeFences: 'corpus' } };
}

/** A minimal valid document wrapping `body` (which may contain fences). */
function doc(id: string, body: string): string {
  return ['---', 'mdlineage:', '  schema: 1', `  id: ${id}`, '  kind: policy', '  status: active', '---', '', body, ''].join('\n');
}

/** A document whose body is one ```-fenced block with the given lines. */
function fenceDoc(id: string, lines: readonly string[], lang = 'bash'): string {
  return doc(id, ['```' + lang, ...lines, '```'].join('\n'));
}

function mdl404(all: readonly WorkspaceDiagnostic[]): WorkspaceDiagnostic[] {
  return all.filter((d) => d.code === 'MDL404');
}

function tokensOf(line: string, lang?: string): string[] {
  return (lang === undefined ? extractPathTokens(line) : extractPathTokens(line, lang)).map((t) => t.text);
}

describe('MDL404 extractor — command-head whitelist (table)', () => {
  it('uv run python <p> extracts the script path', () => {
    assert.deepEqual(tokensOf('uv run python scripts/a.py'), ['scripts/a.py']);
  });
  it('uv run python3 <p> extracts the script path', () => {
    assert.deepEqual(tokensOf('uv run python3 a/b.py'), ['a/b.py']);
  });
  it('uv run --directory <dir> python <p> skips to the interpreter slot', () => {
    assert.deepEqual(tokensOf('uv run --directory ~/x python scripts/a.py'), ['scripts/a.py']);
  });
  it('python <p> extracts with trailing flags intact', () => {
    assert.deepEqual(tokensOf('python tools/t.py --md x'), ['tools/t.py']);
  });
  it('bash <p> extracts the script path', () => {
    assert.deepEqual(tokensOf('bash scripts/run.sh'), ['scripts/run.sh']);
  });
  it('sh <p> extracts the script path', () => {
    assert.deepEqual(tokensOf('sh x/y.sh'), ['x/y.sh']);
  });
  it('source <p> without a separator is not a checkable path', () => {
    // `source env/bin/activate` — activate carries no `/`... the canonical
    // spelling does; the bare-token spelling the whitelist would see without
    // one is deliberately empty (predicate requires a path separator).
    assert.deepEqual(tokensOf('source activate'), []);
    assert.deepEqual(tokensOf('source env/bin/activate'), ['env/bin/activate']);
  });
  it('node <p> extracts the entry path', () => {
    assert.deepEqual(tokensOf('node ./bin/www'), ['./bin/www']);
  });
  it('a segment-initial ./command is a direct slot', () => {
    assert.deepEqual(tokensOf('./build.sh'), ['./build.sh']);
    assert.deepEqual(tokensOf('../tools/build.sh'), ['../tools/build.sh']);
  });
  it('a list of two whitelisted commands yields both paths', () => {
    assert.deepEqual(tokensOf('python a/x.py && node b/c.js'), ['a/x.py', 'b/c.js']);
  });
  it('cd <dir/> trips the breaker: later segments on the line are dropped', () => {
    assert.deepEqual(tokensOf('cd scripts/ && python sub/x.py'), ['scripts/']);
  });
  it('cd <bare dir> trips nothing: both slash-less tokens stay out', () => {
    assert.deepEqual(tokensOf('cd scripts && python tool.py'), []);
  });
});

describe('MDL404 extractor — guards and exclusions (table)', () => {
  it('python -m <module> is dropped (flag in the slot)', () => {
    assert.deepEqual(tokensOf('python -m pytest'), []);
  });
  it('node -r <pkg> app.js is dropped (flag value, not a path)', () => {
    assert.deepEqual(tokensOf('node -r ts-node/register app.js'), []);
  });
  it('node --inspect-brk=<port> dist/index.js is dropped', () => {
    assert.deepEqual(tokensOf('node --inspect-brk=9229 dist/index.js'), []);
  });
  it('a flag AFTER the path does not displace the slot', () => {
    assert.deepEqual(tokensOf('uv run python tools/x.py -v'), ['tools/x.py']);
  });
  it('a <placeholder> argument is not a path, the slot before it stays', () => {
    assert.deepEqual(tokensOf('python tools/x.py <input>'), ['tools/x.py']);
    assert.deepEqual(tokensOf('bash scripts/<name>.sh'), []);
  });
  it('unknown heads (cat) are dropped even with a glob', () => {
    assert.deepEqual(tokensOf('cat src/*.py'), []);
  });
  it('unknown heads (rm) are dropped', () => {
    assert.deepEqual(tokensOf('rm -rf venvs/marker/'), []);
  });
  it('the redirect target is truncated away, the path before it stays', () => {
    assert.deepEqual(tokensOf('python tools/a.py > scripts/out.log'), ['tools/a.py']);
    assert.deepEqual(tokensOf('python tools/a.py >> scripts/out.log'), ['tools/a.py']);
    assert.deepEqual(tokensOf('python tools/a.py 2> scripts/err.log'), ['tools/a.py']);
    assert.deepEqual(tokensOf('python tools/a.py &> scripts/all.log'), ['tools/a.py']);
  });
  it('a pipeline keeps only the whitelisted segment', () => {
    assert.deepEqual(tokensOf('python tools/a.py 2>&1 | tee scripts/tee.log'), ['tools/a.py']);
  });
  it('a trailing comment is truncated', () => {
    assert.deepEqual(tokensOf('echo hi # scripts/x.py'), []);
    assert.deepEqual(tokensOf('python tools/a.py --check # scripts/x.py is elsewhere'), ['tools/a.py']);
  });
  it('a whole-line comment is dropped — line-initial # is a comment in shell dialects, never a prompt', () => {
    assert.deepEqual(tokensOf('# scripts/x.py'), []);
    assert.deepEqual(tokensOf('  # scripts/x.py'), []);
    assert.deepEqual(tokensOf('# python scripts/x.py'), [], 'a whitelisted head after # stays a comment');
  });
  it('a host-absolute interpreter path is an unknown head, not a slot', () => {
    assert.deepEqual(tokensOf('/usr/bin/python3 x.py'), []);
  });
  it('home-relative tokens are excluded', () => {
    assert.deepEqual(tokensOf('~/tools/x.py'), []);
  });
  it('env-expanded tokens are excluded', () => {
    assert.deepEqual(tokensOf('$HOME/x'), []);
    assert.deepEqual(tokensOf('python $HOME/tools/x.py'), []);
  });
  it('URLs are excluded', () => {
    assert.deepEqual(tokensOf('https://x/y'), []);
    assert.deepEqual(tokensOf('python https://x/y.sh'), []);
  });
  it('a slash-less argument is not a corpus reference', () => {
    assert.deepEqual(tokensOf('python main.tex'), []);
  });
  it('unknown heads (xelatex) are dropped — missing-flag semantics stay out of scope', () => {
    assert.deepEqual(tokensOf('xelatex -interaction=nonstopmode main.tex'), []);
  });
  it('paired quotes are cleaned', () => {
    assert.deepEqual(tokensOf('python "scripts/a.py"'), ['scripts/a.py']);
    assert.deepEqual(tokensOf("python 'a/b.py',"), ['a/b.py']);
  });
  it('parenthesized prose is dropped', () => {
    assert.deepEqual(tokensOf('python (a/b.py)'), []);
  });
  it('a trailing background & is stripped from the token', () => {
    assert.deepEqual(tokensOf('python scripts/a.py&'), ['scripts/a.py']);
  });
  it('a second segment with a non-whitelisted head contributes nothing', () => {
    assert.deepEqual(tokensOf('a; b/c/d.py --x'), []);
  });
});

describe('MDL404 extractor — prompt forms (table)', () => {
  it('$ prompt is stripped', () => {
    assert.deepEqual(tokensOf('$ uv run python a/b.py'), ['a/b.py']);
  });
  it('console # root prompts are stripped; shell dialects treat a line-initial # as a comment', () => {
    assert.deepEqual(tokensOf('# apt install pkg'), [], 'bash/shell: whole-line comment');
    assert.deepEqual(tokensOf('# bash scripts/setup.sh'), [], 'bash/shell: whole-line comment, not a prompt');
    assert.deepEqual(tokensOf('# bash scripts/setup.sh', 'console'), ['scripts/setup.sh'], 'console: # is a root prompt');
  });
  it('PS> prompt is stripped', () => {
    assert.deepEqual(tokensOf('PS> python a/b.py'), ['a/b.py']);
  });
  it('> prompt is stripped before redirect truncation could eat the line', () => {
    // `cmd` is not a whitelisted head, so the result is empty — the assertion
    // pins that the PROMPT strip ran (a redirect-truncation misfire would also
    // be empty, but `# bash scripts/setup.sh` above proves stripping works).
    assert.deepEqual(tokensOf('> cmd ./x.sh'), []);
  });
});

describe('MDL404 extractor — column precision', () => {
  it('columns point at the token even after prompt and quote cleaning', () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['python a/b.py', 7],
      ['$ uv run python a/b.py', 16],
      ['PS> python a/b.py', 11],
      ['python "a/b.py"', 8],
      ["python 'a/b.py',", 8],
      ['  python a/b.py', 9],
      ['./build.sh', 0],
    ];
    for (const [line, column] of cases) {
      const extracted = extractPathTokens(line);
      if (extracted.length === 0) continue;
      assert.equal(extracted.length, 1, line);
      assert.equal(extracted[0]!.column, column, `column of the token in ${JSON.stringify(line)}`);
      assert.equal(line.slice(extracted[0]!.column).startsWith(extracted[0]!.text), true, line);
    }
    const cd = extractPathTokens('cd a/ && python b/c.py');
    assert.deepEqual(cd.map((t) => t.text), ['a/']);
    assert.equal(cd[0]!.column, 3);
  });
  it('the same token twice on one line keeps both occurrences apart', () => {
    const extracted = extractPathTokens('python a/x.py && bash a/x.py');
    assert.deepEqual(extracted.map((t) => t.text), ['a/x.py', 'a/x.py']);
    assert.equal(extracted[0]!.column, 7);
    assert.equal(extracted[1]!.column, 22);
  });
});

describe('MDL404 predicate', () => {
  it('accepts relative corpus shapes', () => {
    for (const token of ['a/b.py', './a/b.py', '../a/b.py', 'a/', 'x/y/z']) {
      assert.equal(isCheckableFenceToken(token), true, token);
    }
  });
  it('rejects host, home, env, URL, flag, glob and placeholder shapes', () => {
    for (const token of [
      '/usr/bin/x',
      '~/x',
      '$HOME/x',
      'http://x/y',
      'https://x/y',
      '-flag',
      'a*b',
      'a?b',
      'a<b>',
      'a[b]',
      'a:b',
      'a=b',
      'a b',
      'noslash',
    ]) {
      assert.equal(isCheckableFenceToken(token), false, token);
    }
  });
  it('SHELL_FENCE_LANGS is exactly the four shell info strings', () => {
    assert.deepEqual([...SHELL_FENCE_LANGS].sort(), ['bash', 'console', 'sh', 'shell']);
  });
});

describe('MDL404 — N1: line-initial # is a comment in bash/sh/shell, a prompt only in console', () => {
  it('a bash fence treats `# python scripts/a.py` as a comment and extracts nothing', () => {
    const content = fenceDoc('docs.hash', ['# python scripts/a.py']);
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks, []);
  });
  it('a console fence still reads `# python scripts/a.py` as a root prompt', () => {
    const content = fenceDoc('docs.hash', ['# python scripts/a.py'], 'console');
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks.map((f) => f.token), ['scripts/a.py']);
  });
  it('leading whitespace does not rescue `  # node tools/x.js` in a bash fence', () => {
    const content = fenceDoc('docs.hash', ['  # node tools/x.js']);
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks, []);
  });
});

describe('MDL404 fence extraction (extractFenceLinks)', () => {
  function fenceLinksOf(body: string, lang = 'bash'): readonly string[] {
    const content = fenceDoc('docs.fence', body.split('\n'), lang);
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    return index.entryOf('a.md')!.fenceLinks.map((f) => f.token);
  }

  it('a wavy ~~~bash fence is a shell fence', () => {
    const content = doc('docs.fence', ['~~~bash', 'python tools/a.py', '~~~'].join('\n'));
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks.map((f) => f.token), ['tools/a.py']);
  });
  it('the info string is case-insensitive and tolerates meta', () => {
    assert.deepEqual(fenceLinksOf('python tools/a.py', 'Bash'), ['tools/a.py']);
    assert.deepEqual(fenceLinksOf('python tools/a.py', 'bash title="setup"'), ['tools/a.py']);
  });
  it('non-shell languages are skipped: text, json, yaml, python', () => {
    assert.deepEqual(fenceLinksOf('venvs/marker/', 'text'), []);
    assert.deepEqual(fenceLinksOf('{"a": "b/c.json"}', 'json'), []);
    assert.deepEqual(fenceLinksOf('key: a/b.yaml', 'yaml'), []);
    assert.deepEqual(fenceLinksOf('import a/b.py', 'python'), []);
  });
  it('a bare fence (no language) and an indented block are skipped', () => {
    const bare = doc('docs.fence', ['```', 'python tools/a.py', '```'].join('\n'));
    const index = createWorkspaceIndex({ 'a.md': bare }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks, []);

    const indented = doc('docs.fence', ['    python tools/a.py'].join('\n'));
    const indentedIndex = createWorkspaceIndex({ 'a.md': indented }, corpusConfig());
    assert.deepEqual(indentedIndex.entryOf('a.md')!.fenceLinks, []);
  });
  it('a four-backtick bash fence keeps its inner ``` markers as content, not closers', () => {
    const content = doc('docs.fence', ['````bash', 'python tools/a.py', '```', 'bash scripts/b.sh', '````'].join('\n'));
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks.map((f) => f.token), ['tools/a.py', 'scripts/b.sh']);
  });
  it('an unterminated fence still yields its content lines', () => {
    const content = doc('docs.fence', ['```bash', 'python tools/a.py'].join('\n'));
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks.map((f) => f.token), ['tools/a.py']);
  });
  it('the cd breaker spans lines within a fence', () => {
    assert.deepEqual(fenceLinksOf(['cd scripts/', 'python sub/x.py'].join('\n')), ['scripts/']);
  });
  it('a slash-less cd does NOT break the fence', () => {
    assert.deepEqual(fenceLinksOf(['cd scripts', 'python sub/x.py'].join('\n')), ['sub/x.py']);
  });
  it('the breaker resets between fences of one document', () => {
    const content = doc('docs.fence', ['```bash', 'cd scripts/', '```', '', '```bash', 'python sub/x.py', '```'].join('\n'));
    const index = createWorkspaceIndex({ 'a.md': content }, corpusConfig());
    assert.deepEqual(index.entryOf('a.md')!.fenceLinks.map((f) => f.token), ['scripts/', 'sub/x.py']);
  });
  it('each occurrence is one entry, offsets in document coordinates', () => {
    const content = fenceDoc('docs.fence', ['python tools/a.py', 'bash scripts/b.sh']);
    const lineMap = buildLineMap(content);
    const tree = parseMarkdownSync(content.slice(content.indexOf('\n---\n') + 5));
    const bodyStart = content.indexOf('\n---\n') + 5;
    const links = extractFenceLinks(content, tree, bodyStart, lineMap);
    assert.deepEqual(links.map((l) => l.token), ['tools/a.py', 'scripts/b.sh']);
    for (const link of links) {
      assert.equal(content.slice(link.offset, link.offset + link.token.length), link.token, link.token);
    }
  });
  it('a null tree yields no entries and nothing throws', () => {
    assert.deepEqual(extractFenceLinks('```bash\npython a/b.py\n```', null, 0, buildLineMap('```bash\npython a/b.py\n```')), []);
  });
});

describe('MDL404 resolveCorpusPath', () => {
  it('resolves against the document directory first', () => {
    assert.equal(resolveCorpusPath('docs/a/b.md', 'sub/x.py'), 'docs/a/sub/x.py');
    assert.equal(resolveCorpusPath('docs/a/b.md', './sub/x.py'), 'docs/a/sub/x.py');
    assert.equal(resolveCorpusPath('docs/a/b.md', '../c.py'), 'docs/c.py');
  });
  it('a root document resolves corpus-relative directly', () => {
    assert.equal(resolveCorpusPath('SKILL.md', 'scripts/a.py'), 'scripts/a.py');
  });
  it('folding onto the corpus root is the empty path, not an escape', () => {
    assert.equal(resolveCorpusPath('a.md', './'), '');
    assert.equal(resolveCorpusPath('docs/a.md', '..'), '');
    assert.equal(resolveCorpusPath('docs/a.md', 'docs/..'), 'docs');
  });
  it('a .. over-pop escapes the corpus root and returns null', () => {
    assert.equal(resolveCorpusPath('docs/a.md', '../../escape.py'), null);
    assert.equal(resolveCorpusPath('a.md', '../escape.py'), null);
  });
  it('matches normalizeRelative byte-for-byte on every non-escaping input', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['docs/a.md', 'b.md'],
      ['docs/a.md', './b.md'],
      ['docs/a/b.md', '../c/d.md'],
      ['docs/a/b.md', './c/../d.md'],
      ['docs/a/b.md', 'x/./y/z.md'],
      ['a.md', 'q/r/s.md'],
    ];
    for (const [fromPath, token] of cases) {
      const slash = fromPath.lastIndexOf('/');
      const dir = slash >= 0 ? fromPath.slice(0, slash + 1) : '';
      const expected = (dir + token.replace(/^\.[\\/]/, '')).split('/').reduce<string[]>((out, part) => {
        if (part === '' || part === '.') return out;
        if (part === '..') {
          out.pop();
          return out;
        }
        out.push(part);
        return out;
      }, []).join('/');
      assert.equal(resolveCorpusPath(fromPath, token), expected, `${fromPath} + ${token}`);
    }
  });
  it('federated scoped coordinates fold inside the member namespace', () => {
    assert.equal(resolveCorpusPath('@scope//docs/x.md', 'lib/m.py'), '@scope//docs/lib/m.py');
    assert.equal(resolveCorpusPath('@scope//docs/x.md', '../lib/m.py'), '@scope//lib/m.py');
    assert.equal(resolveCorpusPath('@scope//docs/x.md', '../../escape.py'), null);
  });
});

describe('MDL404 — the five real acceptance samples (dc-skills audit)', () => {
  it('sample 1: a deleted script inside a uv run fence reports exactly once, on the token', () => {
    const content = fenceDoc('docs.skill', ['uv run python unified-search/scripts/probe_sources2.py nobracket']);
    const index = createWorkspaceIndex({ 'SKILL.md': content }, corpusConfig());
    const all = mdl404(validateWorkspace(index, { includeSingleDocument: false }));
    assert.equal(all.length, 1);
    const d = all[0]!;
    assert.equal(d.path, 'SKILL.md');
    assert.equal(d.data?.token, 'unified-search/scripts/probe_sources2.py');
    assert.equal(d.severity, 'warning');
    assert.equal(d.layer, 'link');
    // The range lands on the fence line, spanning exactly the token.
    const tokenAt = content.indexOf('unified-search/scripts/probe_sources2.py');
    assert.equal(content.slice(d.range.start.offset, d.range.end.offset), 'unified-search/scripts/probe_sources2.py');
    assert.equal(d.range.start.offset, tokenAt);
  });

  it('sample 2a: a wrong root-relative spelling at the corpus root reports', () => {
    const content = fenceDoc('docs.mysql', ['uv run python scripts/mysql_tool.py']);
    const index = createWorkspaceIndex({ 'SKILL.md': content }, corpusConfig(), ['db-skill/scripts/mysql_tool.py']);
    const all = mdl404(validateWorkspace(index, { includeSingleDocument: false }));
    assert.equal(all.length, 1, 'doc-relative AND root-relative both miss at the root');
    assert.equal(all[0]!.data?.token, 'scripts/mysql_tool.py');
  });

  it('sample 2b: the same fence inside db-skill/ resolves document-relatively and stays silent', () => {
    const content = fenceDoc('docs.mysql', ['uv run python scripts/mysql_tool.py']);
    const index = createWorkspaceIndex({ 'db-skill/SKILL.md': content }, corpusConfig(), ['db-skill/scripts/mysql_tool.py']);
    const all = mdl404(validateWorkspace(index, { includeSingleDocument: false }));
    assert.equal(all.length, 0, 'document-directory resolution hits db-skill/scripts/mysql_tool.py');
  });

  it('sample 3: a command with a placeholder argument is out of scope', () => {
    const content = fenceDoc('docs.spec', ['python check_markdown_spec.py <论文文件>']);
    const index = createWorkspaceIndex({ 'SKILL.md': content }, corpusConfig());
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);
  });

  it('sample 4: a bare file name under an unknown head is not a corpus reference', () => {
    const content = fenceDoc('docs.tex', ['xelatex -interaction=nonstopmode main.tex']);
    const index = createWorkspaceIndex({ 'SKILL.md': content }, corpusConfig());
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);
  });

  it('sample 5: a tree-diagram fence (non-shell language) is never read', () => {
    const content = fenceDoc('docs.tree', ['venvs/marker/', '└── data/'], 'text');
    const index = createWorkspaceIndex({ 'SKILL.md': content }, corpusConfig());
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);
  });
});

describe('MDL404 — false-positive sentinels (corpus config, integration)', () => {
  function sentinel(body: string, knownPaths?: readonly string[]): WorkspaceDiagnostic[] {
    const index = createWorkspaceIndex({ 'SKILL.md': fenceDoc('docs.s', body.split('\n')) }, corpusConfig(), knownPaths);
    return mdl404(validateWorkspace(index, { includeSingleDocument: false }));
  }

  it('env-expanded, host-absolute and home-relative forms report nothing', () => {
    assert.equal(sentinel('$HOME/x').length, 0);
    assert.equal(sentinel('/usr/local/bin/x').length, 0);
    assert.equal(sentinel('~/x').length, 0);
    assert.equal(sentinel('python $HOME/tools/x.py').length, 0);
  });
  it('URLs, placeholders, globs and flag values report nothing', () => {
    assert.equal(sentinel('python https://example.com/x.sh').length, 0);
    assert.equal(sentinel('bash scripts/<name>.sh').length, 0);
    assert.equal(sentinel('bash scripts/*.sh').length, 0);
    assert.equal(sentinel('node -r ts-node/register app.js').length, 0);
    assert.equal(sentinel('python --flag=value').length, 0);
  });
  it('redirect and pipeline residue is never a reference', () => {
    // The pre-redirect path exists, so the ONLY possible report would come
    // from the redirect/pipe target — its absence is the assertion.
    assert.equal(sentinel('python tools/a.py > scripts/out.log', ['tools/a.py']).length, 0);
    assert.equal(sentinel('python tools/a.py >> scripts/out.log', ['tools/a.py']).length, 0);
    assert.equal(sentinel('python tools/a.py 2>&1 | tee scripts/tee.log', ['tools/a.py']).length, 0);
  });
  it('a corpus escape is MDL403 jurisdiction, not a missing file', () => {
    const content = doc('docs.escape', ['```bash', 'python ../../escape.py', '```'].join('\n'));
    const index = createWorkspaceIndex({ 'docs/a.md': content }, corpusConfig());
    assert.equal(resolveCorpusPath('docs/a.md', '../../escape.py'), null);
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);
  });
  it('module syntax and slash-less names report nothing', () => {
    assert.equal(sentinel('python -m module.name').length, 0);
    assert.equal(sentinel('python main.tex').length, 0);
  });
  it('an existing directory token with both spellings reports nothing', () => {
    assert.equal(sentinel('bash scripts/', ['scripts', 'scripts/']).length, 0);
    assert.equal(sentinel('bash scripts', ['scripts', 'scripts/']).length, 0);
  });
  it('a known non-Markdown file resolves and reports nothing', () => {
    assert.equal(sentinel('bash scripts/run.sh', ['scripts/run.sh']).length, 0);
  });
  it('a fence naming an indexed document reports nothing', () => {
    const index = createWorkspaceIndex(
      new Map<string, string>([
        ['SKILL.md', fenceDoc('docs.s', ['python tools/a.py'])],
        ['tools/a.py', '#!python\n'],
      ]),
      corpusConfig(),
    );
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);
  });
});

describe('MDL404 — position precision (front matter + CRLF)', () => {
  const body = ['```bash', 'set -e', 'python tools/a.py --check', 'bash scripts/b.sh', '```'].join('\n');
  const frontMatter = ['---', 'mdlineage:', '  schema: 1', '  id: docs.pos', '  kind: policy', '  status: active', '---'].join('\n');

  it('six front-matter lines shift the fence tokens onto their true lines (LF)', () => {
    const content = frontMatter + '\n\n' + body + '\n';
    const index = createWorkspaceIndex({ 'docs/pos.md': content }, corpusConfig());
    const all = mdl404(validateWorkspace(index, { includeSingleDocument: true }));
    // tools/a.py does not exist in the tiny index; both fence paths report.
    assert.equal(all.length, 2);
    const first = all.find((d) => d.data?.token === 'tools/a.py')!;
    const second = all.find((d) => d.data?.token === 'scripts/b.sh')!;
    // Lines: 1-7 front matter, 8 blank, 9 fence open, 10 set -e, 11 python…, 12 bash…, 13 close.
    assert.equal(first.range.start.line, 11);
    assert.equal(first.range.start.column, 8);
    assert.equal(first.range.start.offset, content.indexOf('tools/a.py'));
    assert.equal(content.slice(first.range.start.offset, first.range.end.offset), 'tools/a.py');
    assert.equal(second.range.start.line, 12);
    assert.equal(second.range.start.column, 6);
    assert.equal(second.range.start.offset, content.indexOf('scripts/b.sh'));
  });

  it('CRLF documents keep the same lines and columns, offsets track the raw bytes', () => {
    const content = (frontMatter + '\n\n' + body + '\n').replace(/\n/g, '\r\n');
    const index = createWorkspaceIndex({ 'docs/pos.md': content }, corpusConfig());
    const all = mdl404(validateWorkspace(index, { includeSingleDocument: true }));
    assert.equal(all.length, 2);
    const first = all.find((d) => d.data?.token === 'tools/a.py')!;
    assert.equal(first.range.start.line, 11);
    assert.equal(first.range.start.column, 8);
    assert.equal(first.range.start.offset, content.indexOf('tools/a.py'));
    assert.equal(content.slice(first.range.start.offset, first.range.end.offset), 'tools/a.py');
  });

  it('extractFenceLinks agrees with the workspace rule on the same content', () => {
    const content = frontMatter + '\n\n' + body + '\n';
    const lineMap = buildLineMap(content);
    const bodyStart = content.indexOf('\n---\n') + 5;
    const tree = parseMarkdownSync(content.slice(bodyStart));
    const links = extractFenceLinks(content, tree, bodyStart, lineMap);
    assert.deepEqual(
      links.map((l) => l.token),
      ['tools/a.py', 'scripts/b.sh'],
    );
    for (const link of links) {
      assert.equal(content.slice(link.offset, link.offset + link.token.length), link.token);
    }
  });
});

describe('MDL404 — default off is a byte-identical no-op', () => {
  it('defaultConfig().links.codeFences is off', () => {
    assert.equal(defaultConfig().links.codeFences, 'off');
  });
  it('every corpus scenario reports zero MDL404 under the defaults', () => {
    const scenarios: ReadonlyArray<readonly [string, string]> = [
      ['SKILL.md', fenceDoc('docs.s1', ['uv run python unified-search/scripts/probe_sources2.py nobracket'])],
      ['docs/a.md', doc('docs.s2', ['```bash', 'python ../../escape.py', '```'].join('\n'))],
      ['docs/b.md', fenceDoc('docs.s3', ['cd scripts/', 'python sub/x.py'])],
    ];
    const index = createWorkspaceIndex(new Map(scenarios), defaultConfig());
    assert.equal(mdl404(validateWorkspace(index)).length, 0);
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);
  });
  it('extraction still happens at index time (config-independent entries)', () => {
    const index = createWorkspaceIndex({ 'SKILL.md': fenceDoc('docs.s', ['python tools/a.py']) }, defaultConfig());
    assert.deepEqual(index.entryOf('SKILL.md')!.fenceLinks.map((f) => f.token), ['tools/a.py']);
  });
});

describe('MDL404 — config chain', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mdl404-config-'));
  const write = (name: string, yaml: string): string => {
    const p = join(tmp, name);
    writeFileSync(p, yaml, 'utf8');
    return p;
  };

  it('a config without a links block keeps the off default', () => {
    const loaded = loadConfig(write('absent.yaml', 'configVersion: 1\n'));
    assert.equal(loaded.diagnostics.length, 0);
    assert.equal(loaded.config.links.codeFences, 'off');
  });
  it('links.codeFences: corpus loads and round-trips through the schema', () => {
    const loaded = loadConfig(write('corpus.yaml', 'configVersion: 1\nlinks:\n  codeFences: corpus\n'));
    assert.equal(loaded.diagnostics.length, 0);
    assert.equal(loaded.config.links.codeFences, 'corpus');
    assert.equal(validateConfigSchema(configToSchema(loaded.config)), true, 'configToSchema projection is schema-valid');
  });
  it('links.codeFences: all is rejected with MDL900 and falls back to off', () => {
    const loaded = loadConfig(write('all.yaml', 'configVersion: 1\nlinks:\n  codeFences: all\n'));
    assert.ok(loaded.diagnostics.some((d) => d.code === 'MDL900'), 'all is not a legal value');
    assert.equal(loaded.config.links.codeFences, 'off', 'defaults apply after the refusal');
  });
  it('configToSchema(defaultConfig()) carries codeFences and validates', () => {
    const projection = configToSchema(defaultConfig()) as { links: { codeFences: string } };
    assert.equal(projection.links.codeFences, 'off');
    assert.equal(validateConfigSchema(projection), true);
    assert.equal(defaultConfigIsValid(), true, 'the built-in defaults still validate against the schema');
  });
  it('an end-to-end severity override lifts MDL404 to error', () => {
    const loaded = loadConfig(
      write('override.yaml', 'configVersion: 1\nlinks:\n  codeFences: corpus\ndiagnostics:\n  MDL404: error\n'),
    );
    assert.equal(loaded.diagnostics.length, 0);
    assert.equal(resolveSeverity(loaded.config, 'MDL404'), 'error');
    const index = createWorkspaceIndex(
      { 'SKILL.md': fenceDoc('docs.s', ['python tools/a.py']) },
      loaded.config,
    );
    const all = mdl404(validateWorkspace(index, { includeSingleDocument: false }));
    assert.equal(all.length, 1);
    assert.equal(all[0]!.severity, 'error');
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('MDL404 — baseline compatibility', () => {
  function indexed(): { index: ReturnType<typeof createWorkspaceIndex>; files: Map<string, string> } {
    const files = new Map<string, string>([
      ['SKILL.md', fenceDoc('docs.skill', ['python unified-search/scripts/probe_sources2.py'])],
    ]);
    return { index: createWorkspaceIndex(files, corpusConfig()), files };
  }

  it('a corpus MDL404 is accepted by writeBaseline and silenced on re-validation', () => {
    const { index } = indexed();
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(mdl404(all).length, 1);
    const baseline = JSON.parse(writeBaseline(all)) as Baseline;
    assert.deepEqual(baseline.codes.MDL404, ['SKILL.md']);
    const suppressed = validateWorkspace(index, { includeSingleDocument: false, baseline });
    assert.equal(mdl404(suppressed).length, 0);
    assert.equal(suppressed.length, 0, 'a fully covered report is clean for CI');
  });

  it('fixing the target makes the entry stale and pruneBaseline clears it', () => {
    const { index, files } = indexed();
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const baseline = JSON.parse(writeBaseline(all)) as Baseline;
    updateFile(index, 'unified-search/scripts/probe_sources2.py', '#!/usr/bin/env python3\nprint("rebuilt")\n');
    files.set('unified-search/scripts/probe_sources2.py', '#!/usr/bin/env python3\nprint("rebuilt")\n');
    const fixed = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(mdl404(fixed).length, 0);
    const pruned = pruneBaseline(baseline, fixed);
    assert.equal(pruned.codes.MDL404, undefined, 'a stale entry is removed');
    // And the round-trip still parses.
    assert.equal(parseBaseline(writeBaseline(fixed, pruned)).error, null);
  });
});

describe('MDL404 — incremental consistency', () => {
  const FENCE = fenceDoc('docs.fence', ['python docs/target.py']);
  const TARGET = '#!/usr/bin/env python3\n';

  it('(a) deleting the fence target puts the fence document in the affected set', () => {
    const files = new Map<string, string>([
      ['a.md', FENCE],
      ['docs/target.py', TARGET],
    ]);
    const index = createWorkspaceIndex(files, corpusConfig());
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 0);

    const { affected } = removeFile(index, 'docs/target.py');
    assert.ok(affected.has('a.md'), 'the fence referrer must be re-validated');
    const scoped = validateWorkspace(index, { includeSingleDocument: false, paths: [...affected] });
    assert.equal(mdl404(scoped).length, 1);
    assert.equal(mdl404(scoped)[0]!.path, 'a.md');
    // Incremental == full rebuild.
    const rebuilt = createWorkspaceIndex(new Map([...files].filter(([p]) => p !== 'docs/target.py')), corpusConfig());
    assert.deepEqual(
      validateWorkspace(index, { includeSingleDocument: false }).map((d) => [d.path, d.code, d.range.start.offset]),
      validateWorkspace(rebuilt, { includeSingleDocument: false }).map((d) => [d.path, d.code, d.range.start.offset]),
    );
  });

  it('(b) creating the missing target clears the diagnostic, equal to a rebuild', () => {
    const files = new Map<string, string>([['a.md', FENCE]]);
    const index = createWorkspaceIndex(files, corpusConfig());
    assert.equal(mdl404(validateWorkspace(index, { includeSingleDocument: false })).length, 1);

    updateFile(index, 'docs/target.py', TARGET);
    files.set('docs/target.py', TARGET);
    const after = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(mdl404(after).length, 0, 'the fence target now resolves');
    const rebuilt = createWorkspaceIndex(files, corpusConfig());
    assert.deepEqual(
      after.map((d) => [d.path, d.code, d.range.start.offset]),
      validateWorkspace(rebuilt, { includeSingleDocument: false }).map((d) => [d.path, d.code, d.range.start.offset]),
      'post-update report equals a full rebuild',
    );
  });
});
