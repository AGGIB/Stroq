import { CALLS, TODAY, type ToolCall } from './data';

const ORDINARY = [
  ['Run the test suite', 'pnpm test'],
  ['Read application source', 'src/app.ts'],
  ['Search project files', 'rg webhook src/'],
  ['Check working tree', 'git status --short'],
  ['Read project documentation', 'README.md'],
  ['Run type checking', 'pnpm typecheck'],
  ['Inspect staged changes', 'git diff --stat'],
  ['Read package manifest', 'package.json'],
] as const;

// A deterministic, explicitly labelled demonstration. Every metric is derived from these rows.
export const DEMO_CALLS: readonly ToolCall[] = [
  ...CALLS.map((call) => ({
    ...call,
    sessionId:
      call.agent === 'Cursor'
        ? 'demo-cursor-01'
        : call.agent === 'Codex CLI'
          ? 'demo-codex-01'
          : 'demo-claude-01',
  })),
  ...[36, 24, 39, 18, 28, 16, 22].flatMap((amount, offset) =>
    Array.from({ length: amount }, (_, index): ToolCall => {
      const i = offset * 100 + index;
      const date = new Date(`${TODAY}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() - offset);
      const entry = ORDINARY[i % ORDINARY.length]!;
      const agent = i % 5 === 0 ? 'Cursor' : i % 7 === 0 ? 'Codex CLI' : 'Claude Code';
      return {
        id: `demo-${i}`,
        decision: 'allow',
        label: entry[0],
        raw: entry[1],
        agent,
        date: date.toISOString().slice(0, 10),
        time: `${String(8 + (i % 5)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
        sessionId: `demo-${agent === 'Cursor' ? 'cursor' : agent === 'Codex CLI' ? 'codex' : 'claude'}-${offset < 2 ? '01' : String(offset).padStart(2, '0')}`,
      };
    }),
  ),
].toSorted((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));

export const DECISIONS = {
  block: { label: 'Deny', tone: 'red' },
  ask: { label: 'Ask', tone: 'orange' },
  flag: { label: 'Flagged', tone: 'orange' },
  allow: { label: 'Allow', tone: 'green' },
  nj: { label: 'Not evaluated', tone: 'muted' },
} as const;

export function sessionFor(call: ToolCall) {
  const id = call.sessionId ?? 'unattributed';
  if (!id.startsWith('demo-'))
    return {
      id,
      name: id === 'unattributed' ? 'Unattributed activity' : id,
      project: 'Project not recorded',
    };
  const cursor = id.includes('cursor'),
    codex = id.includes('codex');
  return {
    id,
    name: cursor
      ? 'Refactor authentication'
      : codex
        ? 'Update API documentation'
        : 'Build billing webhooks',
    project: cursor ? 'acme / dashboard' : codex ? 'acme / docs' : 'acme / payments',
  };
}

export function inRange(calls: readonly ToolCall[], days: number, anchor: string) {
  const end = Date.parse(`${anchor.slice(0, 10)}T23:59:59Z`);
  const start = end - days * 86_400_000;
  return calls.filter((c) => {
    const t = Date.parse(`${c.date}T${c.time}Z`);
    return t > start && t <= end;
  });
}

export function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
