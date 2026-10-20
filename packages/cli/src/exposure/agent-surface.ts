import {
  INSTRUCTION_FILE,
  editorAutorunText,
  isAgentDefinitionPath,
  isMcpConfigPath,
  mcpConfigRunsCode,
} from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import {
  DEVCONTAINER_HOST_KEY,
  DEVCONTAINER_KEYS,
  codeWorkspace,
  devcontainer,
  packageScripts,
  vscodeSettingsFile,
  vscodeTasks,
} from './agent-editor.js';
import {
  CLAUDE_SETTINGS_KEYS,
  claudeSettings,
  hookFile,
  mcpFile,
  type JsonFile,
} from './agent-json.js';
import { byLine, digestOf, hit, type AgentHit } from './agent-kinds.js';
import { foldName } from './git-dir-names.js';
import { opencodeConfig, pluginCode, zedSettings } from './agent-others.js';
import { geminiSettings } from './agent-switches.js';
import { agentDefinition, instructionFile } from './agent-text.js';
import { codexConfig } from './agent-toml.js';
import { lineOf, stripJsonc } from './jsonc.js';

export {
  AGENT_KINDS,
  KIND_SEVERITY,
  type AgentHit,
  type AgentKind,
  type Severity,
} from './agent-kinds.js';

/**
 * What a repository carries that an AI agent or an editor runs by itself once the folder is
 * open: hooks, MCP servers, folder-open tasks, helper commands, dev container commands, and
 * the instruction files the agent reads in every session.
 *
 * Only files of the repository are read, never the home directory: this is about what a
 * checkout brings with it. A file is read only if it is a regular file within a size cap, and
 * a link is followed only while it stays inside the repository.
 */

type Reader = (path: string, text: string) => AgentHit[];
type Fallback = (path: string, raw: string, stripped: string) => AgentHit[];

/**
 * Reads JSON with comments; a file that does not parse goes to `fallback`, which always reports
 * it: a host's own reader may recover what this one rejects (VS Code's reads past a missing comma
 * and decodes the `\u` escapes a key can be spelled with), so its text proves nothing.
 */
const json =
  (read: (f: JsonFile) => AgentHit[], fallback: Fallback): Reader =>
  (path, raw) => {
    const stripped = stripJsonc(raw);
    let value: unknown;
    try {
      value = JSON.parse(stripped);
    } catch {
      return fallback(path, raw, stripped);
    }
    return isPlainObject(value) ? read({ path, text: stripped, value }) : [];
  };

/**
 * A file that could not be read, reported whatever it holds; `keys` only place it on a line. One
 * whose bytes are not text (a NUL, or bytes that are not UTF-8, as a filter such as git-crypt
 * stores it) is said to be so: what a checkout writes there is not this.
 */
const mentions =
  (keys: readonly string[]): Fallback =>
  (path, raw, stripped) => {
    if (raw.includes('\u0000') || raw.includes('\uFFFD')) {
      const why = `its bytes are not text, as a checkout filter stores a file (${digestOf(raw)})`;
      return [hit('unreadable-config', path, 1, 'not text', why)];
    }
    return [hit('unreadable-config', path, lineOf(stripped, keys), 'unparsed', digestOf(raw))];
  };

const either =
  (...fallbacks: readonly Fallback[]): Fallback =>
  (path, raw, stripped) => {
    for (const fallback of fallbacks) {
      const hits = fallback(path, raw, stripped);
      if (hits.length > 0) return hits;
    }
    return [];
  };

const RUN_KEYS = ['"command"', '"bash"', '"powershell"', '"url"'] as const;

/** The gate's own reading of a server list that is not JSON: a fragment naming a shell. */
const mcpText: Fallback = (path, raw, stripped) =>
  mcpConfigRunsCode(path, raw)
    ? [
        hit(
          'mcp-server-runs-code',
          path,
          lineOf(stripped, ['"command"']),
          'unparsed',
          digestOf(raw),
        ),
      ]
    : [];

/** The gate's own reading of an editor file that is not JSON: a folder-open task in the text. */
const editorText: Fallback = (path, raw, stripped) =>
  editorAutorunText(path, raw)
    ? [
        hit(
          'editor-autorun-task',
          path,
          lineOf(stripped, ['"runOn"', '"task.allowAutomaticTasks"']),
          'unparsed',
          digestOf(raw),
        ),
      ]
    : [];

