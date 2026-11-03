import type { ToolCall } from './platform-types';

export const DECISIONS = {
  block: { label: 'Deny', tone: 'red' },
  ask: { label: 'Ask', tone: 'orange' },
  flag: { label: 'Flagged', tone: 'orange' },
  allow: { label: 'Allow', tone: 'green' },
  nj: { label: 'Not evaluated', tone: 'muted' },
} as const;

export function sessionFor(call: ToolCall) {
  const id = call.sessionId ?? 'unattributed';
  return {
    id,
    name: id === 'unattributed' ? 'Unattributed activity' : id,
    project: 'Project not recorded',
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
