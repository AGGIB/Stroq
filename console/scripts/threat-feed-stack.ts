import { lstat, opendir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { packageName, type Ecosystem, type StackFile, type ThreatAgent } from '../lib/threat-feed';
import { readSettingsFile, readTextFile, type SettingsRead } from './posture-reader';

/**
 * What the threat feed compares pwn.watch's incidents with, found on this machine: the packages this
 * project lists, the ecosystems its files show, and the coding agents set up in your home folder. A
 * fixed list of files is looked at, read under the settings check's rules (bounded, never through a
 * link the repository ships); nothing the browser sends picks a path, and nothing found leaves here.
 */

export interface Stack {
  readonly ecosystems: ReadonlySet<Ecosystem>;
  /** npm names in lower case, PyPI names normalized (`Foo_Bar` is `foo-bar`). */
  readonly npm: ReadonlySet<string>;
  readonly pypi: ReadonlySet<string>;
  readonly agents: ReadonlySet<ThreatAgent>;
  /** Project files that are there but could not be read, so what they list was not compared. */
  readonly unread: readonly StackFile[];
}

interface Dependencies {
  readonly userHome: string;
  readonly project: string;
  readonly codexHome?: string | null;
}

type Lister = 'npm' | 'pyproject' | 'requirements' | 'pipfile';

const FILES: ReadonlyArray<{
  readonly file: StackFile;
  readonly ecosystems: readonly Ecosystem[];
  readonly lists?: Lister;
}> = [
  { file: 'package.json', ecosystems: ['npm'], lists: 'npm' },
  { file: 'pyproject.toml', ecosystems: ['pypi'], lists: 'pyproject' },
  { file: 'requirements.txt', ecosystems: ['pypi'], lists: 'requirements' },
  { file: 'Pipfile', ecosystems: ['pypi'], lists: 'pipfile' },
  { file: 'go.mod', ecosystems: ['go'] },
  { file: 'Cargo.toml', ecosystems: ['rust'] },
  { file: 'Gemfile', ecosystems: ['ruby'] },
  { file: 'composer.json', ecosystems: ['php'] },
  { file: 'pom.xml', ecosystems: ['java'] },
  { file: 'build.gradle', ecosystems: ['java'] },
  { file: 'build.gradle.kts', ecosystems: ['java'] },
  { file: 'Dockerfile', ecosystems: ['docker'] },
  { file: 'compose.yaml', ecosystems: ['docker'] },
  { file: 'compose.yml', ecosystems: ['docker'] },
  { file: 'docker-compose.yml', ecosystems: ['docker'] },
  { file: 'docker-compose.yaml', ecosystems: ['docker'] },
  { file: 'wp-config.php', ecosystems: ['wordpress', 'php'] },
];

const MAX_PACKAGES = 2_000;
/** How many names in the project folder are looked at for a .NET project file. */
const MAX_ENTRIES = 5_000;
const DOTNET = /\.(?:csproj|fsproj|vbproj|sln)$/i;
/** The name at the start of a requirement (`requests>=2`, `Foo_Bar[extra]; python_version>"3"`). */
const REQUIREMENT = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)/;

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A PyPI name as PEP 503 compares it. */
export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function pypiOf(requirement: unknown): string | null {
  if (typeof requirement !== 'string') return null;
  const match = REQUIREMENT.exec(requirement);
  const name = match === null ? null : normalizePypi(match[1] as string);
  return name !== null && packageName(name, 'pypi') ? name : null;
}

