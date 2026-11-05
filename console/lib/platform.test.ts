import { describe, expect, it } from 'vitest';
import { inRange, sessionFor } from './platform';
import type { ToolCall } from './platform-types';

const row = (date: string, time: string): ToolCall => ({
  id: `${date}-${time}`,
  date,
  time,
  agent: 'Unknown host',
  decision: 'allow',
  label: 'Policy allowed a tool call',
  raw: 'Command and content withheld',
});
describe('calendar ranges and attribution', () => {
  it('Today is the UTC calendar day, including midnight and the last second', () => {
    const calls = [
      row('2026-10-20', '23:59:59'),
      row('2026-10-21', '00:00:00'),
      row('2026-10-21', '23:59:59'),
      row('2026-10-22', '00:00:00'),
    ];
    expect(inRange(calls, 1, '2026-10-21T14:00:00Z')).toEqual(calls.slice(1, 3));
  });
  it('seven calendar days contain their first day and exclude the preceding day', () => {
    const calls = [
      row('2026-10-14', '23:59:59'),
      row('2026-10-15', '00:00:00'),
      row('2026-10-21', '12:00:00'),
    ];
    expect(inRange(calls, 7, '2026-10-21T14:00:00Z')).toEqual(calls.slice(1));
  });
  it('does not invent local project or agent attribution', () => {
    expect(sessionFor(row('2026-10-21', '12:00'))).toEqual({
      id: 'unattributed',
      name: 'Unattributed activity',
      project: 'Project not recorded',
    });
    expect(
      sessionFor({ ...row('2026-10-21', '12:00'), sessionId: 'session-0123456789abcdef' }).project,
    ).toBe('Project not recorded');
  });
});
