// `stroq init`, the first time, on a terminal a person is looking at.
//
// What it says is what the plain installer does, in the order a newcomer needs it: which agents are
// on this machine, what Stroq will change and read and where, a question before anything is written,
// one line for each thing that was done, a check that what was written starts and judges, and what to
// type next. Where nobody is there to look (a pipe, CI, `--no-input`, `TERM=dumb`) none of this
// runs and the installer prints what it always printed: scripts read that, and the tests hold it.
//
// Nothing is installed here. The installer is the one in `init.ts`, called once for each agent with
// its output kept: this draws around it, and shows the notes it printed for an agent (a restart, an
// approval) under that agent's line, where they are read.
//
// A line that would not fit the terminal is put on two, the step and what is said of it, at the spaces
// in it: a word longer than the line (a path) is left whole, and so is a command a person is to copy,
// which a break would make two commands. Text that came from outside (a path, a note an installer
// printed) goes through `outside` first,
// because the writer of the terminal is not filtered: its own colours and cursor movements are the
// only escape sequences there are.
import { exitOnQuit } from '../ui/cleanup.js';
import { confirm } from '../ui/prompt.js';
import { outside, outsideLine, row, shortPath, unbreakable, wrapKeeping } from '../ui/layout.js';
import { settled, startStep, type Timers } from '../ui/spinner.js';
import { styleFor } from '../ui/style.js';
import { symbolsFor } from '../ui/symbols.js';
import type { Terminal } from '../ui/terminal.js';
import type { SelfCheck } from './init-selfcheck.js';

export interface FlowAgent {
  readonly id: string;
  /** What a person calls it: `Claude Code`. */
  readonly label: string;
  /** Found on this machine. */
  readonly found: boolean;
  /** Where its config is, or what is looked for, as it is shown. */
  readonly where: string;
  /** What else installing for it does, that is not a file written in the project: said before it is. */
  readonly extra?: string;
  /** Installing for it is for the whole user, whatever the scope: the plugin of a Gateway. */
  readonly userWide?: boolean;
  /** The command that takes it out again, where that is not `stroq uninstall`. */
  readonly undo?: string;
}

export interface FlowDeps {
  readonly term: Terminal;
  readonly stroq: string;
  readonly scope: 'project' | 'user';
  /** `--yes`: the question is answered. */
  readonly yes: boolean;
  /** All the agents Stroq can guard, in the order they are shown. */
  readonly agents: readonly FlowAgent[];
  /** The ones to guard if the person agrees. */
  readonly chosen: readonly string[];
  /** The credential files that exist now, as they are shown. */
  readonly reads: readonly string[];
  /** Where Stroq keeps what it records, as it is shown. */
  readonly home: string;
  /** The hooks run a copy of this CLI that is written under `home`, because it came from npm's npx cache. */
  readonly copiesCli?: boolean;
  /** A path an installer printed, as it is shown: from the project, or from `~`. As it is, where not given. */
  readonly show?: (path: string) => string;
  /** Runs the installer for one agent and returns what it printed. */
  readonly install: (id: string) => Promise<{ readonly code: number; readonly out: string }>;
  /** The command the agent was told to run, as `init` recorded it. */
  readonly command: (id: string) => string | null;
  /** Runs the two events through it. */
  readonly check: (id: string, command: string) => Promise<SelfCheck | null>;
  readonly timers?: Timers;
}

const INDENT = '  ';
const LABEL_WIDTH = 9;
/** What a step's line and the mark before it take: `  ✔ `. */
const MARK_WIDTH = 4;
/** The least a path is cut to on a line that has other things on it. */
const MIN_PATH = 16;

/** The lines of an installer's output that are not notes: what it wrote, the next command, the way out. */
const NOT_A_NOTE =
  /^(?:Stroq hooks installed in |Stroq plugin installed in |Run "stroq doctor"|To remove them: )/;

/** The lines an installer printed that are notes to a person, not the config it wrote or the next command. */
export function notesOf(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !/^\s/.test(line) && !NOT_A_NOTE.test(line));
}

/**
 * A paragraph of a note, a line of it that is to be copied, or a command that an installer ran for the
 * person and what that command printed (its own words, kept as it said them).
 */
