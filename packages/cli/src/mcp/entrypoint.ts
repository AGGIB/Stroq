import { posix } from 'node:path';
import type { Tree } from '../install/types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The server's start file: --entrypoint, else package.json bin, else main. It must be a plain JS file of the tree. */
export function entrypointOf(tree: Tree, asked: string | undefined): string {
  let candidate = asked;
  if (candidate === undefined) {
    const manifest = tree.entries.find((entry) => entry.path === 'package.json');
    if (manifest?.bytes !== undefined) {
      try {
        const json = JSON.parse(Buffer.from(manifest.bytes).toString('utf8')) as {
          bin?: unknown;
          main?: unknown;
        };
        const bins =
          typeof json.bin === 'string'
            ? [json.bin]
            : isPlainObject(json.bin)
              ? Object.values(json.bin)
              : [];
        const first = bins.find((value): value is string => typeof value === 'string');
        candidate = first ?? (typeof json.main === 'string' ? json.main : undefined);
      } catch {
        candidate = undefined;
      }
    }
  }
  if (candidate === undefined)
    throw new Error('cannot tell the start file of this server; give --entrypoint <file>');
  const path = posix.normalize(candidate.replaceAll('\\', '/'));
  if (path.startsWith('../') || path.startsWith('/') || path === '.' || path === '..')
    throw new Error('the entrypoint must be a file inside the server folder');
  if (!/\.(?:js|mjs|cjs)$/.test(path))
    throw new Error('only a node server (.js, .mjs, .cjs) is supported');
  if (!tree.entries.some((entry) => entry.path === path && entry.kind === 'file'))
    throw new Error('the entrypoint is not a file of the inspected folder');
  return path;
}