const devcontainerText: Fallback = (path, raw, stripped) => {
  const keys = [DEVCONTAINER_HOST_KEY, ...DEVCONTAINER_KEYS];
  const found = keys
    .filter((key) => stripped.includes(`"${key}"`))
    .map((key) =>
      hit(
        key === DEVCONTAINER_HOST_KEY ? 'devcontainer-host-command' : 'devcontainer-command',
        path,
        lineOf(stripped, [`"${key}"`]),
        key,
        digestOf(raw),
      ),
    );
  // Whatever else it holds is not known either: the file fails as well.
  return [...found, ...mentions(keys)(path, raw, stripped)];
};

const READERS = {
  claude: json(claudeSettings, mentions(CLAUDE_SETTINGS_KEYS)),
  mcp: json(mcpFile, either(mcpText, mentions(RUN_KEYS))),
  gemini: json(
    geminiSettings,
    either(
      mcpText,
      mentions([
        ...RUN_KEYS,
        '"hooks"',
        'defaultApprovalMode',
        'autoAccept',
        'Command"',
        'otlpEndpoint',
        'folderTrust',
        '"trust"',
      ]),
    ),
  ),
  hooks: json(hookFile, mentions(RUN_KEYS)),
  tasks: json(vscodeTasks, either(editorText, mentions(RUN_KEYS))),
  settings: json(vscodeSettingsFile, either(editorText, mentions(['autoApprove', '"servers"']))),
  workspace: json(codeWorkspace, either(editorText, mentions(['autoApprove', ...RUN_KEYS]))),
  devcontainer: json(devcontainer, devcontainerText),
  package: json(packageScripts, mentions(['"scripts"'])),
  opencode: json(opencodeConfig, mentions(['"mcp"', '"plugin"'])),
  zed: json(zedSettings, mentions(['context_servers', '"binary"'])),
  plugin: pluginCode,
  codex: codexConfig,
  definition: agentDefinition,
  instruction: instructionFile,
} satisfies Record<string, Reader>;

/**
 * Files at a fixed place, by their path in lower case: at the root, and in any folder, since a
 * host started in a subfolder of a monorepo, or an editor opened on one, reads that folder's own.
 */
const AT_ROOT: ReadonlyMap<string, Reader> = new Map([
  ['.claude/settings.json', READERS.claude],
  ['.claude/settings.local.json', READERS.claude],
  ['.mcp.json', READERS.mcp],
  ['.cursor/mcp.json', READERS.mcp],
  ['.vscode/mcp.json', READERS.mcp],
  ['.kiro/settings/mcp.json', READERS.mcp],
  ['.roo/mcp.json', READERS.mcp],
  ['.gemini/settings.json', READERS.gemini],
  ['.qwen/settings.json', READERS.gemini],
  ['opencode.json', READERS.opencode],
  ['opencode.jsonc', READERS.opencode],
  ['.opencode/opencode.json', READERS.opencode],
  ['.opencode/opencode.jsonc', READERS.opencode],
  ['.zed/settings.json', READERS.zed],
  ['.cursor/hooks.json', READERS.hooks],
  ['.codex/hooks.json', READERS.hooks],
  ['.codex/config.toml', READERS.codex],
  ['.gemini/config/hooks.json', READERS.hooks],
  ['.agents/hooks.json', READERS.hooks],
  ['.windsurf/hooks.json', READERS.hooks],
  ['.devin/hooks.json', READERS.hooks],
  ['.vscode/tasks.json', READERS.tasks],
  ['.vscode/settings.json', READERS.settings],
  ['.devcontainer.json', READERS.devcontainer],
  ['package.json', READERS.package],
]);

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Folders of other people's code: a config under one is not one a host of this repository reads. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.venv',
  'venv',
  'vendor',
  'target',
  'dist',
  'build',
]);

