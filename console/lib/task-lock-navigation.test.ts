import { describe, expect, it } from 'vitest';
import { taskLockHref, taskLockReadAllowed, taskLockSelection } from './task-lock-navigation';
const ws = `workspace-${'a'.repeat(24)}`,
  task = `task-${'b'.repeat(64)}`;
describe('task permission local navigation', () => {
  it('round-trips an exact hashed task and workspace without exposing a store path', () => {
    const href = taskLockHref(task, ws);
    const selected = taskLockSelection(new URL(href, 'http://local.test').searchParams);
    expect(selected).toEqual({
      requested: true,
      invalid: false,
      taskId: task,
      workspaceId: ws,
      expectedPermitSha256: null,
      originIncidentId: null,
    });
    expect(taskLockReadAllowed(selected, ws)).toBe(true);
    expect(taskLockReadAllowed(selected, `workspace-${'c'.repeat(24)}`)).toBe(false);
    expect(taskLockReadAllowed(selected, null)).toBe(false);
  });
  it('rejects partial, duplicate, empty or raw selectors and never falls back to another task', () => {
    for (const query of [
      `task=${task}`,
      `workspace=${ws}`,
      `task=${task}&workspace=${ws}&task=${task}`,
      `task=${task}&workspace=${ws}&workspace=${ws}`,
      `task=&workspace=${ws}`,
      `task=private-name&workspace=${ws}`,
      `task=${task}&workspace=/private/work`,
    ]) {
      const selected = taskLockSelection(new URLSearchParams(query));
      expect(selected.invalid).toBe(true);
      expect(selected.taskId).toBeNull();
      expect(taskLockReadAllowed(selected, ws)).toBe(false);
    }
  });
  it('keeps plain overview readable and generator failures return an explicit overview', () => {
    expect(taskLockSelection(new URLSearchParams())).toEqual({
      requested: false,
      invalid: false,
      taskId: null,
      workspaceId: null,
      expectedPermitSha256: null,
      originIncidentId: null,
    });
    expect(taskLockReadAllowed(taskLockSelection(new URLSearchParams()), ws)).toBe(true);
    expect(taskLockHref('/private/task', ws)).toBe('/agents/tasks/');
  });
  it('binds a finding handoff to the exact current permit while retaining the selected finding', () => {
    const permit = 'd'.repeat(64),
      incident = `incident-${'e'.repeat(64)}`;
    const href = taskLockHref(task, ws, { permitSha256: permit, incidentId: incident });
    const selected = taskLockSelection(new URL(href, 'http://local.test').searchParams);
    expect(selected.invalid).toBe(false);
    expect(selected.expectedPermitSha256).toBe(permit);
    expect(selected.originIncidentId).toBe(incident);
  });
  it('refuses partial, malformed or duplicated handoff fields instead of dropping their bindings', () => {
    const base = `task=${task}&workspace=${ws}`,
      permit = 'd'.repeat(64),
      incident = `incident-${'e'.repeat(64)}`;
    for (const query of [
      `permit=${permit}`,
      `incident=${incident}`,
      `${base}&incident=${incident}`,
      `${base}&permit=bad`,
      `${base}&permit=${permit}&incident=bad`,
      `${base}&permit=${permit}&permit=${permit}`,
      `${base}&permit=${permit}&incident=${incident}&incident=${incident}`,
    ]) {
      const selected = taskLockSelection(new URLSearchParams(query));
      expect(selected.invalid).toBe(true);
      expect(selected.taskId).toBeNull();
      expect(taskLockReadAllowed(selected, ws)).toBe(false);
    }
    expect(taskLockHref(task, ws, { incidentId: incident })).toBe('/agents/tasks/');
  });
});
