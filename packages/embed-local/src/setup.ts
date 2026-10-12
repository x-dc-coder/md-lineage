import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { findProfile, loadCatalog, type CatalogFile, type CatalogProfile } from './catalog.js';
import { downloadFile, remoteFileUrl } from './download.js';
import { sha256File } from './hash.js';
import { cachedPath } from './install.js';
import { resolveMirror, resolveModelDir } from './paths.js';

export interface SetupOptions {
  readonly profile?: string;
  readonly mirror?: string;
  readonly modelDir?: string;
}

export interface SetupReport {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
}

const EXPORT_HINTS: Readonly<Record<string, readonly string[]>> = {
  'local:qwen3-4b': [
    '权重待导出：local:qwen3-4b（Qwen/Qwen3-Embedding-4B）没有可直接下载的 ONNX q8。本阶段不导出，验收不阻塞。',
    'optimum-cli export onnx --model Qwen/Qwen3-Embedding-4B --task feature-extraction <dir>',
    'optimum-cli onnxruntime quantize --onnx_model <dir> --avx2 -o <quantized-dir>',
    '量化产物需落成 onnx/model_quantized.onnx（transformers.js 的 q8 文件名），再把 SHA-256 钉进 models.json。',
  ],
  'local:qwen3-reranker-4b': [
    '权重待导出：local:qwen3-reranker-4b（Qwen/Qwen3-Reranker-4B）没有可直接下载的 YesNo INT8 ONNX。本阶段不导出，验收不阻塞。',
    'YesNo 图不是 Optimum 的现成 task。可参考 n24q02m/qwen3-embed 的 scripts/export_optimized_reranker.py，导出 onnx/model_yesno_quantized.onnx 后再钉 SHA-256。',
  ],
};

/**
 * Download the requested profiles into the model cache, or print export
 * guidance for a profile that has no published q8/YesNo weight. Already
 * present files whose pin matches are left untouched.
 */
export async function setupLocalModels(options: SetupOptions = {}): Promise<SetupReport> {
  const catalog = loadCatalog();
  const selected = selectProfiles(catalog, options.profile);
  if (selected === undefined) {
    const known = catalog.map((profile) => profile.id).join(', ');
    return {
      exitCode: 2,
      lines: [`unknown profile '${options.profile ?? ''}' (expected ${known})`],
    };
  }
  const modelDir = resolveModelDir(options.modelDir);
  const mirror = resolveMirror(options.mirror);
  const lines: string[] = [];
  for (const profile of selected) {
    if (profile.pendingExport) {
      lines.push(...(EXPORT_HINTS[profile.id] ?? [`权重待导出：${profile.id}`]));
      continue;
    }
    for (const file of profile.files) {
      const outcome = await ensureFile(profile, file, modelDir, mirror);
      lines.push(outcome.line);
      if (!outcome.ok) return { exitCode: 1, lines };
    }
  }
  return { exitCode: 0, lines };
}

function selectProfiles(catalog: readonly CatalogProfile[], id: string | undefined): readonly CatalogProfile[] | undefined {
  if (id === undefined || id === '') {
    const embed = findProfile('local:qwen3-0.6b', catalog);
    const rerank = findProfile('local:qwen3-reranker-0.6b', catalog);
    if (embed === undefined || rerank === undefined) return undefined;
    return [embed, rerank];
  }
  const profile = findProfile(id, catalog);
  return profile === undefined ? undefined : [profile];
}

async function ensureFile(
  profile: CatalogProfile,
  file: CatalogFile,
  modelDir: string,
  mirror: string,
): Promise<{ ok: boolean; line: string }> {
  const abs = cachedPath(modelDir, profile.repo, file.path);
  if (existsSync(abs)) {
    const digest = await sha256File(abs);
    if (file.sha256 !== '' && digest !== file.sha256) {
      return {
        ok: false,
        line: `checksum mismatch ${profile.id} ${file.path}: expected ${file.sha256}, got ${digest}`,
      };
    }
    const pinNote = file.sha256 === '' ? ' (unpinned)' : '';
    return { ok: true, line: `${profile.id} ${file.path} already present sha256 ${digest}${pinNote}` };
  }
  const url = remoteFileUrl(mirror, profile.repo, file.path);
  try {
    await downloadFile(url, abs);
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, line: `download failed ${profile.id} ${file.path}: ${error.message}` };
    }
    throw error;
  }
  const digest = await sha256File(abs);
  if (file.sha256 !== '' && digest !== file.sha256) {
    await rm(abs, { force: true });
    return {
      ok: false,
      line: `checksum mismatch after download ${profile.id} ${file.path}: expected ${file.sha256}, got ${digest}`,
    };
  }
  const pinNote = file.sha256 === '' ? ' (unpinned; commit this digest into models.json)' : '';
  return { ok: true, line: `${profile.id} ${file.path} downloaded sha256 ${digest}${pinNote}` };
}