/** The reader of a file at a fixed place, at the root or in a folder; `parts` are in lower case. */
function fixedReader(parts: readonly string[]): Reader | undefined {
  for (let n = Math.min(3, parts.length); n >= 1; n -= 1) {
    const reader = AT_ROOT.get(parts.slice(-n).join('/'));
    if (reader !== undefined) return reader;
  }
  return undefined;
}

/**
 * The folder of other people's code a path is in, as the walk on disk skips them: a skipped folder
 * that is not itself inside an agent folder. Matched by its exact name, as the walk matches it:
 * `Vendor` is read, in doubt. `path` is as it is in the tree, in its own letter case.
 */
function othersCodeFolder(path: string): string | undefined {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    if (AGENT_DIR_NAMES.has(part.toLowerCase()) || AGENT_DIR_NAMES.has(foldName(part)))
      return undefined;
    if (SKIP_DIRS.has(part)) return part;
  }
  return undefined;
}

const inOthersCode = (path: string): boolean => othersCodeFolder(path) !== undefined;

/**
 * The folder of other people's code (`vendor`, `build`...) that a config a host would read is in,
 * when the readers skip it; undefined for any other path, and for `node_modules`, which a change
 * fills with nothing a host starts in. A host started in that folder reads the config all the same.
 */
export function skippedConfigFolder(path: string): string | undefined {
  const folder = othersCodeFolder(path);
  if (folder === undefined || folder === 'node_modules') return undefined;
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const read =
    fixedReader(parts) !== undefined ||
    folderReaders(parts).length > 0 ||
    lower.endsWith('.code-workspace');
  return read ? folder : undefined;
}

/** Whether the last parts of `parts` are `folder` and then a name `name` accepts. */
const endsIn = (
  parts: readonly string[],
  folder: readonly string[],
  name: (base: string) => boolean,
) =>
  parts.length > folder.length &&
  folder.every((f, i) => parts[parts.length - 1 - folder.length + i] === f) &&
  name(parts[parts.length - 1] as string);

/** Readers chosen by the folder a file is in, at any depth; `lower` is split at `/`. */
function folderReaders(parts: readonly string[]): Reader[] {
  const readers: Reader[] = [];
  const base = parts[parts.length - 1] as string;
  // A server list straight inside an agent's own folder: `.amazonq/mcp.json`, `.trae/mcp.json`.
  const parent = parts[parts.length - 2] ?? '';
  if (base === 'mcp.json' && parent.length > 1 && parent.startsWith('.')) readers.push(READERS.mcp);
  if (
    endsIn(parts, ['.github', 'hooks'], (b) => b.endsWith('.json')) ||
    endsIn(parts, ['.kiro', 'hooks'], (b) => b.endsWith('.kiro.hook'))
  )
    readers.push(READERS.hooks);
  if (endsIn(parts, ['.github', 'copilot'], (b) => b.startsWith('settings') && b.endsWith('.json')))
    readers.push(READERS.claude);
  if (
    parts.slice(0, -1).includes('.devcontainer') &&
    (base === 'devcontainer.json' || base === '.devcontainer.json')
  )
    readers.push(READERS.devcontainer);
  const plugin = (b: string): boolean => /\.[cm]?[jt]s$/.test(b);
  if (
    endsIn(parts, ['.opencode', 'plugin'], plugin) ||
    endsIn(parts, ['.opencode', 'plugins'], plugin)
  )
    readers.push(READERS.plugin);
  return readers;
}

/** Names an instruction reader reads as text; a picture in a skill folder is not one. */
function isTextName(path: string): boolean {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true;
  return ['.md', '.mdc', '.markdown', '.txt', '.json', '.hook'].includes(
    base.slice(dot).toLowerCase(),
  );
}

/** A path whose parts may fold to other names: past printable ASCII, a `:`, a dot or blank at an end. */
const MAY_FOLD = /[^\x20-\x7e]|[. ](?:\/|$)|:/;

/**
 * A path as the most forgiving disk opens it, each part folded by `foldName`: a dot or blank at
 * the end of a part dropped and a `:` stream cut off (Windows), invisible characters and accents
 * dropped (macOS), letter case folded. `.claude./settings.json` is `.claude/settings.json`.
 */
export function foldPath(path: string): string {
  const lower = path.toLowerCase();
  return MAY_FOLD.test(path) ? path.split('/').map(foldName).join('/') : lower;
}

