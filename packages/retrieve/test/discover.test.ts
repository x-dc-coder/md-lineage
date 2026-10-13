/**
 * Tests for candidate relation pair discovery (Issue #3 Phase 3).
 *
 * Given a set of workspace documents with frontmatter IDs and relations,
 * When discoverCandidatePairs is run,
 * Then it outputs CandidatePair candidates with evidence anchors,
 * filtering out existing relations and self-references.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverCandidatePairs,
  type CandidateDocMeta,
  type CandidatePair,
  type CorpusSection,
  type EmbeddingProvider,
} from '../src/index.js';

function fakeEmbedder(dim = 4): EmbeddingProvider {
  return {
    meta: { model: 'fake', dtype: 'q8', dim, algo: 'fake-v1' },
    async embed(inputs) {
      return { vectors: inputs.map((t) => [t.length % dim, 1, 0, 0]), degraded: [] };
    },
    async embedQuery(q: string) {
      return { vectors: [[q.length % dim, 1, 0, 0]], degraded: [] };
    },
    async dispose() {},
  };
}

test('discoverCandidatePairs — discovers candidate relation pairs with anchors', async () => {
  // Given: two documents where docA mentions concepts from docB
  const sections: CorpusSection[] = [
    {
      path: 'docs/a.md',
      slug: 'intro',
      title: 'Introduction',
      text: 'This document explains language server protocol architecture and design.',
    },
    {
      path: 'docs/b.md',
      slug: 'lsp-spec',
      title: 'Language Server Solution',
      text: 'Detailed language server protocol specification and implementation details.',
    },
  ];

  const docsMeta = new Map<string, CandidateDocMeta>([
    ['docs/a.md', { id: 'docs.a', relations: [] }],
    ['docs/b.md', { id: 'docs.b', relations: [] }],
  ]);

  // When: discovering candidate pairs for doc A in lexical mode
  const outcome = await discoverCandidatePairs({
    sourcePath: 'docs/a.md',
    sections,
    docsMeta,
    mode: 'lexical',
    top: 5,
  });

  // Then: doc B is suggested as a candidate target with evidence anchor '#lsp-spec'
  assert.ok(outcome.pairs.length > 0);
  const pair = outcome.pairs[0];
  assert.equal(pair?.sourcePath, 'docs/a.md');
  assert.equal(pair?.targetPath, 'docs/b.md');
  assert.equal(pair?.targetId, 'docs.b');
  assert.equal(pair?.targetSlug, 'lsp-spec');
  assert.equal(pair?.evidenceAnchor, '#lsp-spec');
  assert.equal(pair?.scoreKind, 'bm25');
});

test('discoverCandidatePairs — filters out relations that already exist in front matter', async () => {
  // Given: docA already has a relation targeting docs.b
  const sections: CorpusSection[] = [
    {
      path: 'docs/a.md',
      slug: 'intro',
      title: 'Introduction',
      text: 'This document explains language server protocol architecture and design.',
    },
    {
      path: 'docs/b.md',
      slug: 'lsp-spec',
      title: 'Language Server Solution',
      text: 'Detailed language server protocol specification and implementation details.',
    },
  ];

  const docsMeta = new Map<string, CandidateDocMeta>([
    ['docs/a.md', { id: 'docs.a', relations: [{ target: 'docs.b' }] }],
    ['docs/b.md', { id: 'docs.b', relations: [] }],
  ]);

  // When: discovering candidate pairs for doc A
  const outcome = await discoverCandidatePairs({
    sourcePath: 'docs/a.md',
    sections,
    docsMeta,
    mode: 'lexical',
    filterExisting: true,
  });

  // Then: doc B is filtered out because the relation already exists
  assert.equal(outcome.pairs.length, 0);
});

test('discoverCandidatePairs — filters out self-references (source cannot target self)', async () => {
  // Given: docA has multiple sections
  const sections: CorpusSection[] = [
    {
      path: 'docs/a.md',
      slug: 'sec1',
      title: 'Section 1',
      text: 'Language server protocol architecture.',
    },
    {
      path: 'docs/a.md',
      slug: 'sec2',
      title: 'Section 2',
      text: 'Language server protocol details.',
    },
  ];

  const docsMeta = new Map<string, CandidateDocMeta>([
    ['docs/a.md', { id: 'docs.a', relations: [] }],
  ]);

  // When: discovering candidate pairs
  const outcome = await discoverCandidatePairs({
    sourcePath: 'docs/a.md',
    sections,
    docsMeta,
    mode: 'lexical',
  });

  // Then: no self-targeted candidate pair is emitted
  assert.equal(outcome.pairs.length, 0);
});