export type NoteBlock =
  | { readonly kind: 'text' | 'command'; readonly text: string }
  | { readonly kind: 'run'; readonly text: string; readonly lines: readonly string[] };

/** What an installer prints before a command it ran, `$ openclaw plugins enable stroq`, and then what it said indented. */
const RUN_LINE = /^\$ (\S.*)$/;

/** What ends a paragraph of a note: a sentence, or a colon that what follows is the rest of. */
const PARAGRAPH_END = /[.!?:]$/;

/**
 * The notes of an installer as a person reads them: a note that an installer broke over lines at a
 * place of its own is one paragraph again (a line that does not end in a sentence goes on in the next),
 * and the indented lines that follow a note ending in a colon are what it says to type, which are
 * kept as the lines they are, and are the only indented lines that are (the others are the config the
 * installer wrote).
 */
export function noteBlocks(out: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let open: string[] = [];
  let commandsFollow = false;
  /** The output of the command that was run last, while the lines that follow are indented. */
  let run: { text: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (open.length === 0) return;
    const text = open.join(' ');
    blocks.push({ kind: 'text', text });
    commandsFollow = text.endsWith(':');
    open = [];
  };
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const ran = RUN_LINE.exec(line);
    if (ran !== null) {
      flush();
      commandsFollow = false;
      run = { text: ran[1] as string, lines: [] };
      blocks.push({ kind: 'run', text: run.text, lines: run.lines });
      continue;
    }
    if (/^\s/.test(line)) {
      // What a command printed, under it. Not a line to copy, and not a note.
      if (run !== null) {
        run.lines.push(line.replace(/^ {1,4}/, ''));
        continue;
      }
      flush();
      if (commandsFollow) blocks.push({ kind: 'command', text: line.trim() });
      continue;
    }
    run = null;
    if (NOT_A_NOTE.test(line)) {
      flush();
      commandsFollow = false;
      continue;
    }
    open.push(line);
    if (PARAGRAPH_END.test(line)) flush();
  }
  flush();
  return blocks;
}

/** The file an installer says it wrote, or null. */
export function installedFile(out: string): string | null {
  return /^Stroq (?:hooks|plugin) installed in ([^\n]+)$/m.exec(out)?.[1]?.trim() ?? null;
}

/** The first thing an installer that failed said: a note, or its first line, or that it failed. */
function reasonOf(out: string): string {
  const first = out
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  return notesOf(out)[0] ?? first ?? 'the installer failed';
}

/** What stands for the punctuation an installer's note may hold where the terminal draws only ASCII. */
const ASCII_STAND_IN: Readonly<Record<string, string>> = {
  '—': '-',
  '–': '-',
  '…': '...',
  '→': '->',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '•': '*',
  '✔': '+',
  '✘': 'x',
};

/** The command that takes the hooks `init` writes for an agent out again. */
export const uninstallCommand = (id: string, scope: 'project' | 'user'): string =>
  `stroq uninstall${id === 'claude-code' ? '' : ` --agent ${id}`}${scope === 'user' ? ' --user' : ''}`;

/** The command that takes an agent's hooks out again: the one it names, or `stroq uninstall`'s. */
const undoCommand = (agent: FlowAgent, scope: 'project' | 'user'): string =>
  agent.undo ?? uninstallCommand(agent.id, scope);

/**
 * A note that says something is wrong, or that Stroq does nothing yet: a warning of the installer, hooks
 * that do not run where they were written (a `.devin/hooks.json` over Windsurf's), a Codex that has
 * not been asked to approve them, an OpenClaw that is not there to be told.
 */
const WARNING_NOTE =
  /^Warning:|\b(?:will not run|not (?:be )?run|does nothing|is not on PATH|does not run it for you|did not succeed|which Stroq did not write)\b/i;

/**
 * A note that says Stroq is not guarding the agent yet: its hooks do not run (where they were written, until
 * a person approves them, where a Gateway was not told), or the agent has to be restarted (not "if") before
 * it calls them. A warning that is only about what may go wrong later (a cache that is pruned) is not one.
 */
