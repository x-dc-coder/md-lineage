#!/usr/bin/env node
// Enforces the README contract — see docs/specs/readme-contract.md.
//
// Targets and clauses:
//   README.md (root)      project facade  : clauses 1-7
//   other */README.md     landing page    : clauses 1L, 2, 7
//   test/fixtures/**      fixture material: exempt
//
// Dependency-free on purpose: the contract is about text shape, so the check
// runs before (and independently of) the build.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FACADE = {
  lines: 100,
  codeBlocks: 5,
  codeBlockLines: 12,
  tables: 2,
  sectionLines: 15,
  paragraphLines: 3,
  firstScreen: 15,
};
const LANDING = { lines: 120 };
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const EXEMPT_PREFIXES = ['test/fixtures/'];

/** Recursively collect every README.md path, relative to `root`, POSIX-slashed. */
function discoverReadmes(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name === 'README.md') {
        found.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Structural facts about one Markdown document. */
function analyze(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // A normal trailing newline must not count as an extra line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const inFence = new Array(lines.length).fill(false);
  const codeBlocks = [];
  let fenceOpen = false;
  let blockStart = -1;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence[i] = true;
      if (!fenceOpen) {
        fenceOpen = true;
        blockStart = i;
      } else {
        fenceOpen = false;
        codeBlocks.push({ start: blockStart, end: i });
      }
    } else if (fenceOpen) {
      inFence[i] = true;
    }
  });

  const headings = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const match = /^(#{1,6})\s+/.exec(line);
    if (match) headings.push({ level: match[1].length, line: i, text: line.replace(/^#+\s+/, '') });
  });

  let tables = 0;
  let previousWasTable = false;
  lines.forEach((line, i) => {
    if (inFence[i]) {
      previousWasTable = false;
      return;
    }
    const isTableRow = /^\s*\|/.test(line);
    if (isTableRow && !previousWasTable) tables += 1;
    previousWasTable = isTableRow;
  });

  const sections = [];
  const h2s = headings.filter((h) => h.level === 2);
  h2s.forEach((heading, index) => {
    const end = index + 1 < h2s.length ? h2s[index + 1].line : lines.length;
    let count = 0;
    for (let i = heading.line + 1; i < end; i += 1) {
      if (lines[i].trim() !== '') count += 1;
    }
    sections.push({ heading, count });
  });

  const isStructural = (line) => /^\s*(#{1,6}\s|\||[-*+]\s|\d+\.\s|>)/.test(line);
  const paragraphs = [];
  let run = 0;
  let runStart = 0;
  lines.forEach((line, i) => {
    if (inFence[i] || line.trim() === '' || isStructural(line)) {
      run = 0;
      return;
    }
    if (run === 0) runStart = i;
    run += 1;
    paragraphs.push({ start: runStart, length: run });
  });

  const links = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const link = /\]\(\s*(?:<)?([^)\s>]+)/g;
    let match;
    while ((match = link.exec(line)) !== null) links.push({ line: i + 1, target: match[1] });
  });

  return {
    lines,
    lineCount: lines.length,
    inFence,
    codeBlocks,
    headings,
    tables,
    sections,
    paragraphs,
    links,
    firstFenceLine: inFence.findIndex(Boolean),
    unclosedFence: fenceOpen,
  };
}

const clause2 = (doc, bad) => {
  const h1 = doc.headings.filter((h) => h.level === 1);
  if (h1.length !== 1) bad('2', `expected exactly one H1, found ${h1.length}`);
  const tooDeep = doc.headings.filter((h) => h.level > 2);
  if (tooDeep.length > 0) bad('2', `${tooDeep.length} heading(s) deeper than H2, first at line ${tooDeep[0].line + 1}`);
};

const clause7 = (doc, bad) => {
  for (const link of doc.links) {
    if (/^(https?:|mailto:|ftp:)/i.test(link.target)) {
      bad('7', `absolute link target at line ${link.line}: ${link.target}`);
    }
  }
};

/** @returns {string[]} violations, each already prefixed with its clause. */
function checkFacade(doc) {
  const violations = [];
  const bad = (clause, message) => violations.push(`clause ${clause}: ${message}`);

  if (doc.lineCount > FACADE.lines) bad('1', `${doc.lineCount} lines exceeds ${FACADE.lines}`);
  clause2(doc, bad);
  if (doc.codeBlocks.length > FACADE.codeBlocks) {
    bad('3', `${doc.codeBlocks.length} code blocks exceeds ${FACADE.codeBlocks}`);
  }
  for (const block of doc.codeBlocks) {
    const body = block.end - block.start - 1;
    if (body > FACADE.codeBlockLines) {
      bad('3', `code block at line ${block.start + 1} has ${body} lines, over ${FACADE.codeBlockLines}`);
    }
  }
  if (doc.tables > FACADE.tables) bad('4', `${doc.tables} tables exceeds ${FACADE.tables}`);
  for (const section of doc.sections) {
    if (section.count > FACADE.sectionLines) {
      bad('5', `section "${section.heading.text}" has ${section.count} non-blank lines, over ${FACADE.sectionLines}`);
    }
  }
  for (const paragraph of doc.paragraphs) {
    if (paragraph.length > FACADE.paragraphLines) {
      bad('5', `paragraph at line ${paragraph.start + 1} exceeds ${FACADE.paragraphLines} lines`);
    }
  }
  if (doc.firstFenceLine === -1 || doc.firstFenceLine >= FACADE.firstScreen) {
    bad('6', `no fenced code block within the first ${FACADE.firstScreen} lines`);
  }
  clause7(doc, bad);
  return violations;
}

/** @returns {string[]} violations, each already prefixed with its clause. */
function checkLanding(doc) {
  const violations = [];
  const bad = (clause, message) => violations.push(`clause ${clause}: ${message}`);

  if (doc.lineCount > LANDING.lines) bad('1L', `${doc.lineCount} lines exceeds ${LANDING.lines}`);
  clause2(doc, bad);
  clause7(doc, bad);
  return violations;
}

const root = process.cwd();
const readmes = discoverReadmes(root);
if (!readmes.includes('README.md')) {
  console.log('check-readme: README.md is missing at the repository root');
  process.exit(1);
}

let failures = 0;
const summaries = [];
for (const path of readmes) {
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
  const doc = analyze(readFileSync(join(root, path), 'utf8'));
  const kind = path === 'README.md' ? 'facade' : 'landing';
  const violations = kind === 'facade' ? checkFacade(doc) : checkLanding(doc);
  for (const violation of violations) console.log(`${path}: ${violation}`);
  if (doc.unclosedFence) console.log(`${path}: clause 3: unclosed fenced code block`);
  failures += violations.length + (doc.unclosedFence ? 1 : 0);
  summaries.push(
    `  ${path} (${kind}): ${doc.lineCount} lines, ${doc.headings.length} headings, ` +
      `${doc.codeBlocks.length} code blocks, ${doc.tables} table(s)` +
      (violations.length === 0 && !doc.unclosedFence ? ' — OK' : ''),
  );
}

for (const summary of summaries) console.log(summary);
if (failures === 0) {
  console.log(`check-readme: ${summaries.length} file(s) checked — OK`);
  process.exit(0);
}
console.log(`check-readme: ${summaries.length} file(s) checked — ${failures} violation(s)`);
process.exit(1);
