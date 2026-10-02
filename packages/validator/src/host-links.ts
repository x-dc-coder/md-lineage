import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import type { Config } from './config.js';
import type { Severity } from './diagnostic.js';

export type DestinationKind = 'workspace-relative' | 'external-url' | 'home-relative' | 'host-absolute';

export interface HostLinkResult {
  readonly isHostLink: boolean;
  readonly diagnostic?: {
    readonly code: 'MDL403';
    readonly severity: Severity;
    readonly message: string;
    readonly data?: {
      readonly target: string;
      readonly resolvedPath?: string;
      readonly suggestion?: string;
    };
  };
}

/**
 * Classify a destination string into:
 * - external-url (e.g. https://, mailto:, but not Windows drive C:)
 * - home-relative (starts with ~/ or $HOME/ or equals ~ or $HOME)
 * - host-absolute (starts with / on POSIX, or drive letter / UNC on Windows)
 * - workspace-relative (all others)
 */
export function classifyDestination(target: string, platform?: string): DestinationKind {
  const currentPlatform = platform ?? process.platform;

  // External URL check: ^[a-z][a-z0-9+.-]*:
  // Must avoid mistaking Windows drive letters like C: or C:/ as URLs.
  const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(target) || /^[a-zA-Z]:$/.test(target);
  if (!isWindowsDrive) {
    const colon = target.indexOf(':');
    if (colon > 0 && /^[a-z][a-z0-9+.-]*$/i.test(target.slice(0, colon))) {
      return 'external-url';
    }
  }

  // Home-relative check: ~, ~/, ~\, $HOME, $HOME/, $HOME\
  if (
    target === '~' ||
    target.startsWith('~/') ||
    target.startsWith('~\\') ||
    target === '$HOME' ||
    target.startsWith('$HOME/') ||
    target.startsWith('$HOME\\')
  ) {
    return 'home-relative';
  }

  // Host-absolute check:
  // Starts with / (POSIX absolute, also valid on Windows)
  if (target.startsWith('/')) {
    return 'host-absolute';
  }

  // Windows-specific host absolute (drive letter or UNC). CommonMark only
  // backslash-unescapes ASCII punctuation, so `\s` stays literal and a single
  // leading backslash on a non-URL form is pragmatically treated as UNC.
  if (currentPlatform === 'win32') {
    if (/^[a-zA-Z]:[\\/]/.test(target) || /^\\+/.test(target)) {
      return 'host-absolute';
    }
  } else {
    // Even on non-Windows platforms, if path explicitly matches Windows drive or UNC, or if tested
    if (/^[a-zA-Z]:[\\/]/.test(target) || /^\\+/.test(target)) {
      return 'host-absolute';
    }
  }

  return 'workspace-relative';
}

/**
 * Resolves a host-style path (home-relative or host-absolute) to a normalized absolute path.
 */
export function resolveHostPath(target: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();

  if (target === '~' || target === '$HOME') {
    return normalize(home);
  }

  if (target.startsWith('~/') || target.startsWith('~\\')) {
    const rest = target.slice(2);
    return resolve(home, rest);
  }

  if (target.startsWith('$HOME/') || target.startsWith('$HOME\\')) {
    const rest = target.slice(6);
    return resolve(home, rest);
  }

  // host-absolute
  return normalize(target);
}

/**
 * Checks a host-style link destination against policy and filesystem reality.
 *
 * Returns null if targetPath is not a host link (e.g. workspace-relative or external-url).
 */
export function checkHostLink(
  targetPath: string,
  root: string,
  config: Config,
  homeDir?: string,
): HostLinkResult | null {
  const kind = classifyDestination(targetPath);
  if (kind !== 'home-relative' && kind !== 'host-absolute') {
    return null;
  }

  // Policy: forbidden
  if (config.links.allowHostPaths === 'forbidden') {
    return {
      isHostLink: true,
      diagnostic: {
        code: 'MDL403',
        severity: 'error',
        message: `Host path forbidden by policy: ${targetPath}`,
        data: { target: targetPath },
      },
    };
  }

  // If expandTilde is disabled and target is home-relative:
  // If expandTilde is false, we can't expand ~/$HOME, so treat as warning if policy allows warning
  if (!config.links.expandTilde && kind === 'home-relative') {
    return {
      isHostLink: true,
      diagnostic: {
        code: 'MDL403',
        severity: 'warning',
        message: `Host path is not portable across machines: ${targetPath}`,
        data: { target: targetPath },
      },
    };
  }

  const resolved = resolveHostPath(targetPath, homeDir);
  const exists = existsSync(resolved);

  if (!exists) {
    return {
      isHostLink: true,
      diagnostic: {
        code: 'MDL403',
        severity: 'warning',
        message: `Host path does not exist on this machine: ${targetPath}`,
        data: {
          target: targetPath,
          resolvedPath: resolved,
        },
      },
    };
  }

  // File exists physically. Check if resolved is inside workspace root.
  const absRoot = resolve(root);
  const rel = relative(absRoot, resolved);
  const isInsideWorkspace = !rel.startsWith('..') && !isAbsolute(rel);

  if (isInsideWorkspace) {
    if (config.links.allowHostPaths === 'always') {
      return {
        isHostLink: true,
      };
    }
    const portableSuggestion = rel.replace(/\\/g, '/');
    return {
      isHostLink: true,
      diagnostic: {
        code: 'MDL403',
        severity: 'warning',
        message: `Host path references a file inside workspace; suggest portable relative link: ${portableSuggestion}`,
        data: {
          target: targetPath,
          resolvedPath: resolved,
          suggestion: portableSuggestion,
        },
      },
    };
  }

  // File exists outside workspace.
  if (config.links.allowHostPaths === 'always') {
    return {
      isHostLink: true,
    };
  }

  // default / 'warning'
  return {
    isHostLink: true,
    diagnostic: {
      code: 'MDL403',
      severity: 'warning',
      message: `Host path is not portable across machines: ${targetPath}`,
      data: {
        target: targetPath,
        resolvedPath: resolved,
      },
    },
  };
}
