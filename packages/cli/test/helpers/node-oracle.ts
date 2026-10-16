import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll } from 'vitest';

/**
 * Node itself as the oracle for "which modules does this file ask for". A snippet is written to a folder as
 * `.mjs`, `.cjs` or `.js` (beside a `package.json` that says `module` or `commonjs`) and run by a child node
 * that loads `register.mjs` first. That file installs resolve hooks (`module.registerHooks`, which see both
 * `import` and `require`) that record every specifier Node asks to resolve from the snippet, and answer a
 * package by name with an empty stub, so that the snippet goes on to its next import instead of stopping at
 * the first one that is not installed. What the hooks recorded is what Node did, whatever the text looked like.
 */
export type Variant = 'mjs' | 'cjs' | 'js-module' | 'js-commonjs';

/** `registerHooks` is in Node 22.15 and later; with an older Node there is no oracle and the tests skip. */
export const oracleAvailable =
  typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function';

const REGISTER = `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const stub = new URL('./stub.cjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === undefined) return nextResolve(specifier, context);
    appendFileSync(process.env.ORACLE_LOG, JSON.stringify(specifier) + '\\n');
    if (/^(?:\\.{0,2}\\/|node:|file:|data:)/.test(specifier)) return nextResolve(specifier, context);
    return { url: stub, shortCircuit: true, format: 'commonjs' };
  },
});
`;

/** A child that has not finished by then is reported as such: an empty log would read as "Node asked for nothing". */
export const CASE_TIMEOUT_MS = 90_000;
const roots: string[] = [];
let ready: Promise<string> | null = null;

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function oracleRoot(): Promise<string> {
  ready ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'stroq-node-oracle-'));
    roots.push(root);
    await writeFile(join(root, 'register.mjs'), REGISTER);
    await writeFile(join(root, 'stub.cjs'), 'module.exports = {};\n');
    return root;
  })();
  return ready;
}

function run(entry: string, log: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ORACLE_LOG: log };
    delete env['NODE_OPTIONS'];
    const root = join(entry, '..', '..');
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(join(root, 'register.mjs')).href, entry],
      { env, stdio: 'ignore', timeout: CASE_TIMEOUT_MS },
    );
    child.on('error', reject);
    // The exit code is not asked about: a snippet may well end in an error after the imports it makes. A child
    // that was killed for taking too long is: what it logged is not what Node would have asked.
    child.on('close', (_code, signal) =>
      signal === null
        ? resolve()
        : reject(
            new Error(
              `node was stopped (${signal}) after ${CASE_TIMEOUT_MS} ms; its log is not an answer`,
            ),
          ),
    );
  });
}

/**
 * Whether this Node parses a syntax that only some versions have (`import source x from '...'`, `import defer *
 * as ns from '...'`): asked of Node itself, by whether it resolves the module the statement names.
 */
export async function nodeParses(statement: string): Promise<boolean> {
  return (await askNode(statement, 'mjs')).includes('zzprobe');
}

/** Every specifier Node asked to resolve from `code`, in the order it asked. */
export async function askNode(code: string, variant: Variant): Promise<string[]> {
  const root = await oracleRoot();
  const dir = await mkdtemp(join(root, 'case-'));
  const module = variant === 'js-module' || variant === 'mjs';
  const entry = join(dir, variant.startsWith('js') ? 'entry.js' : `entry.${variant}`);
  const log = join(dir, 'log.txt');
  await mkdir(dir, { recursive: true });
  if (variant.startsWith('js-'))
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ type: module ? 'module' : 'commonjs' }),
    );
  await writeFile(entry, code);
  await writeFile(log, '');
  await run(entry, log);
  const lines = (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
  await rm(dir, { recursive: true, force: true });
  return lines.map((line) => JSON.parse(line) as string);
}
