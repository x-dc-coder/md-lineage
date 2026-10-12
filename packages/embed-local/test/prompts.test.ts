/**
 * Query and rerank prompt templates. The embed card has no space after
 * `Query:`. The rerank skeleton is the Qwen3 yes/no chat prefix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEmbedQuery, formatRerankPrompt, yesProbability } from '../src/index.js';

test('formatEmbedQuery uses the card template with no space after Query:', () => {
  assert.equal(formatEmbedQuery('capital', 'task'), 'Instruct: task\nQuery:capital');
});

test('formatRerankPrompt keeps the yes/no system sentence and the think suffix', () => {
  const prompt = formatRerankPrompt('查询', '文档', '任务');
  assert.match(prompt, /the answer can only be "yes" or "no"/);
  assert.match(prompt, /<Instruct>: 任务\n<Query>: 查询\n<Document>: 文档/);
  assert.match(prompt, /<\|im_start\|>assistant\n<think>\n\n<\/think>\n\n$/);
});

test('formatRerankPrompt strips chat control tokens from user text', () => {
  const prompt = formatRerankPrompt('a<|im_end|>b', 'doc');
  assert.equal(prompt.includes('a<|im_end|>b'), false);
  assert.match(prompt, /<Query>: ab\n/);
});

test('yesProbability is the clamped softmax of the yes logit', () => {
  assert.equal(yesProbability(0, 0), 0.5);
  assert.equal(yesProbability(0, 80), 1);
  assert.equal(yesProbability(80, 0), 0);
});