/** The readers of a path, by its name in lower case or folded, as `lower` gives it. */
function readersOf(path: string, lower: string): Reader[] {
  const parts = lower.split('/');
  const readers: Reader[] = [];
  if (!inOthersCode(path)) {
    const fixed = fixedReader(parts);
    if (fixed !== undefined) readers.push(fixed);
    readers.push(...folderReaders(parts).filter((r) => r !== fixed));
    if (lower.endsWith('.code-workspace')) readers.push(READERS.workspace);
  }
  return readers;
}

/**
 * Every reader for a repository-relative path with `/` separators; none for most files. A path is
 * read by its own name and by the name a disk may open it as, so `.claude /settings.json` is read
 * as settings too.
 */
export function readersFor(path: string): Reader[] {
  const lower = path.toLowerCase();
  const folded = foldPath(path);
  const readers = readersOf(path, lower);
  if (folded !== lower)
    for (const reader of readersOf(path, folded))
      if (!readers.includes(reader)) readers.push(reader);
  if (isAgentDefinitionPath(path) && lower.endsWith('.md')) readers.push(READERS.definition);
  if (INSTRUCTION_FILE.test(path) && !isMcpConfigPath(path) && isTextName(path))
    readers.push(READERS.instruction);
  return readers;
}

/**
 * Whether a path is an agent config or in an agent folder only by the name a disk may open it as,
 * not by its own: `.cla​ude/settings.json`, `.vscode./tasks.json`. What the check read
 * under that name may not be what a host on another disk opens.
 */
export function agentOnlyWhenFolded(path: string): boolean {
  const lower = path.toLowerCase();
  const folded = foldPath(path);
  if (folded === lower) return false;
  const agent = (name: string): boolean =>
    readersOf(path, name).length > 0 || agentFolderIn(name) || agentDirIs(name);
  return agent(folded) && !agent(lower);
}

export const isSurfacePath = (path: string): boolean => readersFor(path).length > 0;

/**
 * Which files a check reads first when it cannot read them all: 0 for the configs at a fixed
 * place and the agent folders themselves, 1 for any other file that can run something, 2 for a
 * file that is only an instruction file.
 */
export function readTier(path: string): 0 | 1 | 2 {
  const lower = path.toLowerCase();
  const folded = foldPath(path);
  if (AT_ROOT.has(lower) || AGENT_DIRS.has(lower) || AT_ROOT.has(folded) || AGENT_DIRS.has(folded))
    return 0;
  const readers = readersFor(path);
  return readers.length > 0 && readers.every((r) => r === READERS.instruction) ? 2 : 1;
}

/**
 * A reader that cannot stop the check. Whatever a file makes a reader throw (a value nested
 * deeper than a library walks, say) becomes a failing entry for that file, with a digest of the
 * text as its value, so a file that changes is still a change.
 */
export const guarded =
  (read: Reader): Reader =>
  (path, text) => {
    try {
      return read(path, text);
    } catch {
      return [hit('unreadable-config', path, 1, 'stopped', digestOf(text))];
    }
  };

/** The hits of one file's text, in the order of their lines. */
export function scanFile(path: string, text: string): readonly AgentHit[] {
  return byLine(readersFor(path).flatMap((read) => guarded(read)(path, text)));
}

/** What a source found at a path. */
export type SourceRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-large'; readonly size: number }
  /** Past the budget of bytes one check reads, so not read; reported like a file too large. */
  | { readonly kind: 'over-budget'; readonly budget: number }
  | { readonly kind: 'outside'; readonly target: string }
  /**
   * A link inside the repository that leads to nothing: to `target`, which is not there, or round
   * in a loop (`target` undefined). A host opens whatever appears there later, a build output say.
   */
  | { readonly kind: 'dangling'; readonly target: string | undefined }
  | { readonly kind: 'unreadable' };

/** The most bytes of one file that are read. A real agent config is a few kilobytes. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** What a Git LFS pointer starts with: the file a checkout writes here is fetched from elsewhere. */
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';

