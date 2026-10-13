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
//         [--mode lexical|hybrid|hybrid-rerank]
//         [--length-accounting token-total|unique-terms]
//         [--device cpu|cuda|dml]
// Reads the built workspace packages (run `npm run build` first).
// hybrid and hybrid-rerank load @mdlineage/embed-local and the local models.
// --device sets MDLINEAGE_EMBED_DEVICE for this process so the embed session
// uses that provider. Omit it and the embedder keeps its probed provider.

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
import { Bm25Index, DEFAULT_LENGTH_ACCOUNTING, FileVectorStore, searchCorpus } from '@mdlineage/retrieve';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECALL_AT = 10;
const MIN_PAIRS = 40;
const MAX_PAIRS = 60;
const asJson = process.argv.includes('--json');
const verbose = process.argv.includes('--verbose');

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const mode = flag('--mode') ?? 'lexical';
const lengthAccounting = flag('--length-accounting') ?? 'token-total';
const embedDevice = flag('--device');
if (mode !== 'lexical' && mode !== 'hybrid' && mode !== 'hybrid-rerank') {
  console.error(`retrieval-eval: --mode must be lexical, hybrid, or hybrid-rerank`);
  process.exit(2);
}
if (lengthAccounting !== 'token-total' && lengthAccounting !== 'unique-terms') {
  console.error(`retrieval-eval: --length-accounting must be token-total or unique-terms`);
  process.exit(2);
}
if (embedDevice !== undefined && embedDevice !== 'cpu' && embedDevice !== 'cuda' && embedDevice !== 'dml') {
  console.error(`retrieval-eval: --device must be cpu, cuda, or dml`);
  process.exit(2);
}
if (embedDevice !== undefined) process.env.MDLINEAGE_EMBED_DEVICE = embedDevice;

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

/**
 * Sample pairs are restricted to the docs tree (the front matter the issue
 * names); the CORPUS is the whole scanned universe — fixtures, READMEs and
 * all — because that is what `mdlineage retrieve search` actually searches.
 */
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
// Retrieval. Lexical stays on the Phase 1 document merge (max section score,
// score desc / path asc) so leftover #33 is comparable to the 2026-10-10
// baseline. Hybrid modes ask the production pipeline for every section
// (`top` = corpus length). Document rank is the first time that path appears
// in the pipeline's section list: after rerank the window scores and the RRF
// tail are not one scale, so a max-score merge would reorder them.
// The hybrid lexical leg uses the Bm25Index constructor default. This flag
// changes only `--mode lexical`.
// ---------------------------------------------------------------------------

const corpus = [];
for (const [path, content] of universe.documents) {
  for (const section of extractSections(content)) {
    corpus.push({ path, slug: section.slug, title: section.title, text: section.text });
  }
}

/** Document-level ranking for BM25: best section score per document. */
function rankLexical(query, index) {
  const best = new Map();
  for (const hit of index.search(query)) {
    const current = best.get(hit.path);
    if (current === undefined || hit.score > current) best.set(hit.path, hit.score);
  }
  return [...best.entries()].sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1));
}

/** Document-level ranking that keeps the pipeline's section order. */
function rankByFirstSection(hits) {
  const seen = new Set();
  const ranking = [];
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    ranking.push([hit.path, hit.score]);
  }
  return ranking;
}

const HARD_DEGRADED = [
  'dense-failed',
  'hybrid-unavailable',
  'embeddings-partial',
  'vector-dim-mismatch',
  'rerank-timeout',
  'rerank-failed',
  'rerank-skipped',
];

function hardDegraded(notes) {
  return notes.filter((note) => HARD_DEGRADED.some((prefix) => note.startsWith(prefix)));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

async function openHybrid() {
  let loaded;
  try {
    loaded = await import('@mdlineage/embed-local');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`retrieval-eval: cannot load @mdlineage/embed-local (${detail})`);
    process.exit(1);
  }
  if (!isRecord(loaded) || typeof loaded.openLocalRetrieval !== 'function') {
    console.error('retrieval-eval: @mdlineage/embed-local has no openLocalRetrieval');
    process.exit(1);
  }
  const opened = await loaded.openLocalRetrieval();
  if (!isRecord(opened) || opened.ready !== true || !isRecord(opened.embedder)) {
    const notes = Array.isArray(opened?.degraded) ? opened.degraded.join('; ') : 'not ready';
    console.error(`retrieval-eval: local models are not ready (${notes})`);
    process.exit(1);
  }
  if (mode === 'hybrid-rerank' && !isRecord(opened.reranker)) {
    const notes = Array.isArray(opened.degraded) ? opened.degraded.join('; ') : 'reranker missing';
    console.error(`retrieval-eval: reranker is not ready (${notes})`);
    process.exit(1);
  }
  const meta = opened.embedder.meta;
  if (!isRecord(meta) || typeof meta.model !== 'string' || typeof meta.dim !== 'number') {
    console.error('retrieval-eval: embedder meta is missing model or dim');
    process.exit(1);
  }
  return opened;
}

