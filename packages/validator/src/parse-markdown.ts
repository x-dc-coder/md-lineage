/**
 * Markdown parsing (docs/remark-language-server-solution.md §6.1: unified /
 * remark-parse). Parsing failures never throw: a malformed document produces a
 * diagnostic instead, so the caller always gets a well-formed result.
 *
 * remark-parse is a lazy dependency of this module: it is only imported when a
 * document actually needs an AST, and an unavailable or broken install degrades
 * to a diagnostic rather than crashing the validator.
 */

import type { Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

export interface ParsedMarkdown {
  tree: Root | null;
  /** True when the AST is unusable; the companion diagnostic explains why. */
  parseError: string | null;
}

/**
 * Parse Markdown into an mdast tree. Never throws.
 *
 * The validator's contract is that any input yields diagnostics, never an
 * exception, so the parse is defended even though the underlying processors
 * are expected to be present.
 */
export async function parseMarkdown(text: string): Promise<ParsedMarkdown> {
  try {
    const processor = unified().use(remarkParse);
    const tree = processor.parse(text) as unknown as Root;
    return { tree, parseError: null };
  } catch (error) {
    return {
      tree: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Parse Markdown synchronously. The same processor as `parseMarkdown`, kept sync
 * so the validation pipeline never blocks the event loop on a promise.
 */
export function parseMarkdownSync(text: string): Root | null {
  try {
    const processor = unified().use(remarkParse);
    return processor.parse(text) as unknown as Root;
  } catch {
    return null;
  }
}

/** Minimal mdast helpers used without a full traversal dependency. */
export function isParent(node: unknown): node is { children: unknown[] } {
  return typeof node === 'object' && node !== null && Array.isArray((node as { children?: unknown[] }).children);
}

/** mdast position helper: `position.start.offset`/`position.end.offset`. */
export function nodeOffsets(node: {
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}): { start: number | undefined; end: number | undefined } {
  return {
    start: node.position?.start?.offset,
    end: node.position?.end?.offset,
  };
}