export function hitsForRead(path: string, read: SourceRead): readonly AgentHit[] {
  if (read.kind === 'text') {
    // What git holds here is not what a checkout with Git LFS writes, so it was not read.
    if (read.text.startsWith(LFS_POINTER) && readersFor(path).length > 0)
      return [
        hit(
          'unreadable-config',
          path,
          1,
          'lfs pointer',
          `a Git LFS pointer: a checkout fills it in from elsewhere (${digestOf(read.text)})`,
        ),
      ];
    return scanFile(path, read.text);
  }
  if (read.kind === 'unreadable') return [];
  if (read.kind === 'outside') return [hit('config-link-outside', path, 1, 'link', read.target)];
  if (read.kind === 'dangling') {
    const why =
      read.target === undefined
        ? 'the links go round in a loop, or more of them in a row than a host follows'
        : `the link points at ${read.target}, which is not there`;
    return [hit('unreadable-config', path, 1, 'link', why)];
  }
  const why =
    read.kind === 'too-large'
      ? `too large to read (${read.size} bytes)`
      : `past the ${read.budget} bytes one check reads`;
  // An instruction file too, though its only check is for hidden characters: padding it past
  // the cap would otherwise switch that check off.
  return [hit('unreadable-config', path, 1, 'size', why)];
}

/** The most bytes of agent files one check reads, in all; real ones are kilobytes. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Folders whose contents an agent loads, reported when they are a link out of the repository. */
export const AGENT_DIRS: ReadonlySet<string> = new Set([
  '.claude',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.cursor',
  '.cursor/rules',
  '.codex',
  '.gemini',
  '.agents',
  '.windsurf',
  '.devin',
  '.vscode',
  '.devcontainer',
  '.github',
  '.github/hooks',
  '.github/copilot',
  '.github/agents',
  '.kiro',
  '.kiro/hooks',
  '.kiro/settings',
  '.roo',
  '.amazonq',
  '.kilocode',
  '.trae',
  '.qwen',
  '.zed',
  '.opencode',
  '.opencode/plugin',
  '.opencode/plugins',
]);

/**
 * Folder names that make what is under them something an agent or editor loads, wherever they
 * stand: the readers above choose by them. A path through one is read under its own name even
 * when the same folder was read under another.
 */
const AGENT_DIR_NAMES: ReadonlySet<string> = new Set([
  '.claude',
  '.cursor',
  '.codex',
  '.gemini',
  '.agents',
  '.agent',
  '.windsurf',
  '.devin',
  '.vscode',
  '.devcontainer',
  '.github',
  '.kiro',
  '.roo',
  '.amazonq',
  '.kilocode',
  '.trae',
  '.qwen',
  '.zed',
  '.opencode',
]);

/**
 * Whether a path is a folder whose contents an agent loads, at the root or in a subfolder that a
 * host may be started in: `.claude`, `packages/app/.claude/skills`.
 */
export function isAgentDir(path: string): boolean {
  if (inOthersCode(path)) return false;
  return agentDirIs(path.toLowerCase()) || agentDirIs(foldPath(path));
}

/** `isAgentDir` of a path already in lower case or folded. */
function agentDirIs(lower: string): boolean {
  const parts = lower.split('/');
  return [1, 2].some((n) => parts.length >= n && AGENT_DIRS.has(parts.slice(-n).join('/')));
}

/** Inside an agent folder, at any depth: not `.github` as a whole, whose workflows are not one. */
export function inAgentDir(path: string): boolean {
  if (inOthersCode(path)) return false;
  return [path.toLowerCase(), foldPath(path)].some((lower) => {
    const slashed = `/${lower}`;
    for (const dir of AGENT_DIRS) {
      if (slashed.endsWith(`/${dir}`)) return true;
      if (dir !== '.github' && slashed.includes(`/${dir}/`)) return true;
    }
    return false;
  });
}

/** `inAgentFolder` of a path already in lower case or folded. */
const agentFolderIn = (lower: string): boolean =>
  lower.split('/').some((part) => AGENT_DIR_NAMES.has(part));

/**
 * Whether a repository-relative path goes through a folder an agent or editor loads from, by
 * its own name or by the name a disk may open it as.
 */
export const inAgentFolder = (path: string): boolean =>
  agentFolderIn(path.toLowerCase()) || agentFolderIn(foldPath(path));
