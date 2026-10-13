// Files of a repository that run, or reach out, without anyone starting them.
//
// A dev container runs commands when it is opened, a husky hook when someone commits, a direnv file
// when someone enters the folder, an editor task when a folder is opened, and a submodule is another
// repository fetched from an address. None of that is something a skill or a server needs, and each is
// a place where a malicious change has hidden before, so each is a signal. The text of the hooks and
// of the direnv file is also read as shell (see `shell-sources.ts`). What an editor task or a
// dev container command does is not read here: the file is JSON with comments, and the signal is that
// it is there. The checks for `.vscode` and for the settings of git come from the firewall's own readers.
import { editorAutorunText } from '@stroq/core';
import { gitConfigEntries } from '../../exposure/repo-surface.js';
import { addressOf } from './addresses.js';
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';
import type { TextFile } from './text-files.js';

const NOT_A_VERDICT = 'a signal to look at, not a verdict';
const DEVCONTAINER_KEYS =
  /"(initializeCommand|onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand|postAttachCommand)"\s*:/g;
/** The key that runs on the machine that opens the folder, before any container exists. */
const HOST_KEY = 'initializeCommand';
const DRIVER = /(?:^|\s)(filter|diff|merge)=([\w.-]+)/g;
const MAX_DRIVERS = 100;
const MAX_SUBMODULES = 200;

const inFolder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`) || path.includes(`/${folder}/`);

function devcontainerLines(file: TextFile, findings: Findings): void {
  const keys = new Set<string>();
  for (const match of file.text.matchAll(DEVCONTAINER_KEYS)) {
    if (match[1] !== undefined) keys.add(match[1]);
  }
  const sorted = [...keys].sort();
  findings.signal({
    ruleId: 'devcontainer',
    file: file.path,
    line: null,
    sensitive: sorted.length > 0,
    basis: sorted.length > 0 ? 'declared' : 'observed',
    detail: sorted.join(', '),
    detector: keys.has(HOST_KEY)
      ? `a dev container that runs commands when it is opened, one of them (initializeCommand) on the machine that opens it, before there is a container; ${NOT_A_VERDICT}`
      : `a dev container, which may run commands when it is opened; ${NOT_A_VERDICT}`,
  });
}

function husky(path: string): string | null {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  const folder = parts[parts.length - 2];
  return folder === '.husky' && !name.startsWith('_') && !name.startsWith('.') ? name : null;
}

function submoduleLines(file: TextFile, findings: Findings): void {
  let found = 0;
  for (const { key, value } of gitConfigEntries(file.text)) {
    if (!key.startsWith('submodule.') || !key.endsWith('.url')) continue;
    if (found >= MAX_SUBMODULES) {
      findings.tally('list-cut');
      return;
    }
    found += 1;
    const name = key.slice('submodule.'.length, key.length - '.url'.length);
    const address = addressOf(value);
    const line = file.lines.lineAt(Math.max(0, file.text.indexOf(value)));
    findings.signal({
      ruleId: 'submodule',
      file: file.path,
      line,
      sensitive: true,
      basis: 'declared',
      detail: `${name} (${address === null ? 'an address that could not be read' : address.display})`,
      detector: `a submodule: another repository, fetched from an address, which a clone with submodules puts in the tree; ${NOT_A_VERDICT}`,
    });
    if (address?.host != null) {
      findings.line({
        kind: 'net',
        subject: address.host,
        basis: 'declared',
        sensitive: true,
        file: file.path,
        line,
        detector: 'the address of a submodule in .gitmodules, as the repository declares it',
      });
    }
  }
}

function driverLines(file: TextFile, findings: Findings): void {
  let found = 0;
  for (const match of file.text.matchAll(DRIVER)) {
    if (found >= MAX_DRIVERS) {
      findings.tally('list-cut');
      return;
    }
    found += 1;
    findings.signal({
      ruleId: 'gitattributes-driver',
      file: file.path,
      line: file.lines.lineAt(match.index ?? 0),
      sensitive: false,
      detail: `${match[1]}.${match[2]}`,
      detector: `a driver named in .gitattributes: git runs the command a configuration defines for it, and the tree carries no configuration; ${NOT_A_VERDICT}`,
    });
  }
}

/** Checks the files of the tree that act on their own. */
export function inspectRepoFiles(input: InspectInput, findings: Findings): void {
  for (const file of input.texts) {
    const path = file.path;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (path === '.devcontainer.json' || inFolder(path, '.devcontainer')) {
      devcontainerLines(file, findings);
    }
    const hook = husky(path);
    if (hook !== null) {
      findings.signal({
        ruleId: 'husky-hook',
        file: path,
        line: null,
        sensitive: true,
        detail: hook,
        detector: `a husky hook: a script that git runs on an event of the repository once husky is set up; ${NOT_A_VERDICT}`,
      });
    }
    if (name === '.envrc') {
      findings.signal({
        ruleId: 'envrc',
        file: path,
        line: null,
        sensitive: true,
        detector: `an .envrc: direnv runs it when a person enters the folder and has allowed it; ${NOT_A_VERDICT}`,
      });
    }
    const editor = inFolder(path, '.vscode') || path.endsWith('.code-workspace');
    if (editor && editorAutorunText(path, file.text)) {
      findings.signal({
        ruleId: 'editor-autorun',
        file: path,
        line: null,
        sensitive: true,
        detector: `an editor task that runs when the folder is opened; ${NOT_A_VERDICT}`,
      });
    }
    if (name === '.gitmodules') submoduleLines(file, findings);
    if (name === '.gitattributes') driverLines(file, findings);
  }
}
