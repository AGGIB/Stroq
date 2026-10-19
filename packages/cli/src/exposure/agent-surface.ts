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
  geminiSettings,
  hookFile,
  mcpFile,
  type JsonFile,
} from './agent-json.js';
import { byLine, digestOf, hit, type AgentHit } from './agent-kinds.js';
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

/** Reads JSON with comments; a file that does not parse goes to `fallback`, never to nothing. */
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

/** A file that could not be read is reported when its text names a key that runs something. */
const mentions =
  (keys: readonly string[]): Fallback =>
  (path, raw, stripped) => {
    const key = keys.find((k) => stripped.includes(k));
    if (key === undefined) return [];
    return [hit('unreadable-config', path, lineOf(stripped, [key]), 'unparsed', digestOf(raw))];
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

const devcontainerText: Fallback = (path, raw, stripped) =>
  [DEVCONTAINER_HOST_KEY, ...DEVCONTAINER_KEYS]
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

const READERS = {
  claude: json(claudeSettings, mentions(CLAUDE_SETTINGS_KEYS)),
  mcp: json(mcpFile, either(mcpText, mentions(RUN_KEYS))),
  gemini: json(geminiSettings, either(mcpText, mentions([...RUN_KEYS, '"hooks"']))),
  hooks: json(hookFile, mentions(RUN_KEYS)),
  tasks: json(vscodeTasks, either(editorText, mentions(RUN_KEYS))),
  settings: json(vscodeSettingsFile, either(editorText, mentions(['autoApprove', '"servers"']))),
  workspace: json(codeWorkspace, either(editorText, mentions(['autoApprove', ...RUN_KEYS]))),
  devcontainer: json(devcontainer, devcontainerText),
  package: json(packageScripts, () => []),
  codex: codexConfig,
  definition: agentDefinition,
  instruction: instructionFile,
} satisfies Record<string, Reader>;

/** Files at a fixed place from the root, by their path in lower case. */
const AT_ROOT: ReadonlyMap<string, Reader> = new Map([
  ['.claude/settings.json', READERS.claude],
  ['.claude/settings.local.json', READERS.claude],
  ['.mcp.json', READERS.mcp],
  ['.cursor/mcp.json', READERS.mcp],
  ['.vscode/mcp.json', READERS.mcp],
  ['.gemini/settings.json', READERS.gemini],
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
/** `dir/x` with nothing more under it. */
const directlyIn = (path: string, dir: string): boolean =>
  path.startsWith(dir) && !path.slice(dir.length).includes('/');

/** Names an instruction reader reads as text; a picture in a skill folder is not one. */
function isTextName(path: string): boolean {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true;
  return ['.md', '.mdc', '.markdown', '.txt', '.json'].includes(base.slice(dot).toLowerCase());
}

/** Every reader for a repository-relative path with `/` separators; none for most files. */
export function readersFor(path: string): Reader[] {
  const lower = path.toLowerCase();
  const readers: Reader[] = [];
  const fixed = AT_ROOT.get(lower);
  if (fixed !== undefined) readers.push(fixed);
  if (directlyIn(lower, '.github/hooks/') && lower.endsWith('.json')) readers.push(READERS.hooks);
  if (directlyIn(lower, '.github/copilot/settings') && lower.endsWith('.json'))
    readers.push(READERS.claude);
  if (lower.endsWith('.code-workspace')) readers.push(READERS.workspace);
  if (
    lower.startsWith('.devcontainer/') &&
    ['devcontainer.json', '.devcontainer.json'].includes(baseName(lower))
  )
    readers.push(READERS.devcontainer);
  if (isAgentDefinitionPath(path) && lower.endsWith('.md')) readers.push(READERS.definition);
  if (INSTRUCTION_FILE.test(path) && !isMcpConfigPath(path) && isTextName(path))
    readers.push(READERS.instruction);
  return readers;
}

export const isSurfacePath = (path: string): boolean => readersFor(path).length > 0;

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
  | { readonly kind: 'unreadable' };

/** The most bytes of one file that are read. A real agent config is a few kilobytes. */
export const MAX_FILE_BYTES = 1024 * 1024;

export function hitsForRead(path: string, read: SourceRead): readonly AgentHit[] {
  if (read.kind === 'text') return scanFile(path, read.text);
  if (read.kind === 'unreadable') return [];
  if (read.kind === 'outside') return [hit('config-link-outside', path, 1, 'link', read.target)];
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
]);

/** Whether a repository-relative path goes through a folder an agent or editor loads from. */
export const inAgentFolder = (path: string): boolean =>
  path
    .toLowerCase()
    .split('/')
    .some((part) => AGENT_DIR_NAMES.has(part));