const NOT_YET_NOTE =
  /\b(?:will not run|not (?:be )?run|does nothing|is not on PATH|does not run it for you|did not succeed|approve)\b|\b(?:restart|reload)\b(?![^.]{0,300}\bif\b)/i;

/** The most of a paragraph that is read for what it says: past it, a note is not one of Stroq's. */
const MAX_NOTE_CHARS = 4000;
/** The most notes, and lines of what a command printed, that are shown for one agent. */
const MAX_NOTE_BLOCKS = 14;
const MAX_RUN_LINES = 8;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const ms = (n: number): string => `${n} ms`;

export async function runInitFlow(deps: FlowDeps): Promise<number> {
  // Ctrl-\ is a core dump unless it is answered, for as long as the screen is up: at the question too.
  const release = exitOnQuit();
  try {
    return await drawFlow(deps);
  } finally {
    release();
  }
}

async function drawFlow(deps: FlowDeps): Promise<number> {
  const { term } = deps;
  const style = styleFor(term);
  const symbols = symbolsFor(term.unicode);
  const columns = term.columns;
  const show = deps.show ?? ((file: string): string => file);
  const width = Math.min(78, columns - INDENT.length);
  const say = (text = ''): void => term.write(`${text}\n`);
  /** Wrapped text from the code, indented. */
  const para = (text: string, indent = INDENT, tint: (s: string) => string = (s) => s): void => {
    for (const line of wrapKeeping(text, width - (indent.length - INDENT.length), 0))
      say(`${indent}${tint(line)}`);
  };
  /** A path as it may be put on a line: made safe, and cut to `room` columns. */
  const path = (text: string, room: number): string =>
    shortPath(outsideLine(text), Math.max(1, room), symbols.ellipsis);
  /** A note from an installer, as the terminal can draw it. */
  const drawn = (text: string): string =>
    term.unicode
      ? outside(text)
      : outside(text).replace(/[^\x00-\x7f]/g, (c) => ASCII_STAND_IN[c] ?? '?');
  /**
   * What is said of a step, beside its label where it fits and under it where it does not: the line
   * of the step, and the lines under it.
   */
  const said = (label: string, detail: string): { text: string; under: string[] } => {
    if ([...`${label}  ${detail}`].length + MARK_WIDTH <= columns)
      return { text: `${label}  ${style.dim(detail)}`, under: [] };
    return { text: label, under: wrapKeeping(detail, columns - MARK_WIDTH).map(style.dim) };
  };
  /** A line that is all one thing, wrapped under its step. */
  const failure = (text: string): { text: string; under: string[] } => {
    const [first = '', ...rest] = wrapKeeping(text, columns - MARK_WIDTH);
    return { text: first, under: rest };
  };

  // 1. What this is.
  say();
  say(`${INDENT}${style.bold('stroq')} ${style.dim(deps.stroq)}`);
  say(`${INDENT}${style.accent('Action firewall for AI coding agents')}`);
  para(
    'Stroq judges what your agent is about to do (the commands it runs, the files it reads or edits, and the fetches and tool calls its hooks can see), on this machine, before it happens. Nothing is sent anywhere.',
    INDENT,
    style.dim,
  );
  say();

  // 2. Which agents are here.
  say(`${INDENT}${style.bold('Agents on this machine')}`);
  const names = Math.max(...deps.agents.map((a) => a.label.length));
  for (const agent of deps.agents) {
    const mark = agent.found ? style.good(symbols.ok) : style.dim(symbols.none);
    const where = agent.found
      ? path(agent.where, Math.max(10, width - names - 8))
      : style.dim('not found');
    say(`${INDENT}  ${mark} ${row(agent.label, where, names + 2)}`);
  }
  say();

  const chosen = deps.agents.filter((a) => deps.chosen.includes(a.id));
  if (chosen.length === 0) {
    para(
      'None of the agents Stroq can guard was found here, and nothing was installed. Run `stroq init --agent <name>` for the one you use (claude-code, cursor, codex, copilot, openclaw, windsurf or antigravity).',
    );
    say();
    return 1;
  }

  // 3. What it will do, and the question.
  say(`${INDENT}${style.bold('What this does')}`);
  // An agent whose install is for the whole user (a Gateway's plugin) is that, whatever the scope.
  const scopeNote = chosen.every((agent) => agent.userWide === true)
    ? 'for the whole user'
    : deps.scope === 'user'
      ? 'in your user config'
      : 'in this project';
  const adds =
    chosen.length === 1
      ? `Stroq's hooks to ${path((chosen[0] as FlowAgent).where, width - LABEL_WIDTH - 14)} (${scopeNote})`
      : `Stroq's hooks to the config of each agent above that is marked (${scopeNote})`;
  const undo = chosen.map((agent) => undoCommand(agent, deps.scope));
  const undoFits = undo.every((command) => command.length <= width - LABEL_WIDTH - 4);
  const lines: [string, string][] = [
    ['adds', adds],
    [
      'reads',
      deps.reads.length > 0
        ? `credential files, to know which of your own keys your agent must not send out: ${deps.reads.map(outsideLine).join(', ')}. Only salted hashes are kept, never the values.`
        : 'credential files and project .env files, if there are any, to know which of your own keys your agent must not send out. Only salted hashes are kept, never the values.',
    ],
    [
      'writes',
      `${outsideLine(deps.home)}: the audit log, and what each session has read${
        deps.copiesCli === true
          ? `; and a copy of this CLI under ${outsideLine(deps.home)}/cli, which the hooks run, because npm prunes the cache it was started from`
          : ''
      }`,
    ],
    ...chosen
      .filter((agent) => agent.extra !== undefined)
      .map((agent): [string, string] => ['also', `${agent.label}: ${agent.extra}`]),
    // Beside the label where they all fit, and under it, one to a line, where one would not: a command is
    // not broken over two lines.
    undoFits
      ? [
          'undo',
          `${undo.map(unbreakable).join(', ')} (the hooks only: ${outsideLine(deps.home)} is yours to delete)`,
        ]
      : ['undo', `(the hooks only: ${outsideLine(deps.home)} is yours to delete)`],
  ];
  for (const [label, text] of lines) {
    const wrapped = wrapKeeping(text, width - LABEL_WIDTH - 2);
    wrapped.forEach((line, i) =>
      say(
        `${INDENT}  ${i === 0 ? style.dim(label.padEnd(LABEL_WIDTH)) : ' '.repeat(LABEL_WIDTH)}${line}`,
      ),
    );
  }
  if (!undoFits) for (const command of undo) say(`${INDENT}    ${command}`);
  say();

  const question =
    chosen.length === 1
      ? `Guard ${(chosen[0] as FlowAgent).label} ${scopeNote}?`
      : `Guard these ${chosen.length} agents ${scopeNote}?`;
  if (!deps.yes && !(await confirm(term, style, question, true))) {
    say();
    para('Nothing was changed.');
    say();
    // Not a success: `stroq init && claude` must not go on as if Claude Code were guarded.
    return 1;
  }
  if (deps.yes) {
    const answered = wrapKeeping(`${question} yes (--yes)`, width - 2);
    answered.forEach((line, i) =>
      say(
        `${INDENT}${i === 0 ? style.accent(symbols.ask) : ' '} ${line.replace(/yes \(--yes\)$/, (m) => style.dim(m))}`,
      ),
    );
  }
  say();

  // 4. Do it, one line for each thing.
  let failed = 0;
  let warned = false;
  /** Installed: the check runs for each. `waiting` are the ones whose note says what is left to do. */
  const guarded: FlowAgent[] = [];
  const waiting: FlowAgent[] = [];
  for (const agent of chosen) {
    const step = startStep(
      term,
      style,
      symbols,
      `Installing hooks for ${agent.label}`,
      deps.timers,
    );
    try {
      // The step has to end whatever the installer does, or its spinner turns until the process is killed.
      let installed: { readonly code: number; readonly out: string };
      try {
        installed = await deps.install(agent.id);
      } catch (err) {
        installed = { code: 1, out: `${messageOf(err)}\n` };
      }
      // A signal that came while the installer held the process (a copy of files) is answered here, by
      // the handlers of the step, and is not lost when the step ends in this turn.
      await settled();
      const { code, out } = installed;
      if (code !== 0) {
        failed += 1;
        const shown = failure(`${agent.label}: ${outside(reasonOf(out))}`);
        step.fail(shown.text, shown.under.map(style.dim));
        para(
          `Run \`stroq init --agent ${agent.id} --no-input\` to see everything it said.`,
          `${INDENT}  `,
          style.dim,
        );
        continue;
      }
      guarded.push(agent);
      const file = installedFile(out);
      const prefix = 'hooks installed in ';
      const inline = columns - MARK_WIDTH - agent.label.length - 2 - prefix.length;
      const shown =
        file === null
          ? said(agent.label, 'installed')
          : said(
              agent.label,
              `${prefix}${path(show(file), inline >= MIN_PATH ? inline : columns - MARK_WIDTH - prefix.length)}`,
            );
      step.succeed(shown.text, shown.under);
      let waits = false;
      let shownBlocks = 0;
      for (const block of noteBlocks(out)) {
        // What an installer says is bounded: a flood of it is not read, and not drawn.
        if (shownBlocks >= MAX_NOTE_BLOCKS) {
          para(
            `(… more: \`stroq init --agent ${agent.id} --no-input\` shows everything it said.)`,
            `${INDENT}    `,
            style.dim,
          );
          break;
        }
        shownBlocks += 1;
        if (block.kind === 'run') {
          // A command that was run for the person, and what it printed, as it printed it: dim, one
          // line each, and not read for what it says: it is not Stroq's.
          say(`${INDENT}    ${style.dim(`$ ${drawn(block.text)}`)}`);
          const room = Math.max(10, width - 10);
          for (const line of block.lines.slice(0, MAX_RUN_LINES)) {
            const shown = drawn(line);
            const cut =
              [...shown].length > room ? `${[...shown].slice(0, room - 1).join('')}…` : shown;
            say(`${INDENT}      ${style.dim(cut)}`);
          }
          if (block.lines.length > MAX_RUN_LINES)
            say(
              `${INDENT}      ${style.dim(`(… ${block.lines.length - MAX_RUN_LINES} more lines)`)}`,
            );
          continue;
        }
        if (block.kind === 'command') {
          // A command to copy is on one line, however long, and not dimmed: it is what to do.
          say(`${INDENT}      ${drawn(block.text)}`);
          continue;
        }
        const text = block.text.slice(0, MAX_NOTE_CHARS);
        if (WARNING_NOTE.test(text)) warned = true;
        if (NOT_YET_NOTE.test(text)) waits = true;
        para(drawn(text), `${INDENT}    `, style.dim);
      }
      if (waits) waiting.push(agent);
    } finally {
      // Whatever was thrown above, the spinner stops: this is a no-op for a step that ended.
      step.skip();
    }
  }

  // 5. Does what was written start, and judge?
  const checked = new Set<string>();
  for (const agent of guarded) {
    const command = deps.command(agent.id);
    if (command === null) continue;
    const step = startStep(term, style, symbols, `Checking ${agent.label}`, deps.timers);
    try {
      let result: SelfCheck | null;
      try {
        result = await deps.check(agent.id, command);
      } catch (err) {
        const shown = said(
          agent.label,
          `could not be checked (${outside(messageOf(err))}): start it, then run \`stroq doctor\``,
        );
        step.skip(shown.text, shown.under);
        continue;
      }
      if (result === null) {
        const shown = said(
          agent.label,
          "can't be tested from here: start it, then run `stroq doctor`",
        );
        step.skip(shown.text, shown.under);
        continue;
      }
      checked.add(agent.id);
      if (result.ok) {
        const shown = said(
          agent.label,
          `answered a harmless action in ${ms(result.allowed.ms)}, and denied a \`curl | sh\` in ${ms(result.denied.ms)} (default rules)`,
        );
        step.succeed(shown.text, shown.under);
      } else {
        failed += 1;
        const why = [
          result.allowed.verdict === 'allow'
            ? null
            : `a harmless action ${outside(result.allowed.detail) || 'was not allowed'}`,
          result.denied.verdict === 'deny'
            ? null
            : `a \`curl | sh\` ${outside(result.denied.detail) || 'was not denied'}`,
        ].filter((s): s is string => s !== null);
        const shown = said(agent.label, why.join('; '));
        step.fail(shown.text, shown.under);
        para(
          `The command that was written does not do what a hook must. Run \`stroq doctor\` to see why.`,
          `${INDENT}  `,
          style.dim,
        );
      }
    } finally {
      step.skip();
    }
  }
  say();

  // 6. Where to go next.
  // The commands that take an agent out, other than `stroq uninstall`'s: one each.
  const otherUndo = chosen.filter((agent) => agent.undo !== undefined);
  if (failed > 0) {
    para(
      `Something above did not work. \`stroq doctor\` says what is wrong with each agent, and what is in place; ${undo.length === 1 ? `\`${undo[0]}\`` : `\`stroq uninstall --agent <name>\`${otherUndo.length > 0 ? ` (${otherUndo.map((agent) => `${agent.label}: \`${agent.undo}\``).join(', ')})` : ''}`} takes the hooks out again.`,
    );
    say();
    return 1;
  }
  const ready = guarded.filter((agent) => !waiting.includes(agent));
  /** `A`, `A and B`, `A, B and C`. */
  const labels = (agents: readonly FlowAgent[]): string => {
    const names = agents.map((a) => a.label);
    return names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  const lead = `Done${warned ? ', but read the warning above' : ''}`;
  const their = waiting.length === 1 ? 'its note' : 'their notes';
  const say1 = waiting.length === 1 ? 'says' : 'say';
  // An agent that nothing started for a check has only been written to: it is said to be started once.
  const unchecked = ready.filter((agent) => !checked.has(agent.id));
  const caveat =
    unchecked.length === 0
      ? ''
      : unchecked.length === ready.length
        ? ' (start it once, then run `stroq doctor` to see the first call)'
        : ` (start ${labels(unchecked)} once, then run \`stroq doctor\` to see the first call)`;
  const headline =
    waiting.length === 0
      ? `${lead}. Stroq is guarding ${labels(ready)}${caveat}.`
      : ready.length === 0
        ? `${lead}. Stroq is not guarding ${labels(waiting)} yet: do what ${their} above ${say1} first.`
        : `${lead}. Stroq is guarding ${labels(ready)}${caveat}; ${labels(waiting)} not yet: do what ${their} above ${say1} first.`;
  const done = wrapKeeping(headline, width);
  done.forEach((line, i) =>
    say(`${INDENT}${i === 0 ? line.replace(/^Done/, style.bold('Done')) : line}`),
  );
  say();
  say(`${INDENT}${style.bold('Try next')}`);
  const next: [string, string][] = [
    ['stroq sent --last', 'which of your credentials did your agent already see?'],
    ['stroq why', 'why the last action was denied or asked about'],
    ['stroq doctor', 'the hooks, and when your agent last called them'],
    ...(undo.length === 1
      ? ([
          [
            undo[0] as string,
            chosen[0]?.undo === undefined
              ? 'take the hooks out again'
              : 'switch the plugin off again',
          ],
        ] as [string, string][])
      : ([
          ['stroq uninstall --agent <name>', 'take the hooks of one agent out again'],
          ...otherUndo.map((agent): [string, string] => [
            agent.undo as string,
            `switch ${agent.label} off again`,
          ]),
        ] as [string, string][])),
  ];
  const cmdWidth = Math.max(...next.map(([c]) => c.length)) + 3;
  // Where the longest command leaves too little for what it means, the meaning goes under it.
  const stacked = cmdWidth + 14 > width;
  for (const [command, meaning] of next) {
    if (stacked) {
      say(`${INDENT}  ${style.accent(command)}`);
      for (const line of wrapKeeping(meaning, width - 4, 0)) say(`${INDENT}    ${style.dim(line)}`);
      continue;
    }
    const [first = '', ...more] = wrapKeeping(meaning, Math.max(10, width - cmdWidth - 2), 0);
    say(`${INDENT}  ${row(style.accent(command), style.dim(first), cmdWidth)}`);
    for (const line of more) say(`${INDENT}  ${' '.repeat(cmdWidth)}${style.dim(line)}`);
  }
  say();
  return 0;
}
