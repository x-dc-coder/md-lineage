/**
 * Reciprocal Rank Fusion (Issue #3 §4: RRF k=60 merges the lexical and dense
 * branches). Pure function, zero dependencies, deterministic order: score
 * descending, then key ascending.
 */

export interface FusedRank {
  key: string;
  score: number;
}

/**
 * Fuse ranked key lists. `rankings[i]` is a ranking (best first); an item's
 * contribution from one ranking is `1/(k + rank)` with 1-based rank, and the
 * fused score is the sum over every ranking that contains it. Keys absent
 * from all rankings (or all empty) produce an empty result.
 */
export function fuse(rankings: readonly (readonly string[])[], k = 60): FusedRank[] {
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`fuse: k must be a positive number, got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    // Within ONE ranking a key is scored once, at its first occurrence: a
    // provider echoing a duplicate would otherwise double its credit.
    const seen = new Set<string>();
    for (let i = 0; i < ranking.length; i++) {
      const key = ranking[i];
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : a.key < b.key ? -1 : 1));
}
