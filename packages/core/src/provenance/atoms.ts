import { createHash } from 'node:crypto';
import type { Atom } from '../types.js';

/** Upper bound on atoms extracted from one text (first N in text order, after dedupe). */
export const MAX_ATOMS = 200;
const MAX_VALUE_CHARS = 512;

const URL = /https?:\/\/[^\s"'<>()[\]`]+/gi;
const TRAILING_PUNCT = /[.,;:!?'"]+$/;
const URL_HOST = /^https?:\/\/(?:[^@/\s]+@)?([^/:?#\s]+)/;
// `user@host.tld` — ssh/scp targets and git ssh remotes.
const SSH_TARGET = /(?<![\w.-])[\w.-]+@((?:[\w-]+\.)+[a-z]{2,})(?![\w.-])/gi;
// Package runners: the first positional token after them is the package.
const RUNNER = /(?<![\w./-])(?:npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx|pipx\s+run)(?=\s)/g;
// Package installers: every positional token after them is a package.
const INSTALLER =
  /(?<![\w./-])(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install)|yarn\s+add|pip3?\s+install|uv\s+add|uv\s+pip\s+install|pipx\s+install|cargo\s+install|gem\s+install|go\s+install|brew\s+install)(?=\s)/g;
const LINE_END = /[\n|;`]|&&|\|\|/;
const FLAGS_WITH_VALUE = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-t',
  '--target',
  '--registry',
  '--prefix',
]);
const PACKAGE_FLAGS = new Set(['-p', '--package']);
// curl/wget piped into a shell, and `sh <(curl ...)` process substitution.
const PIPE_SHELL =
  /\b(?:curl|wget)\b[^\n|;&`]*\|\s*(?:sudo\s+(?:-E\s+)?)?(?:ba|z|da|k)?sh\b(?:\s+-[a-z]+)?/gi;
const PROC_SUB_SHELL = /\b(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b[^)\n]*\)/gi;
// Base64 runs of 24+ chars; `looksBase64` then requires mixed case plus a digit/symbol and rejects hex.
const BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/g;
const HEX = /^[0-9a-fA-F]+$/;

export function normalizePackageName(raw: string): string {
  const name = raw.replace(/^["']+|["']+$/g, '');
  const at = name.startsWith('@') ? name.indexOf('@', 1) : name.indexOf('@');
  const base = at > 0 ? name.slice(0, at) : name;
  return base.replace(/[[<>=!~;].*$/, '').toLowerCase();
}

function restOfLine(text: string, from: number): string {
  const rest = text.slice(from);
  const stop = rest.search(LINE_END);
  return (stop === -1 ? rest : rest.slice(0, stop)).trim();
}

function isPackageToken(token: string): boolean {
  return (
    token !== '' &&
    !token.startsWith('-') &&
    !token.startsWith('.') &&
    !token.startsWith('/') &&
    !token.startsWith('$') &&
    !token.includes('://')
  );
}

/** The single package a runner (`npx`, `pnpm dlx`, …) resolves: `-p <pkg>` wins, else the first positional. */
function runnerPackage(tokens: readonly string[]): string | null {
  let fromFlag: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (PACKAGE_FLAGS.has(token)) {
      const value = tokens[i + 1] ?? '';
      if (isPackageToken(value)) fromFlag = value;
      i += 1;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return fromFlag ?? (isPackageToken(token) ? token : null);
  }
  return fromFlag;
}

function installerPackages(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (FLAGS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (isPackageToken(token)) out.push(token);
  }
  return out;
}

function packageNames(text: string): string[] {
  const runners = [...text.matchAll(RUNNER)].flatMap((m) => {
    const pkg = runnerPackage(restOfLine(text, (m.index ?? 0) + m[0].length).split(/\s+/));
    return pkg === null ? [] : [pkg];
  });
  const installs = [...text.matchAll(INSTALLER)].flatMap((m) =>
    installerPackages(restOfLine(text, (m.index ?? 0) + m[0].length).split(/\s+/)),
  );
  return [...runners, ...installs];
}

function urlAtoms(text: string): Atom[] {
  const fromUrls = [...text.matchAll(URL)].flatMap((m): Atom[] => {
    const url = m[0].replace(TRAILING_PUNCT, '').toLowerCase();
    const host = URL_HOST.exec(url)?.[1];
    return host
      ? [
          { kind: 'url', value: url },
          { kind: 'host', value: host },
        ]
      : [{ kind: 'url', value: url }];
  });
  const fromSsh = [...text.matchAll(SSH_TARGET)].map((m): Atom => ({
    kind: 'host',
    value: (m[1] ?? '').toLowerCase(),
  }));
  return [...fromUrls, ...fromSsh];
}

function packageAtoms(text: string): Atom[] {
  return packageNames(text)
    .map(normalizePackageName)
    .filter((name) => name.length > 0)
    .map((value): Atom => ({ kind: 'pkg', value }));
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function pipeShellAtoms(text: string): Atom[] {
  return [...text.matchAll(PIPE_SHELL), ...text.matchAll(PROC_SUB_SHELL)].map((m): Atom => ({
    kind: 'pipe_shell',
    value: collapse(m[0]),
  }));
}

function looksBase64(token: string): boolean {
  const body = token.replace(/=+$/, '');
  return !HEX.test(body) && /[a-z]/.test(body) && /[A-Z]/.test(body) && /[0-9+/]/.test(body);
}

function encodedAtoms(text: string): Atom[] {
  return [...text.matchAll(BASE64)]
    .map((m) => m[0])
    .filter(looksBase64)
    .map((value): Atom => ({ kind: 'encoded', value }));
}

export function atomHash(atom: Atom): string {
  return createHash('sha256').update(`${atom.kind}\n${atom.value}`).digest('hex').slice(0, 32);
}

/**
 * Extracts actionable atoms — the pieces of text an agent could copy into a
 * dangerous action — in text order, deduped, capped at MAX_ATOMS. Prose that
 * merely mentions `npx` yields harmless junk atoms (they only matter if the
 * exact same value later appears in a real action), so no attempt is made to
 * tell prose from code.
 */
export function extractAtoms(text: string): Atom[] {
  const all = [
    ...urlAtoms(text),
    ...packageAtoms(text),
    ...pipeShellAtoms(text),
    ...encodedAtoms(text),
  ].map((atom): Atom => ({ ...atom, value: atom.value.slice(0, MAX_VALUE_CHARS) }));
  const seen = new Set<string>();
  const unique: Atom[] = [];
  for (const atom of all) {
    const key = `${atom.kind}\n${atom.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(atom);
    if (unique.length >= MAX_ATOMS) break;
  }
  return unique;
}
