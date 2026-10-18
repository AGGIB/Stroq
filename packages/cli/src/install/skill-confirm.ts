import { labelOf } from '../commands/vet-flow.js';
import { confirmationScreen } from '../commands/vet-render.js';
import { confirm, confirmTyped } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import type { Terminal } from '../ui/terminal.js';
import { outsideLine } from '../ui/layout.js';
import { stroqVersion } from '../version.js';
import { readArchiveFile } from './archive-file.js';
import {
  inspectTree,
  INSPECT_RULES_ID,
  InspectError,
  passportIsIncomplete,
} from './inspect/index.js';
import type { SkillRecord } from './lock.js';
import { readDirTree } from './read-dir.js';
import { sourceTypeOf } from './read-source.js';
import { assertInstallablePlatform, assertWritableTree } from './store.js';
import { updateDiffLines } from './update-diff.js';
import type { Passport, Tree } from './types.js';

function passportOfSkill(
  tree: Tree,
  source: string,
  type: 'dir' | 'tarball',
  blindSpots: readonly string[],
  kind: 'skill' | undefined,
): Passport {
  try {
    return inspectTree(tree, {
      kind: kind ?? 'auto',
      source: { type, label: labelOf(source, type) },
      extraBlindSpots: blindSpots,
      stroqVersion: stroqVersion(),
      rulesId: INSPECT_RULES_ID,
    });
  } catch (error) {
    if (error instanceof InspectError && error.code === 'cannot-tell-kind')
      throw new Error(
        `${error.message}; give --kind skill (or --kind mcp for a server) to stroq add`,
      );
    throw error;
  }
}

export async function inspectSkillSource(
  source: string,
  kind: 'skill' | undefined,
): Promise<{ tree: Tree; passport: Passport }> {
  const type = await sourceTypeOf(source);
  const { tree, blindSpots } =
    type === 'dir'
      ? await readDirTree(source, { rejectNestedRepositories: true })
      : await readArchiveFile(source);
  const passport = passportOfSkill(tree, source, type, blindSpots, kind);
  if (passport.artifact.kind === 'mcp')
    throw new Error(
      'this folder is an MCP server, not a skill: add it with --kind mcp and the client it is for (--client <name> or --config <path>)',
    );
  if (passport.artifact.kind !== 'skill')
    throw new Error(
      `this folder is a ${passport.artifact.kind}, which add does not install: read it with stroq vet --from <folder>`,
    );
  if (passportIsIncomplete(passport))
    throw new Error('the passport is incomplete; refusing to install');
  assertWritableTree(tree, passport.artifact.digest);
  assertInstallablePlatform(tree, process.platform);
  return { tree, passport };
}

interface SkillConfirmation {
  readonly name: string;
  /** Where the bytes were read from, for the command that lists everything when the screen cannot. */
  readonly source: string;
  readonly target: { readonly path: string };
  readonly previous: SkillRecord | undefined;
  readonly restoring: boolean;
  readonly made: { readonly passport: Passport; readonly tree: Tree };
  readonly material: boolean;
  readonly oldTree: Tree | undefined;
}

export async function confirmSkill(terminal: Terminal, prepared: SkillConfirmation): Promise<void> {
  const { name, source, target, previous, restoring, made, material, oldTree } = prepared;
  const passport = made.passport;
  // Before a word is written: an artifact whose sensitive lines do not all fit is not asked about.
  const screen = confirmationScreen(passport, source);
  terminal.write(`Install ${name} to ${outsideLine(JSON.stringify(target.path))}\n`);
  if (previous !== undefined) {
    terminal.write(
      `Replaces ${name} from ${outsideLine(JSON.stringify(previous.source))}\nPrevious sha256:${previous.digest}\n`,
    );
    if (oldTree !== undefined) {
      for (const line of updateDiffLines(oldTree, made.tree)) terminal.write(`${line}\n`);
    }
    const oldLines = new Set(previous.passport.lines.map((line) => JSON.stringify(line)));
    for (const line of passport.lines.filter((line) => !oldLines.has(JSON.stringify(line))))
      terminal.write(
        `  new passport line: ${line.kind} ${outsideLine(JSON.stringify(line.subject))} (${line.basis})\n`,
      );
  }
  if (restoring)
    terminal.write(
      'Restore replaces the installed folder and discards outside edits permanently.\n',
    );
  terminal.write(screen);
  const confirmed =
    material || restoring
      ? await confirmTyped(terminal, passport.artifact.digest)
      : await confirm(terminal, styleFor(terminal), 'Apply this update?', false);
  if (!confirmed) throw new Error('not confirmed; the installed skill was kept');
}
