import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { Terminal } from '../../src/ui/terminal.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stroq-add-'));
  roots.push(root);
  const source = join(root, 'demo');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const stroqHome = join(home, '.stroq');
  await Promise.all([mkdir(source), mkdir(project), mkdir(home)]);
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo\n---\n# Demo\nRead the project.\n',
  );
  let output = '';
  let prompts = 0;
  const questions: string[] = [];
  const terminal: Terminal = {
    interactive: true,
    color: false,
    color256: false,
    unicode: false,
    columns: 80,
    write: (text) => {
      output += text;
    },
    readLine: async (prompt) => {
      prompts += 1;
      questions.push(prompt);
      return /12/.test(prompt)
        ? [...output.matchAll(/sha256:([0-9a-f]{64})/g)].at(-1)![1]!.slice(0, 12)
        : 'y';
    },
  };
  const options = { project, home, stroqHome, terminal };
  return {
    root,
    source,
    options,
    terminal,
    output: () => output,
    prompts: () => prompts,
    questions,
  };
}
