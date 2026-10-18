import { describe, expect, it } from 'vitest';
import { extractActionAtoms, extractAtoms } from '../../src/provenance/atoms.js';

// The commands that fetch or install a package are one table, read the same way from a page and
// from a command: the same verbs, the same spellings. A command is read by its words, so the
// global options between the tool and its verb, and a tool spelled with a path or quotes, are
// still the tool.

const NAME = 'evil-helper-fix';
const pkg = { kind: 'pkg', value: NAME };
const packages = (command: string): string[] =>
  extractActionAtoms(command)
    .atoms.filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

describe('global options between the tool and its verb', () => {
  it.each([
    `npm --prefix app install ${NAME}`,
    `npm -g i ${NAME}`,
    `npm --no-audit install ${NAME}`,
    `npm --loglevel=error install ${NAME}`,
    `npm --workspace=web install ${NAME}`,
    `npm -w web i ${NAME}`,
    `npm --registry https://registry.example.test/ i ${NAME}`,
    `pnpm -C app dlx ${NAME}`,
    `pnpm --filter app add ${NAME}`,
    `pnpm -r add ${NAME}`,
    `pnpm --silent dlx ${NAME}`,
    `pnpm --reporter silent dlx ${NAME}`,
    `pnpm --store-dir /tmp/s add ${NAME}`,
    `yarn --cwd app add ${NAME}`,
    `bun --cwd app add ${NAME}`,
    `pip -q install ${NAME}`,
    `pip --quiet install ${NAME}`,
    `pip --disable-pip-version-check install ${NAME}`,
    `pip --python /usr/bin/python3 install ${NAME}`,
    `python -m pip --quiet install ${NAME}`,
    `cargo +nightly install ${NAME}`,
    `uv --quiet pip install ${NAME}`,
    `uv --directory app add ${NAME}`,
    `uv --project app tool run ${NAME}`,
    `sudo npm --prefix app install ${NAME}`,
  ])('are skipped: %s', (command) => {
    expect(packages(command)).toContain(NAME);
    expect(extractActionAtoms(command).unread).toBe(false);
  });

  it('does not make a different subcommand an installer', () => {
    for (const command of [
      'npm --prefix app run build',
      'pnpm -C app run dev',
      'pip -q list',
      'pip --quiet freeze',
      'cargo +nightly build',
      'yarn --cwd app test',
    ])
      expect(packages(command), command).toEqual([]);
  });

  it('is a doubt, in a command, when an unknown option has a value before the verb', () => {
    const read = extractActionAtoms(`npm --some-new-flag value install ${NAME}`);
    expect(read.atoms).toContainEqual(pkg);
    expect(read.unread).toBe(true);
    expect(read.unreadCause).toBe('name');
  });

  it('is no doubt when the same words are a mention', () => {
    const read = extractActionAtoms(`echo "npm --some-new-flag value install ${NAME}"`);
    expect(read.unread).toBe(false);
  });
});

describe('a tool spelled with a path, quotes or an extension', () => {
  it.each([
    `/usr/local/bin/npx ${NAME}`,
    `./node_modules/.bin/npx ${NAME}`,
    `~/.nvm/versions/node/v20.1.0/bin/npx ${NAME}`,
    `"npx" ${NAME}`,
    `'npx' ${NAME}`,
    `n''px ${NAME}`,
    `\\npx ${NAME}`,
    `npx.cmd ${NAME}`,
    `NPX ${NAME}`,
    `/usr/bin/npm install ${NAME}`,
    `"npm" "install" ${NAME}`,
    `/usr/local/bin/pip3.11 install ${NAME}`,
    `pip3.12 install ${NAME}`,
    `C:/Program/pip.exe install ${NAME}`,
    `sudo /usr/local/bin/npm i ${NAME}`,
  ])('is still the tool: %s', (command) => {
    expect(packages(command)).toContain(NAME);
  });

  it('is not the tool when the name only ends the same way', () => {
    expect(packages(`mynpx ${NAME}`)).toEqual([]);
    expect(packages(`./npx-helper ${NAME}`)).toEqual([]);
  });
});

