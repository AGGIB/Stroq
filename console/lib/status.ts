// Every status the console can show: a glyph, a tone and the words. Colour never stands alone.

export type Tone = 'red' | 'green' | 'amber' | 'amber-outline' | 'grey';
export type Glyph = 'x' | 'check' | 'question' | 'exclaim' | 'flag' | 'eye' | 'minus' | 'send';

export type Decision = 'block' | 'ask' | 'flag' | 'allow' | 'nj';
export type KeyOutcome = 'sent' | 'maybe' | 'stopped' | 'own' | 'seen' | 'unread';
export type GuardState = 'ok' | 'unver' | 'watch' | 'off' | 'failed';
export type Check = 'yes' | 'no' | 'notyet' | 'na';
export type StepKind = 'tried' | 'kept';

export type StatusKind = Decision | KeyOutcome | GuardState | Check | StepKind;

export interface StatusSpec {
  readonly glyph: Glyph;
  readonly tone: Tone;
  readonly label: string;
}

export const STATUS: Readonly<Record<StatusKind, StatusSpec>> = {
  block: { glyph: 'x', tone: 'red', label: 'Blocked' },
  ask: { glyph: 'question', tone: 'amber', label: 'Asked you' },
  flag: { glyph: 'flag', tone: 'amber-outline', label: 'Flagged' },
  allow: { glyph: 'check', tone: 'green', label: 'Allowed' },
  nj: { glyph: 'eye', tone: 'grey', label: 'Not judged' },
  sent: { glyph: 'send', tone: 'red', label: 'Sent' },
  maybe: { glyph: 'question', tone: 'amber', label: 'Maybe sent' },
  stopped: { glyph: 'x', tone: 'red', label: 'Blocked before it ran' },
  own: { glyph: 'check', tone: 'green', label: 'Used with its own service' },
  seen: { glyph: 'eye', tone: 'grey', label: 'Seen by the AI' },
  unread: { glyph: 'minus', tone: 'grey', label: 'Not read' },
  ok: { glyph: 'check', tone: 'green', label: 'Protected' },
  unver: { glyph: 'exclaim', tone: 'amber', label: 'Not tested' },
  watch: { glyph: 'eye', tone: 'grey', label: 'Watch only' },
  off: { glyph: 'minus', tone: 'grey', label: 'Off' },
  failed: { glyph: 'x', tone: 'red', label: 'Failed' },
  yes: { glyph: 'check', tone: 'green', label: 'Yes' },
  no: { glyph: 'x', tone: 'red', label: 'No' },
  notyet: { glyph: 'question', tone: 'amber', label: 'Not yet' },
  na: { glyph: 'minus', tone: 'grey', label: 'Not applicable' },
  tried: { glyph: 'send', tone: 'grey', label: 'Tried' },
  kept: { glyph: 'check', tone: 'green', label: 'Key stayed' },
};

export const DECISION_HELP: ReadonlyArray<readonly [Decision, string]> = [
  ['block', 'Stroq stopped the call. The agent got the reason instead.'],
  ['ask', 'Stroq paused the call and asked you. You chose.'],
  [
    'flag',
    'Text the agent read looks like an instruction to it. Later calls in that session are checked harder.',
  ],
  ['allow', 'Nothing risky found. The call ran.'],
  ['nj', 'The agent ran it without asking Stroq. Stroq read it from the session file afterwards.'],
];

export const GUARD_HELP: ReadonlyArray<readonly [GuardState, string]> = [
  ['ok', 'Stroq made the agent try a harmless command the policy blocks and saw it refuse.'],
  ['unver', "Stroq is in the agent's hooks, but blocking was never tested."],
  ['watch', "No hooks. Stroq reads the agent's sessions later, so it can report but not block."],
  ['off', 'The agent is on this Mac, but Stroq is not in its hooks.'],
  ['failed', 'The agent ran a command Stroq blocked, or skipped the hook. Treat it as unguarded.'],
];
