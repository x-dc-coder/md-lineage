import type { Root } from 'mdast';
import type { Config } from './config.js';
import type { Diagnostic } from './diagnostic.js';

/** Input to the validator. `content` is the document string (UTF-16 view). */
export interface ValidateInput {
  /** Document path, used only for messages; never read from disk. */
  path?: string;
  /** The full document text. */
  content: string;
  /** Configuration; the built-in defaults are used when omitted. */
  config?: Config;
}

export interface ValidateResult {
  /** Diagnostics, sorted by document offset. */
  diagnostics: Diagnostic[];
  /** The parsed mdast tree, for adapters that need headings/links. */
  tree: Root | null;
  /** The extracted front matter object, when YAML parsed. */
  frontmatter: Record<string, unknown> | null;
  /** Where the Markdown body starts (after the closing fence), or 0. */
  bodyStart: number;
  /** Which layers produced diagnostics, for fast filtering. */
  layers: Set<string>;
}
