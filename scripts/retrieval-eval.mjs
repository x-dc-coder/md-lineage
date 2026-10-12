#!/usr/bin/env node
// BM25 retrieval baseline evaluation (Issue #3 Phase 1, §7 acceptance).
//
// Builds an evaluation set from the repository's own mdlineage front matter:
// every strong relation (depends_on / refines) with a resolvable target is
// one sample pair — query = the relation's `reason` (fallback: source title),
// expected hit = the target document. Below 40 pairs the set is topped up
// with other-typed relations, then with topic-overlapping document pairs
// (rule-generated; no model in the loop).
//
// Retrieval runs at document granularity: section hits merge into their
// document (max score), mirroring how `mdlineage retrieve search` results
// would be read document-first. Metrics: Recall@10 and MRR@10.
//
// Usage:  node scripts/retrieval-eval.mjs [--json] [--verbose]
// Reads the built workspace packages (run `npm run build` first).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  scanWorkspaceUniverse,
  extractSections,
  scanBoundary,
  parseFrontmatter,
  buildLineMap,
} from '@mdlineage/validator';
import { Bm25Index } from '@mdlineage/retrieve';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECALL_AT = 10;
const MIN_PAIRS = 40;
const MAX_PAIRS = 60;
const asJson = process.argv.includes('--json');
const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Corpus: every Markdown document the workspace scanner sees.
// ---------------------------------------------------------------------------

const loaded = loadConfig(undefined, root);
if (loaded.diagnostics.some((d) => d.severity === 'error')) {
  for (const d of loaded.diagnostics) console.error(`mdlineage: ${d.code} ${d.message}`);
  process.exit(1);
}
const universe = scanWorkspaceUniverse(root, loaded.config);

/** mdlineage metadata of one document, or null when absent/unparseable. */
function metadataOf(content) {
  const boundary = scanBoundary(content);
  if (boundary === null) return null;
  const lineMap = buildLineMap(content);
  const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, lineMap);
  const value = parsed.parsed?.data?.mdlineage;
  if (typeof value !== 'object' || value === null) return null;
  return value;
}

const docs = new Map(); // path -> { title, topics, relations }
for (const [path, content] of universe.documents) {
  const md = metadataOf(content);
  const firstHeading = content
    .slice(boundaryEnd(content))
    .split('\n')
    .find((line) => /^#{1,6}\s/.test(line));
  docs.set(path, {
    title: (firstHeading ?? path).replace(/^#{1,6}\s+/, '').trim(),
    topics: Array.isArray(md?.topics) ? md.topics.filter((t) => typeof t === 'string') : [],
    relations: Array.isArray(md?.relations)
      ? md.relations.filter((r) => typeof r === 'object' && r !== null)
      : [],
    id: typeof md?.id === 'string' ? md.id : null,
  });
}

function boundaryEnd(content) {
  const boundary = scanBoundary(content);
  return boundary !== null && boundary.closeStart !== null ? boundary.closeStart : 0;
}

const idToPath = new Map();
for (const [path, doc] of docs) {
  if (doc.id) idToPath.set(doc.id, path);
}

// ---------------------------------------------------------------------------
// Sample pairs: strong relations first, then other relations, then topics.
// ---------------------------------------------------------------------------

/** All eval samples must live under docs/ so the corpus stays the docs tree. */
const inDocsTree = (p) => p === 'docs' || p.startsWith('docs/');

function pairsFromRelations(types) {
  const pairs = [];
  for (const [sourcePath, doc] of [...docs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!inDocsTree(sourcePath) || !doc.id) continue;
    for (const relation of doc.relations) {
      if (!types.includes(relation.type)) continue;
      const targetPath = idToPath.get(relation.target);
      if (!targetPath || targetPath === sourcePath || !inDocsTree(targetPath)) continue;
      const reason = typeof relation.reason === 'string' ? relation.reason.trim() : '';
      pairs.push({
        source: sourcePath,
        target: targetPath,
        query: reason.length > 0 ? reason : doc.title,
        origin: `relation:${relation.type}`,
      });
    }
  }
  return pairs;
}

function pairsFromTopics() {
  const pairs = [];
  const paths = [...docs.keys()].filter(inDocsTree).sort();
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const a = paths[i];
      const b = paths[j];
      const shared = docs.get(a).topics.filter((t) => docs.get(b).topics.includes(t));
      if (shared.length === 0) continue;
      pairs.push({ source: a, target: b, query: docs.get(a).title, origin: 'topics' });
    }
  }
  // Deterministic order; the primary relation pairs take precedence anyway.
  return pairs.sort((x, y) => (x.source + x.target < y.source + y.target ? -1 : 1));
}