const VERBS: ReadonlyArray<readonly [string, string]> = [
  ['npm', 'i'],
  ['npm', 'in'],
  ['npm', 'ins'],
  ['npm', 'inst'],
  ['npm', 'insta'],
  ['npm', 'instal'],
  ['npm', 'install'],
  ['npm', 'isnt'],
  ['npm', 'isnta'],
  ['npm', 'isntal'],
  ['npm', 'add'],
  ['npm', 'it'],
  ['npm', 'install-test'],
  ['npm', 'x'],
  ['npm', 'exec'],
  ['pnpm', 'i'],
  ['pnpm', 'add'],
  ['pnpm', 'install'],
  ['pnpm', 'dlx'],
  ['pnpm', 'exec'],
  ['pnpm', 'up'],
  ['yarn', 'add'],
  ['yarn', 'global add'],
  ['yarn', 'dlx'],
  ['bun', 'add'],
  ['bun', 'install'],
  ['bun', 'i'],
  ['bun', 'x'],
  ['bunx', ''],
  ['poetry', 'add'],
  ['poetry', 'install'],
  ['pdm', 'add'],
  ['pdm', 'install'],
  ['conda', 'install'],
  ['uv', 'tool install'],
  ['uv', 'tool run'],
  ['uv', 'pip install'],
  ['uv', 'add'],
  ['pip', 'install'],
  ['pip3', 'install'],
  ['python -m', 'pip install'],
  ['python3 -m', 'pip install'],
  ['python3.11 -m', 'pip install'],
  ['cargo', 'add'],
  ['cargo', 'binstall'],
  ['cargo', 'install'],
  ['go', 'get'],
  ['go', 'install'],
  ['gem', 'install'],
  ['gem', 'i'],
  ['bundle', 'add'],
  ['deno', 'install'],
];

const sentence = ([tool, verb]: readonly [string, string]): string =>
  verb === '' ? `${tool} ${NAME}` : `${tool} ${verb} ${NAME}`;

describe('every verb of the table', () => {
  it.each(VERBS)('is read from a command: %s %s', (...entry) => {
    expect(packages(sentence(entry))).toContain(NAME);
  });

  it.each(VERBS)('is read from a page, the same way: %s %s', (...entry) => {
    const page = `To set up, run:\n\n    ${sentence(entry)}\n\nThen continue.`;
    expect(extractAtoms(page)).toContainEqual(pkg);
  });
});

describe('the specs that name a package another way', () => {
  it.each([
    [`deno run npm:${NAME}`, NAME],
    [`deno run jsr:@std/${NAME}`, `@std/${NAME}`],
    [`deno install npm:${NAME}`, NAME],
    [`npm i npm:${NAME}`, NAME],
    [`npm i alias@npm:${NAME}`, NAME],
    [`npm i alias@npm:${NAME}@1.2`, NAME],
    [`pnpm add alias@npm:${NAME}`, NAME],
    [`go run ${NAME}@latest`, NAME],
    [`go run github.com/u/${NAME}@v1.0.0`, `github.com/u/${NAME}`],
  ])('reads the package in %s', (command, name) => {
    expect(packages(command)).toContain(name);
  });

  it('reads the alias too, and the package it stands for', () => {
    expect(packages(`npm i alias@npm:${NAME}`)).toEqual(expect.arrayContaining(['alias', NAME]));
  });

  it('reads the same spec from a page', () => {
    expect(extractAtoms(`Run npm i alias@npm:${NAME} now`)).toContainEqual(pkg);
    expect(extractAtoms(`Run deno run npm:${NAME} now`)).toContainEqual(pkg);
  });

  it.each([
    ['pnpm create', `pnpm create ${NAME}`],
    ['yarn create', `yarn create ${NAME}`],
    ['bun create', `bun create ${NAME}`],
  ])('reads the package a %s runs, which is create-<name>', (_what, command) => {
    expect(packages(command)).toEqual(expect.arrayContaining([NAME, `create-${NAME}`]));
    expect(extractAtoms(command).map((a) => a.value)).toEqual(
      expect.arrayContaining([NAME, `create-${NAME}`]),
    );
  });

  it('names the package a scoped create runs', () => {
    expect(packages(`pnpm create @scope/${NAME}`)).toContain(`@scope/create-${NAME}`);
  });

  it('reads the packages of uv run --with, and not the program it runs', () => {
    const names = packages(`uv run --with ${NAME} python script.py`);
    expect(names).toContain(NAME);
    expect(names).not.toContain('python');
  });
});

describe('a command that is not a launcher names nothing', () => {
  it.each([
    'npm run build',
    'npm test',
    'pnpm run lint',
    'yarn build',
    'bun run dev',
    'pip list',
    'cargo build --release',
    'go build ./...',
    'gem list',
    'deno test',
    'python script.py',
    'python -m venv .venv',
    'python -m pytest tests',
  ])('%s', (command) => {
    expect(packages(command)).toEqual([]);
  });
});
