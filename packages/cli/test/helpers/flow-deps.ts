import { vi, type Mock } from 'vitest';
import { runInitFlow, type FlowAgent, type FlowDeps } from '../../src/commands/init-flow.js';
import type { SelfCheck } from '../../src/commands/init-selfcheck.js';
import { fakeTerminal, type FakeTerminal, type FakeTerminalOptions } from './fake-terminal.js';

/** Three agents as `stroq init` would show them: two found, one not. */
export const AGENTS: readonly FlowAgent[] = [
  { id: 'claude-code', label: 'Claude Code', found: true, where: '.claude/settings.json' },
  { id: 'cursor', label: 'Cursor', found: true, where: '~/.cursor/hooks.json' },
  { id: 'codex', label: 'Codex CLI', found: false, where: '' },
];

/** A hook that allowed the harmless action and denied the fetch into a shell. */
export const PASSING: SelfCheck = {
  ok: true,
  allowed: { verdict: 'allow', detail: '', ms: 120 },
  denied: { verdict: 'deny', detail: '', ms: 95 },
};

/** The text with every run of whitespace as one space, so that wrapped lines can be matched whole. */
export const squash = (text: string): string => text.replace(/\s+/g, ' ');

/** The first line of `out` that has `text` in it, or an empty line. */
export const lineWith = (out: string, text: string): string =>
  out.split('\n').find((line) => line.includes(text)) ?? '';

/** What the installer prints when it worked, as `init` prints it: the file, its events, the notes. */
export const installedOutput = (file: string, ...notes: readonly string[]): string =>
  [
    `Stroq hooks installed in ${file}`,
    '  PreToolUse         → Bash|Write',
    '  PostToolUse        → Read|Bash',
    ...notes,
    'Run "stroq doctor" to verify.',
    'To remove them: stroq uninstall',
    '',
  ].join('\n');

export interface Flow {
  readonly fake: FakeTerminal;
  readonly deps: FlowDeps;
  readonly install: Mock<FlowDeps['install']>;
  readonly command: Mock<FlowDeps['command']>;
  readonly check: Mock<FlowDeps['check']>;
  /** Runs the flow and returns its exit code. */
  readonly run: () => Promise<number>;
}

export interface FlowOptions {
  /** The facts and the answers of the terminal. */
  readonly terminal?: FakeTerminalOptions;
  /** What to say differently from the default: Claude Code and Cursor chosen, a passing check. */
  readonly deps?: Partial<FlowDeps>;
}

/**
 * A flow over fake dependencies, every one of them a spy. What `options.deps` says for `install`,
 * `command` or `check` is what the spy does, so that the spy on the flow is always the one it ran.
 */
export function flow(options: FlowOptions = {}): Flow {
  const fake = fakeTerminal(options.terminal);
  const { install: doInstall, command: doCommand, check: doCheck, ...rest } = options.deps ?? {};
  const install = vi.fn<FlowDeps['install']>(
    doInstall ??
      (async (id) => ({
        code: 0,
        out: installedOutput(`/proj/.${id}/config.json`),
      })),
  );
  const command = vi.fn<FlowDeps['command']>(
    doCommand ?? ((id) => `"node" "/stroq/index.js" hook ${id}`),
  );
  const check = vi.fn<FlowDeps['check']>(doCheck ?? (async () => PASSING));
  const deps: FlowDeps = {
    term: fake.term,
    stroq: '0.22.0',
    scope: 'project',
    yes: false,
    agents: AGENTS,
    chosen: ['claude-code', 'cursor'],
    reads: ['~/.aws/credentials', '.env'],
    home: '~/.stroq',
    ...rest,
    install,
    command,
    check,
  };
  return { fake, deps, install, command, check, run: () => runInitFlow(deps) };
}