const keysOf = (v: unknown): string[] => Object.keys(record(v) ?? {});
const stringsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The packages a file lists, by how it lists them. */
export function listedPackages(lister: Lister, value: unknown): { npm: string[]; pypi: string[] } {
  if (lister === 'npm') {
    const manifest = record(value);
    const names = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .flatMap((field) => keysOf(manifest?.[field]))
      .map((name) => name.toLowerCase())
      .filter((name) => packageName(name, 'npm'));
    return { npm: names, pypi: [] };
  }
  if (lister === 'requirements') {
    const lines = typeof value === 'string' ? value.split(/\r?\n/) : [];
    const names = lines
      .map((line) => line.replace(/(?:^|\s)#.*$/, '').trim())
      // Options (`-r`, `-e`, `--index-url`), paths and URLs name no package of an index.
      .filter((line) => line !== '' && !/^[-./]/.test(line) && !line.includes('://'))
      .map(pypiOf)
      .filter((name): name is string => name !== null);
    return { npm: [], pypi: names };
  }
  const toml = record(value);
  if (lister === 'pipfile') {
    const names = [...keysOf(toml?.packages), ...keysOf(toml?.['dev-packages'])].map(pypiOf);
    return { npm: [], pypi: names.filter((name): name is string => name !== null) };
  }
  const project = record(toml?.project);
  const poetry = record(record(toml?.tool)?.poetry);
  const groups = record(poetry?.group) ?? {};
  const requirements = [
    ...stringsOf(project?.dependencies),
    ...Object.values(record(project?.['optional-dependencies']) ?? {}).flatMap(stringsOf),
    ...Object.values(record(toml?.['dependency-groups']) ?? {}).flatMap(stringsOf),
    ...keysOf(poetry?.dependencies).filter((name) => name.toLowerCase() !== 'python'),
    ...keysOf(poetry?.['dev-dependencies']),
    ...Object.values(groups).flatMap((group) => keysOf(record(group)?.dependencies)),
  ];
  return {
    npm: [],
    pypi: requirements.map(pypiOf).filter((name): name is string => name !== null),
  };
}

/** Whether a name is in the project folder as a file (a link counts: only its presence is used). */
async function present(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A real folder, not a link, at each step from the project down. */
async function folder(project: string, ...parts: string[]): Promise<boolean> {
  let path = project;
  for (const part of parts) {
    path = join(path, part);
    try {
      if (!(await lstat(path)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function hasDotnetProject(project: string): Promise<boolean> {
  try {
    const dir = await opendir(project);
    let seen = 0;
    for await (const entry of dir) {
      if (DOTNET.test(entry.name) && entry.isFile()) return true;
      if (++seen >= MAX_ENTRIES) break;
    }
    return false;
  } catch {
    return false;
  }
}

/** A folder or file in your home folder, where your own may be links (dotfile managers make them). */
async function inHome(path: string, kind: 'folder' | 'file'): Promise<boolean> {
  try {
    const info = await stat(path);
    return kind === 'folder' ? info.isDirectory() : info.isFile();
  } catch {
    return false;
  }
}

async function agentsOf({ userHome, codexHome }: Dependencies): Promise<Set<ThreatAgent>> {
  const codexFolder = codexHome && isAbsolute(codexHome) ? codexHome : join(userHome, '.codex');
  const [claude, claudeJson, cursor, codex] = await Promise.all([
    inHome(join(userHome, '.claude'), 'folder'),
    inHome(join(userHome, '.claude.json'), 'file'),
    inHome(join(userHome, '.cursor'), 'folder'),
    inHome(codexFolder, 'folder'),
  ]);
  const agents = new Set<ThreatAgent>();
  if (claude || claudeJson) agents.add('claude-code');
  if (cursor) agents.add('cursor');
  if (codex) agents.add('codex');
  return agents;
}

async function readListed(project: string, file: StackFile, lister: Lister): Promise<SettingsRead> {
  const target = { path: join(project, file), confineTo: project };
  if (lister === 'requirements') return readTextFile(target);
  return readSettingsFile({ ...target, format: lister === 'npm' ? 'json' : 'toml' });
}

export async function readStack(dependencies: Dependencies): Promise<Stack> {
  const { project } = dependencies;
  const ecosystems = new Set<Ecosystem>();
  const npm = new Set<string>();
  const pypi = new Set<string>();
  const unread: StackFile[] = [];
  for (const { file, ecosystems: shown, lists } of FILES) {
    if (!(await present(join(project, file)))) continue;
    for (const ecosystem of shown) ecosystems.add(ecosystem);
    if (lists === undefined) continue;
    const read = await readListed(project, file, lists);
    if (read.state !== 'read') {
      if (read.state !== 'missing') unread.push(file);
      continue;
    }
    const listed = listedPackages(lists, read.value);
    for (const name of listed.npm) if (npm.size < MAX_PACKAGES) npm.add(name);
    for (const name of listed.pypi) if (pypi.size < MAX_PACKAGES) pypi.add(name);
  }
  if (await folder(project, '.github', 'workflows')) ecosystems.add('github-actions');
  if (await hasDotnetProject(project)) ecosystems.add('dotnet');
  return { ecosystems, npm, pypi, agents: await agentsOf(dependencies), unread };
}
