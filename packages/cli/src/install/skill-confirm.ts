import { renderPassport } from '../commands/vet-render.js';
import { confirm, confirmTyped } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import type { Terminal } from '../ui/terminal.js';
import { outsideLine } from '../ui/layout.js';
import type { SkillRecord } from './lock.js';
import { changedFiles } from './material.js';
import type { Passport, Tree } from './types.js';

interface SkillConfirmation {
  readonly name: string;
  readonly target: { readonly path: string };
  readonly previous: SkillRecord | undefined;
  readonly restoring: boolean;
  readonly made: { readonly passport: Passport; readonly tree: Tree };
  readonly material: boolean;
  readonly oldTree: Tree | undefined;
}

export async function confirmSkill(terminal: Terminal, prepared: SkillConfirmation): Promise<void> {
  const { name, target, previous, restoring, made, material, oldTree } = prepared;
  const passport = made.passport;
  terminal.write(`Install ${name} to ${outsideLine(JSON.stringify(target.path))}\n`);
  if (previous !== undefined) {
    terminal.write(
      `Replaces ${name} from ${outsideLine(JSON.stringify(previous.source))}\nPrevious sha256:${previous.digest}\n`,
    );
    if (oldTree !== undefined) {
      for (const file of changedFiles(oldTree, made.tree))
        terminal.write(`  ${file.change} ${file.path}\n`);
    }
    const oldLines = new Set(previous.passport.lines.map((line) => JSON.stringify(line)));
    for (const line of passport.lines.filter((line) => !oldLines.has(JSON.stringify(line))))
      terminal.write(
        `  new passport line: ${line.kind} ${JSON.stringify(line.subject)} (${line.basis})\n`,
      );
  }
  if (restoring)
    terminal.write(
      'Restore replaces the installed folder and discards outside edits permanently.\n',
    );
  terminal.write(renderPassport(passport));
  const confirmed =
    material || restoring
      ? await confirmTyped(terminal, passport.artifact.digest)
      : await confirm(terminal, styleFor(terminal), 'Apply this update?', false);
  if (!confirmed) throw new Error('not confirmed; the installed skill was kept');
}