async function disposeOpened(opened) {
  if (!isRecord(opened)) return;
  if (isRecord(opened.embedder) && typeof opened.embedder.dispose === 'function') {
    await opened.embedder.dispose();
  }
  if (isRecord(opened.reranker) && typeof opened.reranker.dispose === 'function') {
    await opened.reranker.dispose();
  }
}

async function evaluate() {
  const started = Date.now();
  const perPair = [];
  const degraded = [];
  let recalls = 0;
  let reciprocalSum = 0;
  let opened = null;

  const scorePair = (sample, ranking, notes) => {
    const rank = ranking.findIndex(([path]) => path === sample.target) + 1;
    const inTop = rank >= 1 && rank <= RECALL_AT;
    if (inTop) recalls++;
    // MRR@10 is truncated at 10: a target found at rank 37 contributes nothing,
    // same as an unranked one.
    if (inTop) reciprocalSum += 1 / rank;
    for (const note of notes) {
      if (!degraded.includes(note)) degraded.push(note);
    }
    perPair.push({ ...sample, rank: rank >= 1 ? rank : null, inTop, degraded: notes });
  };

  try {
    if (mode === 'lexical') {
      const index = new Bm25Index(corpus, lengthAccounting);
      for (const sample of samples) scorePair(sample, rankLexical(sample.query, index), []);
    } else {
      if (lengthAccounting !== 'token-total') {
        console.error(
          'retrieval-eval: --length-accounting applies to --mode lexical; hybrid uses the Bm25Index default',
        );
      }
      process.env.MDLINEAGE_EMBED_PROGRESS = '1';
      opened = await openHybrid();
      // MDLINEAGE_EVAL_CACHE anchors the vector store somewhere other than the
      // workspace cache, so a CPU measurement does not read blobs another
      // device wrote into `<root>/.mdlineage-cache`.
      const store = new FileVectorStore(process.env.MDLINEAGE_EVAL_CACHE ?? root, {
        model: opened.embedder.meta.model,
        dtype: typeof opened.embedder.meta.dtype === 'string' ? opened.embedder.meta.dtype : 'q8',
        dim: opened.embedder.meta.dim,
        algo: opened.embedder.meta.algo,
      });
      // The product default is 5s. On CPU a 50-candidate YesNo window does not
      // finish in 5s, and the pipeline would then keep RRF order. This mode
      // measures the reranker, so the budget covers the whole window.
      const rerankTimeoutMs = 30 * 60 * 1000;
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        console.error(`retrieval-eval: ${mode} query ${i + 1}/${samples.length}`);
        const outcome = await searchCorpus({
          query: sample.query,
          sections: corpus,
          top: corpus.length,
          mode: 'hybrid',
          embedder: opened.embedder,
          reranker: mode === 'hybrid-rerank' ? opened.reranker : null,
          store,
          rerankTimeoutMs,
        });
        const notes = Array.isArray(outcome.degraded) ? outcome.degraded : [];
        const blocked = hardDegraded(notes);
        if (outcome.mode !== 'hybrid' || blocked.length > 0) {
          console.error(`retrieval-eval: ${mode} did not finish query ${i + 1}: ${blocked.join('; ') || outcome.mode}`);
          process.exit(1);
        }
        scorePair(sample, rankByFirstSection(outcome.hits), notes);
      }
    }
  } finally {
    await disposeOpened(opened);
  }

  const rank1 = perPair.filter((pair) => pair.rank === 1).length;
  const rank2to3 = perPair.filter((pair) => pair.rank !== null && pair.rank >= 2 && pair.rank <= 3).length;
  const rank4to10 = perPair.filter((pair) => pair.rank !== null && pair.rank >= 4 && pair.rank <= 10).length;
  const miss = perPair.filter((pair) => !pair.inTop).length;
  return {
    perPair,
    metrics: {
      mode,
      lengthAccounting: mode === 'lexical' ? lengthAccounting : DEFAULT_LENGTH_ACCOUNTING,
      embedDevice: embedDevice ?? null,
      pairs: samples.length,
      recallAt10: samples.length === 0 ? 0 : recalls / samples.length,
      mrrAt10: samples.length === 0 ? 0 : reciprocalSum / samples.length,
      corpusDocuments: universe.documents.size,
      corpusSections: corpus.length,
      elapsedMs: Date.now() - started,
      ranks: { rank1, rank2to3, rank4to10, miss },
      degraded,
      ...(warning !== null ? { warning } : {}),
    },
  };
}

const { perPair, metrics } = await evaluate();

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

if (asJson) {
  console.log(JSON.stringify({ metrics, samples: verbose ? perPair : undefined }, null, 2));
} else {
  console.log(`retrieval eval (${metrics.mode}, length ${metrics.lengthAccounting}, document level)`);
  console.log(`  corpus:   ${metrics.corpusDocuments} documents, ${metrics.corpusSections} sections`);
  console.log(`  samples:  ${metrics.pairs} pairs`);
  console.log(`  Recall@10: ${(metrics.recallAt10 * 100).toFixed(1)}%`);
  console.log(`  MRR@10:    ${metrics.mrrAt10.toFixed(3)}`);
  console.log(`  elapsed:  ${metrics.elapsedMs} ms`);
  if (metrics.degraded.length > 0) console.log(`  degraded: ${metrics.degraded.join('; ')}`);
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
