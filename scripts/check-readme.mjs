#!/usr/bin/env node
// Enforces the root README contract — see docs/specs/readme-contract.md.
//
// Machine-checked clauses:
//   1. total length <= 100 lines
//   2. exactly one H1, no heading deeper than H2
//   3. <= 5 fenced code blocks, each <= 12 lines
//   4. <= 2 tables
//   5. each H2 section <= 15 non-blank lines; each paragraph <= 3 lines
//   6. a fenced code block appears within the first 15 lines
//   7. every link target is relative (no http/https/mailto/ftp)
//
// Dependency-free on purpose: the contract is about text shape, so the check
// runs before (and independently of) the build.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LIMITS = {
  lines: 100,
  codeBlocks: 5,
  codeBlockLines: 12,
  tables: 2,
  sectionLines: 15,
  paragraphLines: 3,
  firstScreen: 15,
};

const file = resolve(process.cwd(), 'README.md');
const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
// A normal trailing newline must not count as an extra line.
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

const violations = [];
const bad = (clause, message) => violations.push(`clause ${clause}: ${message}`);

// Fence map: mark every line that belongs to (or opens/closes) a code block.
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
if (fenceOpen) bad('3', 'unclosed fenced code block');

// 1. total length
if (lines.length > LIMITS.lines) bad('1', `${lines.length} lines exceeds ${LIMITS.lines}`);

// 2. heading shape
const headings = [];
lines.forEach((line, i) => {
  if (inFence[i]) return;
  const match = /^(#{1,6})\s+/.exec(line);
  if (match) headings.push({ level: match[1].length, line: i, text: line.replace(/^#+\s+/, '') });
});
const h1 = headings.filter((h) => h.level === 1);
if (h1.length !== 1) bad('2', `expected exactly one H1, found ${h1.length}`);
const tooDeep = headings.filter((h) => h.level > 2);
if (tooDeep.length > 0) bad('2', `${tooDeep.length} heading(s) deeper than H2, first at line ${tooDeep[0].line + 1}`);

// 3. code blocks
if (codeBlocks.length > LIMITS.codeBlocks) bad('3', `${codeBlocks.length} code blocks exceeds ${LIMITS.codeBlocks}`);
for (const block of codeBlocks) {
  const body = block.end - block.start - 1;
  if (body > LIMITS.codeBlockLines) {
    bad('3', `code block at line ${block.start + 1} has ${body} lines, over ${LIMITS.codeBlockLines}`);
  }
}

// 4. tables (runs of consecutive table rows count as one table)
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
if (tables > LIMITS.tables) bad('4', `${tables} tables exceeds ${LIMITS.tables}`);

// 5a. section budgets (every non-blank line counts, code included)
const h2s = headings.filter((h) => h.level === 2);
h2s.forEach((heading, index) => {
  const end = index + 1 < h2s.length ? h2s[index + 1].line : lines.length;
  let count = 0;
  for (let i = heading.line + 1; i < end; i += 1) {
    if (lines[i].trim() !== '') count += 1;
  }
  if (count > LIMITS.sectionLines) {
    bad('5', `section "${heading.text}" has ${count} non-blank lines, over ${LIMITS.sectionLines}`);
  }
});

// 5b. paragraph budgets (text runs only; lists, tables, quotes and fences excluded)
const isStructural = (line) => /^\s*(#{1,6}\s|\||[-*+]\s|\d+\.\s|>)/.test(line);
let paragraph = 0;
let paragraphStart = 0;
lines.forEach((line, i) => {
  if (inFence[i]) {
    paragraph = 0;
    return;
  }
  if (line.trim() === '' || isStructural(line)) {
    paragraph = 0;
    return;
  }
  if (paragraph === 0) paragraphStart = i;
  paragraph += 1;
  if (paragraph === LIMITS.paragraphLines + 1) {
    bad('5', `paragraph at line ${paragraphStart + 1} exceeds ${LIMITS.paragraphLines} lines`);
  }
});

// 6. the quick start must stay above the fold
const firstFenceLine = inFence.findIndex(Boolean);
if (firstFenceLine === -1 || firstFenceLine >= LIMITS.firstScreen) {
  bad('6', `no fenced code block within the first ${LIMITS.firstScreen} lines`);
}

// 7. relative links only
lines.forEach((line, i) => {
  if (inFence[i]) return;
  const link = /\]\(\s*(?:<)?([^)\s>]+)/g;
  let match;
  while ((match = link.exec(line)) !== null) {
    if (/^(https?:|mailto:|ftp:)/i.test(match[1])) {
      bad('7', `absolute link target at line ${i + 1}: ${match[1]}`);
    }
  }
});

const summary = `check-readme: ${lines.length} lines, ${headings.length} headings, ${codeBlocks.length} code blocks, ${tables} table(s)`;
if (violations.length === 0) {
  console.log(`${summary} — OK`);
  process.exit(0);
}
for (const violation of violations) console.log(`README.md: ${violation}`);
console.log(`${summary} — ${violations.length} violation(s)`);
process.exit(1);
