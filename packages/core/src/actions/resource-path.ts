import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';

const MAX_STEPS = 256;
const MAX_LINKS = 40;
const SEPARATORS = process.platform === 'win32' ? /[\\/]/ : /\//;

const missing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

type Component =
  | { readonly kind: 'directory' | 'file' | 'missing' | 'unreadable' }
  | { readonly kind: 'link'; readonly target: string };

function inspect(path: string): Component {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(path) };
    return { kind: stat.isDirectory() ? 'directory' : 'file' };
  } catch (error) {
    return { kind: missing(error) ? 'missing' : 'unreadable' };
  }
}

/**
 * A resource path must distinguish "no links" from "could not resolve". The legacy action
 * classifier's best-effort helper does not, so scope resources use this bounded component walk.
 * Missing components are allowed (a write may create them); every existing ancestor is still
 * inspected. Parent steps are applied only after following a preceding link.
 *
 * One resolver belongs to one bounded list of resource paths. Shared prefixes are inspected once,
 * and descendants of a missing directory need no filesystem calls. Never retain this cache between
 * tool calls: the next call must observe links or directories that were created or replaced.
 */
export function createResourcePathResolver(): (absolute: string) => string | null {
  const cache = new Map<string, Component>();
  const componentAt = (path: string): Component => {
    let component = cache.get(path);
    if (component === undefined) {
      component = inspect(path);
      cache.set(path, component);
    }
    return component;
  };

  return (absolute) => {
    if (!isAbsolute(absolute) || absolute.includes('\0')) return null;
    let current = parse(absolute).root;
    let parts = absolute.slice(current.length).split(SEPARATORS);
    let at = 0;
    let steps = 0;
    let links = 0;
    // How many components below the first absent directory the walk currently is. A `..`
    // can return to an existing ancestor, where inspecting links must resume immediately.
    let missingDepth = 0;
    while (at < parts.length) {
      if (++steps > MAX_STEPS) return null;
      const part = parts[at++]!;
      if (part === '' || part === '.') continue;
      if (part === '..') {
        current = dirname(current);
        if (missingDepth > 0) missingDepth -= 1;
        continue;
      }
      const next = join(current, part);
      if (missingDepth > 0) {
        missingDepth += 1;
        current = next;
        continue;
      }
      const component = componentAt(next);
      if (component.kind === 'unreadable') return null;
      if (component.kind === 'link') {
        if (++links > MAX_LINKS) return null;
        const { target } = component;
        const root = isAbsolute(target) ? parse(target).root : '';
        if (root !== '') current = root;
        parts = [...target.slice(root.length).split(SEPARATORS), ...parts.slice(at)];
        at = 0;
        continue;
      }
      if (component.kind === 'file' && at < parts.length) return null;
      if (component.kind === 'missing') missingDepth = 1;
      current = next;
    }
    if (missingDepth > 0) return current;
    // The path exists: ask once for the filesystem's canonical spelling. In particular, never
    // ask native realpath for every missing sibling: automount-backed prefixes can make it slow.
    try {
      return realpathSync.native(current);
    } catch {
      return null;
    }
  };
}

/** A single path gets a fresh view of the filesystem, just like a new resource list. */
export const resolveResourcePath = (absolute: string): string | null =>
  createResourcePathResolver()(absolute);
