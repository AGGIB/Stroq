// What a package.json declares: what it launches, what npm runs when it is installed, and where its
// dependencies come from.
//
// These are `declared` lines: the package says so about itself. The lifecycle scripts are the ones npm
// runs on its own when a package is installed (and, for a package taken from a repository, built),
// which is where most attacks on a package manager have lived, so each one is a sensitive line. The
// text of every script is also read as shell. A dependency that does not come from a registry is a
// signal: what it fetches is whatever is at the address on the day it is installed.
import { addressOf } from './addresses.js';
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';
import { entriesOf, own, ownObject, ownString, parseJsonObject, type JsonObject } from './json.js';
import type { ShellQueue } from './shell-queue.js';
import type { TextFile } from './text-files.js';

/** The scripts npm runs by itself when a package is installed or prepared. */
export const LIFECYCLE_SCRIPTS: ReadonlySet<string> = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
]);
const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
];
/** The most scripts and dependencies of one package that are read. */
const MAX_ENTRIES = 500;

const LAUNCH_DETECTOR =
  'bin or main in package.json: how the package is started, as it declares itself';
const SCRIPT_DETECTOR =
  'a lifecycle script in package.json: npm runs it by itself when the package is installed, as the package declares';
const DEPENDENCY_DETECTOR =
  'a dependency in package.json that does not come from a registry: what it fetches is what is at the address when it is installed; a signal to look at, not a verdict';
const ADDRESS_DETECTOR = 'the address of a dependency in package.json, as the package declares it';
const UNREADABLE_DETECTOR =
  'the file could not be parsed as a manifest, so what it declares is not known; a signal to look at, not a verdict';

export const isPackageJson = (path: string): boolean =>
  path === 'package.json' || path.endsWith('/package.json');

/** The line of a key in the text of a file, found by the first place it is written; 1 when it cannot be found. */
function lineOfKey(file: TextFile, key: string, from = 0): number {
  const at = file.text.indexOf(JSON.stringify(key), from);
  return at === -1 ? 1 : file.lines.lineAt(at);
}

/** The name npm gives a bin when it is written as a path: the package's own name, without its scope. */
function binNameOf(manifest: JsonObject): string {
  const name = ownString(manifest, 'name') ?? 'package';
  return name.slice(name.lastIndexOf('/') + 1);
}

function launchLines(file: TextFile, manifest: JsonObject, findings: Findings): void {
  const bin = own(manifest, 'bin');
  const names =
    typeof bin === 'string'
      ? [binNameOf(manifest)]
      : bin !== null && typeof bin === 'object' && !Array.isArray(bin)
        ? Object.keys(bin).sort().slice(0, MAX_ENTRIES)
        : [];
  const line = names.length > 0 ? lineOfKey(file, 'bin') : 1;
  for (const name of names) {
    findings.line({
      kind: 'exec',
      subject: `bin ${name}`,
      basis: 'declared',
      sensitive: true,
      file: file.path,
      line,
      detector: LAUNCH_DETECTOR,
    });
  }
  const main = ownString(manifest, 'main');
  if (main !== null) {
    findings.line({
      kind: 'exec',
      subject: `main ${main}`,
      basis: 'declared',
      sensitive: false,
      file: file.path,
      line: lineOfKey(file, 'main'),
      detector: LAUNCH_DETECTOR,
    });
  }
}

function scriptLines(
  file: TextFile,
  manifest: JsonObject,
  findings: Findings,
  shell: ShellQueue,
): void {
  const scripts = ownObject(manifest, 'scripts');
  if (scripts === null) return;
  const scriptsAt = Math.max(0, file.text.indexOf('"scripts"'));
  for (const [name, text] of entriesOf(scripts).slice(0, MAX_ENTRIES)) {
    if (typeof text !== 'string') continue;
    const line = lineOfKey(file, name, scriptsAt);
    const lifecycle = LIFECYCLE_SCRIPTS.has(name);
    if (lifecycle) {
      findings.line({
        kind: 'install-script',
        subject: `${name}: ${text}`,
        basis: 'declared',
        sensitive: true,
        file: file.path,
        line,
        detector: SCRIPT_DETECTOR,
      });
    }
    shell.add({
      file: file.path,
      line,
      text,
      origin: lifecycle ? 'script' : 'package-script',
    });
  }
}

function dependencyLines(file: TextFile, manifest: JsonObject, findings: Findings): void {
  let any = false;
  for (const field of DEPENDENCY_FIELDS) {
    const group = ownObject(manifest, field);
    if (group === null) continue;
    any = any || Object.keys(group).length > 0;
    for (const [name, spec] of entriesOf(group).slice(0, MAX_ENTRIES)) {
      const address = typeof spec === 'string' ? addressOf(spec) : null;
      if (address === null) continue;
      const line = lineOfKey(file, name, Math.max(0, file.text.indexOf(`"${field}"`)));
      findings.signal({
        ruleId: 'non-registry-dependency',
        file: file.path,
        line,
        sensitive: true,
        detail: `${name} (${address.kind}, ${address.display})`,
        basis: 'declared',
        detector: DEPENDENCY_DETECTOR,
      });
      if (address.host !== null) {
        findings.line({
          kind: 'net',
          subject: address.host,
          basis: 'declared',
          sensitive: true,
          file: file.path,
          line,
          detector: ADDRESS_DETECTOR,
        });
      }
    }
  }
  if (any) findings.tally('dependencies');
}

export function inspectPackages(input: InspectInput, findings: Findings, shell: ShellQueue): void {
  for (const file of input.texts) {
    if (!isPackageJson(file.path)) continue;
    const manifest = parseJsonObject(file.text);
    if (manifest === null) {
      findings.tally('unreadable-manifest');
      findings.signal({
        ruleId: 'manifest-unreadable',
        file: file.path,
        line: 1,
        sensitive: false,
        detail: 'package.json',
        detector: UNREADABLE_DETECTOR,
      });
      continue;
    }
    launchLines(file, manifest, findings);
    scriptLines(file, manifest, findings, shell);
    dependencyLines(file, manifest, findings);
  }
}
