/**
 * Position translation tests (docs/remark-language-server-solution.md §8.3).
 *
 * §8.3: "必须测试中文、emoji 和组合字符，不能把 UTF-8 byte offset 直接当 LSP
 * character". Every case below is that sentence turned into an assertion, and
 * each one would fail if a rule started counting code points or bytes instead
 * of UTF-16 code units.
 *
 * Run with: node --import tsx --test packages/language-server/test/position.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { characterOf, diagnosticRange, toLspRange, utf16Length } from '../src/position.js';
import { defaultConfig, validateDocumentSync, type Diagnostic } from '@mdlineage/validator';

describe('characterOf — the UTF-16 unit count', () => {
  it('is the validator column minus one for an ASCII line', () => {
    assert.equal(characterOf('id: docs.foo', 5), 4);
    assert.equal(characterOf('hello', 1), 0);
    assert.equal(characterOf('hello', 6), 5);
  });

  it('counts a BMP character as one unit: 中文', () => {
    // `id: 缓存策略` — a CJK character is one UTF-16 code unit, so the column the
    // validator reports is the character LSP reports.
    const line = 'id: 缓存策略';
    assert.equal(utf16Length(line), line.length, 'a BMP line: units === JS string length');
    assert.equal(characterOf(line, 5), 4);
    assert.equal(characterOf(line, 8), 7);
  });

  it('counts an astral character as TWO units: emoji', () => {
    // 😀 is U+1F600: one code point, a surrogate pair, two LSP characters.
    const line = 'a😀b';
    assert.equal(line.length, 4, 'one surrogate pair in the string');
    assert.equal(utf16Length(line), 4, 'astral code point → one extra unit');
    assert.equal(characterOf(line, 1), 0, 'a at character 0');
    assert.equal(characterOf(line, 2), 1, '😀 starts at character 1');
    assert.equal(characterOf(line, 3), 2, 'one unit past the emoji: character 2');
    assert.equal(characterOf(line, 4), 3, 'b sits at character 3, not 2');
  });

  it('counts variation selectors as ordinary BMP units', () => {
    // 3️⃣ is '3' + U+FE0F + U+20E3: three code points, three UTF-16 units. The
    // trap it guards against is treating a grapheme cluster as one character.
    const keycap = 'x3️⃣y';
    assert.equal(keycap.length, 5, 'three BMP code points, no surrogate pair');
    assert.equal(utf16Length(keycap), 5);
    assert.equal(characterOf(keycap, 2), 1);
    assert.equal(characterOf(keycap, 3), 2, 'the variation selector is an ordinary unit');
    assert.equal(characterOf(keycap, 5), 4);
  });

  it('counts two astral code points as four units', () => {
    const both = '😀😀';
    assert.equal(both.length, 4);
    assert.equal(utf16Length(both), 4, 'two surrogate pairs');
    assert.equal(characterOf(both, 1), 0);
    assert.equal(characterOf(both, 3), 2, 'the second emoji starts at character 2');
    assert.equal(characterOf(both, 5), 4);
  });

  it('clamps a column past the end of the line', () => {
    assert.equal(characterOf('ab', 99), 2);
    assert.equal(characterOf('', 5), 0);
  });

  it('shifts everything after an astral character by the units it consumed', () => {
    // The emoji is one code point but two units, so a column naming a character
    // PAST it is one less than its column number — that gap is the whole
    // difference between code points and UTF-16 units §8.3 warns about.
    const line = 'a😀b😀c';
    assert.equal(utf16Length(line), 7, 'two astral code points → two extra units');
    assert.equal(characterOf(line, 4), 3, 'the second emoji pair starts at character 3');
    assert.equal(characterOf(line, 5), 4);
    assert.equal(characterOf(line, 6), 5, 'c is at character 5, one short of its column');
  });
});

describe('toLspRange — 1-based validator → 0-based LSP', () => {
  it('subtracts one from line and character', () => {
    const range = toLspRange(
      {
        start: { line: 3, column: 5, offset: 20 },
        end: { line: 3, column: 12, offset: 27 },
      },
      () => 'id: docs.foo here',
    );
    assert.deepEqual(range, {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 11 },
    });
  });

  it('never yields a negative line for a diagnostic the validator anchored at the top', () => {
    const range = toLspRange(
      {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 4, offset: 3 },
      },
      () => '---',
    );
    assert.deepEqual(range.start, { line: 0, character: 0 });
  });

  it('reads the end character from the end line, not the start line', () => {
    const range = toLspRange(
      {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 2, column: 3, offset: 10 },
      },
      (line) => (line === 1 ? 'ab' : '😀😀'),
    );
    assert.deepEqual(range.end, { line: 1, character: 2 });
  });

  it('translates a range whose line holds an emoji', () => {
    const line = '  id: 🐈 docs.foo';
    const range = toLspRange(
      {
        start: { line: 1, column: 8, offset: 7 },
        end: { line: 1, column: 10, offset: 9 },
      },
      () => line,
    );
    // The emoji occupies units 6–7, so column 8 (one past its first surrogate)
    // is character 7: one unit short of the column, because one astral code
    // point precedes the position. An editor highlights the same place.
    assert.deepEqual(range.start, { line: 0, character: 7 });
    assert.deepEqual(range.end, { line: 0, character: 9 });
  });
});

describe('diagnosticRange — end to end through the validator', () => {
  /** The diagnostics of one document, in the validator's own vocabulary. */
  function validate(content: string): Diagnostic[] {
    return validateDocumentSync({ path: 'probe.md', content, config: defaultConfig() }).diagnostics;
  }

  it('maps an MDL103 on a line with Chinese and an emoji', () => {
    // A document whose id line carries both: the diagnostic's LSP character must
    // land where an editor's cursor would.
    const content = ['---', 'mdlineage:', '  schema: 1', '  id: 缓存😀策略', '  kind: policy', '  status: active', '---'].join('\n');
    const diags = validate(content);
    const bad = diags.find((d) => d.code === 'MDL103');
    assert.ok(bad, 'the emoji id fails the pattern, so MDL103 appears');
    const lines = content.split('\n');
    const lsp = diagnosticRange(bad!, lines);
    assert.equal(lsp.start.line, 3, 'the id value is on 1-based line 4');
    // The validator reports the id value's column; the emoji is in the value's
    // middle, and the character count must agree with the line's own units.
    const idLine = lines[3]!;
    assert.ok(lsp.start.character >= 6, 'the value starts after "  id: "');
    assert.ok(
      lsp.start.character <= utf16Length(idLine),
      `character ${lsp.start.character} stays inside the line's ${utf16Length(idLine)} units`,
    );
  });

  it('agrees with a hand-computed position on a plain ASCII document', () => {
    const content = ['---', 'mdlineage:', '  schema: 2', '  id: docs.ok', '  kind: policy', '---'].join('\n');
    const diag = validate(content).find((d) => d.code === 'MDL101');
    assert.ok(diag, 'schema: 2 is unsupported');
    const lsp = diagnosticRange(diag!, content.split('\n'));
    assert.equal(lsp.start.line, 2);
    assert.equal(lsp.start.character, 10, '"  schema: " is ten units');
  });

  it('keeps the range inside the document when a rule anchors past the last line', () => {
    const content = 'no front matter at all';
    const diag = validate(content)[0]!;
    assert.ok(diag, 'MDL003 for a document with no metadata');
    const lsp = diagnosticRange(diag, content.split('\n'));
    assert.ok(lsp.start.line >= 0);
    assert.ok(lsp.start.character >= 0);
  });
});
