// What `add --kind mcp` is given and what it records, and the small rules about a server's name and who may ask.
import { isPlainObject } from '../commands/config-file.js';
import type { Terminal } from '../ui/terminal.js';
import { mcpRemedy } from './remedy.js';
import type { Passports, Receipt } from './lock.js';
import type { StoredSubject } from './store.js';
import { SKILL_NAME } from './names.js';
import type { Passport } from './types.js';

export interface McpInstallOptions {
  readonly project: string;
  readonly stroqHome: string;
  readonly terminal: Terminal;
  /** The node binary, as `init --agent mcp` writes it. */
  readonly node: string;
  /** The arguments between the node binary and `mcp`: the Stroq entry, with `--import tsx` in development. */
  readonly entryArgv: readonly string[];
  readonly client?: string;
  readonly config?: string;
  readonly entrypoint?: string;
  readonly passEnv?: readonly string[];
  readonly name?: string;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly user?: boolean;
  readonly restore?: boolean;
  /** Enable strict filtering in the confirmed wrapper; when absent, keep the recorded strict arguments. */
  readonly strict?: boolean;
}

/** What `add --kind mcp` records beside the pin; the proxy reads only kind, status, digest and grant. */
export interface McpRecord {
  readonly kind: 'mcp';
  readonly status: 'confirmed';
  readonly digest: string;
  readonly grant: { readonly pin: string };
  readonly source: string;
  readonly config: string;
  /** Automatic targets retain their project/home boundary; explicit --config targets have none. */
  readonly configRoot?: string | null;
  readonly client: string;
  /** Optional for records written before the installer recorded the wrapper's context separately. */
  readonly cwd?: string;
  readonly entrypoint: string;
  readonly passEnv: readonly string[];
  readonly passport: Passport;
  /** The entry as Stroq wrote it, to tell a later outside edit from its own work. */
  readonly written: Record<string, unknown>;
  /** The entry that stood under this name before Stroq took it, or null when there was none. */
  readonly original: Record<string, unknown> | null;
  readonly history: readonly Receipt[];
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function requirePerson(options: McpInstallOptions): void {
  if (!options.terminal.interactive)
    throw new Error(
      'add and remove need a person at a terminal; use stroq vet --from <path> to read without installing',
    );
}

/** Who a stored copy is for, with the commands that put it back as the lock record has it. */
export const subjectOf = (name: string, record: McpRecord): StoredSubject => ({
  kind: 'mcp',
  name,
  remedy: mcpRemedy(name, record),
});

export function nameOf(name: string): string {
  if (!SKILL_NAME.test(name))
    throw new Error(
      'a server name must be 1-64 lower-case letters, digits, underscores or hyphens',
    );
  return name;
}

export function recordOf(lock: Passports, name: string): McpRecord | undefined {
  const raw = Object.hasOwn(lock.mcp ?? {}, name) ? lock.mcp![name] : undefined;
  return isPlainObject(raw) &&
    raw['kind'] === 'mcp' &&
    raw['status'] === 'confirmed' &&
    isPlainObject(raw['written'])
    ? (raw as unknown as McpRecord)
    : undefined;
}
