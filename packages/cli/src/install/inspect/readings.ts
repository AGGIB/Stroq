// The readings of a tree, each under a fixed name, and the way a failed one is told.
//
// A reading is one pass over the files that adds lines to the passport. They run one after another and
// share a queue of shell text (see `shell-queue.ts`), which the last of them reads. Each is run on its
// own: a reading that throws (a stack that is too deep for a hostile file, a fault in the code) does
// not stop the others. But a passport made that way lacks what the reading finds, and an artifact that
// could make one reading fail would otherwise hide a use from the passport, so the failure is told as
// loudly as a finding: a sensitive signal and a blind spot that name the reading, and a passport that
// `passportIsIncomplete` says is not complete.
import type { ReadingName } from './blind-spots.js';
import type { Findings } from './findings.js';
import { inspectFrontmatter } from './frontmatter-lines.js';
import type { DeclaredHint } from './identity.js';
import type { InspectInput } from './input.js';
import { inspectManifests } from './manifest-lines.js';
import { inspectNativeCode } from './native-code.js';
import { inspectPackages } from './package-lines.js';
import { inspectPython } from './python-lines.js';
import { inspectRepoFiles } from './repo-files.js';
import { addShellLines } from './shell-lines.js';
import type { ShellQueue } from './shell-queue.js';
import { queueMarkdownShell, queueScriptShell } from './shell-sources.js';
import { inspectObfuscation, inspectSource } from './source-lines.js';
import { inspectTreeEntries } from './tree-checks.js';

/** What a reading is given, and the one thing it may hand on: what the artifact calls itself. */
export interface ReadContext {
  readonly input: InspectInput;
  readonly findings: Findings;
  readonly shell: ShellQueue;
  declared: DeclaredHint;
}

export interface NamedReading {
  readonly name: ReadingName;
  readonly run: (context: ReadContext) => void;
}

/** The readings in the order they are made. The shell text they queue is read by the last. */
export const READINGS: readonly NamedReading[] = [
  {
    name: 'frontmatter',
    run: (c) => {
      c.declared = inspectFrontmatter(c.input, c.findings, c.shell);
    },
  },
  { name: 'markdown', run: (c) => queueMarkdownShell(c.input, c.findings, c.shell) },
  { name: 'script-files', run: (c) => queueScriptShell(c.input, c.shell) },
  { name: 'package-json', run: (c) => inspectPackages(c.input, c.findings, c.shell) },
  { name: 'manifests', run: (c) => inspectManifests(c.input, c.findings, c.shell) },
  { name: 'python', run: (c) => inspectPython(c.input, c.findings) },
  { name: 'native-code', run: (c) => inspectNativeCode(c.input, c.findings) },
  { name: 'source', run: (c) => inspectSource(c.input, c.findings) },
  { name: 'obfuscation', run: (c) => inspectObfuscation(c.input, c.findings) },
  { name: 'repo-files', run: (c) => inspectRepoFiles(c.input, c.findings) },
  { name: 'tree-entries', run: (c) => inspectTreeEntries(c.input, c.findings) },
  { name: 'shell', run: (c) => addShellLines(c.shell, c.findings) },
];

/** Runs the readings, each on its own; one that throws is told in the findings by its name. */
export function runReadings(context: ReadContext, readings: readonly NamedReading[]): void {
  for (const reading of readings) {
    try {
      reading.run(context);
    } catch {
      // Whatever the fault was, the reading is missing, and that is all the passport says of it:
      // the exception may hold text of the artifact, and none of it goes in the passport.
      context.findings.failedReading(reading.name);
    }
  }
}