function dedupe(pairs) {
  const seen = new Set();
  const out = [];
  for (const pair of pairs) {
    const key = `${pair.source}\u0000${pair.target}\u0000${pair.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

let samples = dedupe([
  // Primary: the strong semantic types the issue names; supplements follow in
  // vocabulary order (implements, supersedes, contradicts, example_of,
  // related_to — the schema's fixed v1 enum) before topic overlap kicks in.
  ...pairsFromRelations(['depends_on', 'refines']),
  ...pairsFromRelations(['implements', 'supersedes', 'contradicts', 'example_of', 'related_to']),
  ...pairsFromTopics(),
]).slice(0, MAX_PAIRS);

const shortOfTarget = samples.length < MIN_PAIRS;
const warning = shortOfTarget
  ? `only ${samples.length} sample pairs available (need ${MIN_PAIRS}-${MAX_PAIRS}); ` +
    'the repository front matter is too sparse for a stable baseline'
  : null;
if (shortOfTarget && !asJson) {
  console.error(`retrieval-eval: ${warning}`);
}

// ---------------------------------------------------------------------------
// Retrieval: BM25 over sections, merged to document level.
// ---------------------------------------------------------------------------

const corpus = [];
for (const [path, content] of universe.documents) {
  for (const section of extractSections(content)) {
    corpus.push({ path, slug: section.slug, title: section.title, text: section.text });
  }
}
const index = new Bm25Index(corpus);

/** Document-level ranking for a query: best section score per document. */
function rankDocuments(query) {
  const best = new Map();
  for (const hit of index.search(query)) {
    const current = best.get(hit.path);
    if (current === undefined || hit.score > current) best.set(hit.path, hit.score);
  }
  // Same determinism contract as the lexical branch: score desc, path asc.
  return [...best.entries()].sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1));
}

const perPair = [];
let recalls = 0;
let reciprocalSum = 0;
for (const sample of samples) {
  const ranking = rankDocuments(sample.query);
  const rank = ranking.findIndex(([path]) => path === sample.target) + 1;
  const inTop = rank >= 1 && rank <= RECALL_AT;
  if (inTop) recalls++;
  if (rank >= 1) reciprocalSum += 1 / rank;
  perPair.push({ ...sample, rank: rank >= 1 ? rank : null, inTop });
}

const metrics = {
  pairs: samples.length,
  recallAt10: samples.length === 0 ? 0 : recalls / samples.length,
  mrrAt10: samples.length === 0 ? 0 : reciprocalSum / samples.length,
  corpusDocuments: universe.documents.size,
  corpusSections: corpus.length,
  ...(warning !== null ? { warning } : {}),
};

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

if (asJson) {
  console.log(JSON.stringify({ metrics, samples: verbose ? perPair : undefined }, null, 2));
} else {
  console.log(`retrieval eval (bm25-only, document level, docs corpus)`);
  console.log(`  corpus:   ${metrics.corpusDocuments} documents, ${metrics.corpusSections} sections`);
  console.log(`  samples:  ${metrics.pairs} pairs`);
  console.log(`  Recall@10: ${(metrics.recallAt10 * 100).toFixed(1)}%`);
  console.log(`  MRR@10:    ${metrics.mrrAt10.toFixed(3)}`);
  if (verbose) {
    const failures = perPair.filter((p) => !p.inTop);
    console.log(`\nfailures (rank > ${RECALL_AT} or unranked): ${failures.length}`);
    for (const f of failures) {
      console.log(`  [${f.origin}] ${f.source} -> ${f.target}`);
      console.log(`    query: ${f.query}`);
    }
    const ranked = perPair.filter((p) => p.rank !== null && p.rank > 3 && p.inTop);
    console.log(`\nlow ranks (4..${RECALL_AT}):`);
    for (const p of ranked.slice(0, 10)) {
      console.log(`  rank ${p.rank} [${p.origin}] ${p.source} -> ${p.target} :: ${p.query}`);
    }
  }
}
