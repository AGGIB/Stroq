// Where shell text is found in a tree: documents, files of shell, and the files that run at the
// edge of a repository (git hooks of husky, a direnv file). Each only finds text and queues it with
// its place; `shell-lines.ts` reads it.
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';
import { readMarkdownShell } from './markdown-shell.js';
import type { ShellQueue } from './shell-queue.js';
import type { TextFile } from './text-files.js';

const MARKDOWN = /\.(?:md|markdown|mdx)$/i;
const SHELL_EXTENSION = /\.(?:sh|bash|zsh|ksh|ps1|bat|cmd)$/i;
const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'csh',
  'tcsh',
]);

/** The interpreter a `#!` line names: `bash` for `#!/bin/bash` and for `#!/usr/bin/env -S bash -e`. */
export function shebangInterpreter(text: string): string | null {
  if (!text.startsWith('#!')) return null;
  const newline = text.indexOf('\n');
  const line = (newline === -1 ? text : text.slice(0, newline)).slice(2, 300).trim();
  const words = line.split(/\s+/);
  const first = words[0] ?? '';
  const name = first.slice(first.lastIndexOf('/') + 1);
  if (name !== 'env') return name === '' ? null : name;
  const next = words.slice(1).find((word) => !word.startsWith('-') && !word.includes('='));
  return next === undefined ? null : next.slice(next.lastIndexOf('/') + 1);
}

/** Whether a file is shell: by its name, or by the interpreter it names. */
function isShellFile(file: TextFile): boolean {
  if (SHELL_EXTENSION.test(file.path)) return true;
  const interpreter = shebangInterpreter(file.text);
  return interpreter !== null && SHELLS.has(interpreter);
}

/** A file that runs on an event of the repository: a husky hook, or the file direnv loads. */
function isEdgeScript(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (name === '.envrc') return true;
  return (
    parts.length >= 2 &&
    parts[parts.length - 2] === '.husky' &&
    !name.startsWith('_') &&
    !name.startsWith('.')
  );
}

/** The shell in the documents: tagged blocks, and inline commands. */
export function queueMarkdownShell(
  input: InspectInput,
  findings: Findings,
  shell: ShellQueue,
): void {
  for (const file of input.texts) {
    if (!MARKDOWN.test(file.path)) continue;
    const found = readMarkdownShell(file.text);
    if (found.untagged > 0) findings.tally('untagged-fence', found.untagged);
    for (const block of found.blocks) {
      if (block.cut) findings.tally('shell-text-cut');
      shell.add({ file: file.path, line: block.line, text: block.text, origin: 'doc' });
    }
    for (const command of found.inline) {
      shell.add({ file: file.path, line: command.line, text: command.text, origin: 'inline' });
    }
  }
}

/** The shell in files of shell, and in the files that run at the edge of a repository. */
export function queueScriptShell(input: InspectInput, shell: ShellQueue): void {
  for (const file of input.texts) {
    if (MARKDOWN.test(file.path)) continue;
    if (isShellFile(file) || isEdgeScript(file.path)) {
      shell.add({ file: file.path, line: 1, text: file.text, origin: 'script' });
    }
  }
}
