'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validatePolicy,
  type PolicyState,
  type PolicyPreview,
  type PolicyReceipt,
  type PolicyEffect,
} from '@/lib/policy-control';
import {
  validateIncidentComparison,
  type IncidentComparison,
  type RecordedActionClass,
} from '@/lib/incident-comparison';
import { policyReadAllowed, type PolicyLocationSelection } from '@/lib/policy-navigation';
import {
  policyApplyInput,
  policyPreviewMatches,
  policyReceiptMatches,
  type PolicyRequestedChanges,
} from '@/lib/policy-binding';

interface Workbench {
  key: string;
  state: PolicyState | null;
  preview: PolicyPreview | null;
  receipt: PolicyReceipt | null;
  error: string | null;
  busy: 'load' | 'preview' | 'apply' | null;
  effect: PolicyEffect;
  threshold: number;
  promoted: number[];
  denyClasses: RecordedActionClass[];
  ack: boolean;
  ackSharedScope: boolean;
  eventComparison: IncidentComparison | null;
  eventError: string | null;
  eventBusy: boolean;
  eventMessage: string | null;
  needsRecheck: boolean;
}
const empty = (key: string): Workbench => ({
  key,
  state: null,
  preview: null,
  receipt: null,
  error: null,
  busy: null,
  effect: 'allow',
  threshold: 0.6,
  promoted: [],
  denyClasses: [],
  ack: false,
  ackSharedScope: false,
  eventComparison: null,
  eventError: null,
  eventBusy: false,
  eventMessage: null,
  needsRecheck: false,
});
const clearPreview = { preview: null, receipt: null, ack: false, ackSharedScope: false };

/** Only explicit actions POST. URL changes invalidate requests, drafts, consent and receipts. */
export function usePolicySettings(selection: PolicyLocationSelection) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const readAllowed = policyReadAllowed(selection, workspaceId);
  const locationKey = readAllowed
    ? `${workspaceId}:${selection.incidentId ?? 'overview'}`
    : 'unavailable';
  const entered = useRef({ locationKey, generation: 0 });
  if (entered.current.locationKey !== locationKey)
    entered.current = { locationKey, generation: entered.current.generation + 1 };
  const key = `${locationKey}:${entered.current.generation}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const active = useRef<{
    key: string;
    controller: AbortController;
    operation: string;
    cancelTimer: () => void;
  } | null>(null);
  const [stored, setStored] = useState<Workbench>(() => empty(key));
  const model = stored.key === key && readAllowed ? stored : empty(key);
  const update = useCallback(
    (change: (before: Workbench) => Workbench) => {
      if (currentKey.current !== key) return;
      setStored((before) => change(before.key === key ? before : empty(key)));
    },
    [key],
  );
  const begin = useCallback(
    (operation: string, timeout: number) => {
      if (!readAllowed || currentKey.current !== key) return null;
      active.current?.controller.abort();
      active.current?.cancelTimer();
      const controller = new AbortController();
      const record = { key, controller, operation, cancelTimer: () => clearTimeout(timer) };
      active.current = record;
      const timer = setTimeout(() => {
        controller.abort();
        if (currentKey.current !== key || active.current !== record) return;
        active.current = null;
        update((before) => ({
          ...before,
          preview: null,
          ack: false,
          ackSharedScope: false,
          busy: null,
          eventBusy: false,
          ...(operation === 'event'
            ? { eventError: 'The event comparison timed out. No action categories were selected.' }
            : {
                needsRecheck: true,
                ...(operation === 'load' ? { state: null } : {}),
                error:
                  operation === 'apply'
                    ? 'Completion could not be verified. The policy may have changed. Recheck before another action.'
                    : 'This operation timed out. Recheck the policy before another action.',
              }),
        }));
      }, timeout);
      return {
        controller,
        current: () => currentKey.current === key && active.current === record,
        valid: () =>
          currentKey.current === key && active.current === record && !controller.signal.aborted,
        finish: () => {
          clearTimeout(timer);
          if (active.current === record) active.current = null;
        },
      };
    },
    [key, readAllowed, update],
  );
  const load = useCallback(
    async (receipt?: PolicyReceipt) => {
      if (active.current?.operation === 'apply') return;
      const run = begin('load', 20_000);
      if (!run) return;
      update(() => ({ ...empty(key), busy: 'load', receipt: receipt ?? null }));
      try {
        const value = await requestLocal('/api/policy', undefined, run.controller.signal);
        if (!run.valid()) throw new Error();
        if (!validatePolicy(value)) throw new Error();
        update((before) => ({
          ...before,
          state: value,
          effect: value.defaultEffect ?? 'allow',
          threshold: value.threshold ?? 0.6,
          busy: null,
          needsRecheck: false,
          error:
            receipt &&
            (value.policyFingerprint !== receipt.policyFingerprint ||
              value.expectedRawSha !== receipt.rawSha)
              ? 'The saved revision was acknowledged, but the current policy has changed. Review it before another action.'
              : null,
        }));
      } catch {
        if (run.current())
          update((before) => ({
            ...before,
            state: null,
            busy: null,
            needsRecheck: true,
            error:
              'Current policy could not be rechecked. No current configuration claim is available.',
          }));
      } finally {
        run.finish();
      }
    },
    [begin, key, requestLocal, update],
  );
  useEffect(() => {
    if (readAllowed) void load();
    else setStored(empty(key));
    return () => {
      active.current?.controller.abort();
      active.current?.cancelTimer();
      active.current = null;
    };
  }, [key, readAllowed, load]);

  const edit = (change: (before: Workbench) => Partial<Workbench>) => {
    if (model.busy || model.eventBusy || model.needsRecheck) return;
    update((before) => ({ ...before, ...change(before), ...clearPreview, eventMessage: null }));
  };
  const setEffect = (effect: PolicyEffect) => edit(() => ({ effect }));
  const setThreshold = (threshold: number) => edit(() => ({ threshold }));
  const togglePromoted = (index: number) =>
    edit((before) => ({
      promoted: before.promoted.includes(index)
        ? before.promoted.filter((item) => item !== index)
        : [...before.promoted, index],
    }));
  const toggleDenyClass = (action: RecordedActionClass) =>
    edit((before) => ({
      denyClasses: before.denyClasses.includes(action)
        ? before.denyClasses.filter((item) => item !== action)
        : [...before.denyClasses, action].sort(),
    }));
  const setAck = (ack: boolean) => {
    if (!model.busy) update((before) => ({ ...before, ack }));
  };
  const setAckSharedScope = (ackSharedScope: boolean) => {
    if (!model.busy) update((before) => ({ ...before, ackSharedScope }));
  };
  const changed = Boolean(
    model.state &&
    (model.effect !== model.state.defaultEffect ||
      model.threshold !== model.state.threshold ||
      model.promoted.length ||
      model.denyClasses.length),
  );
  const disabled = Boolean(
    model.busy || model.eventBusy || model.needsRecheck || !model.state?.editable || !readAllowed,
  );

  const prepare = async () => {
    const state = model.state;
    if (disabled || !changed || !state || active.current) return;
    const changes: PolicyRequestedChanges = {};
    if (model.effect !== state.defaultEffect && model.effect !== 'allow')
      changes.defaultEffect = model.effect;
    if (model.threshold !== state.threshold) changes.threshold = model.threshold;
    if (model.promoted.length) changes.promoteRuleIndexes = [...model.promoted];
    if (model.denyClasses.length) changes.denyActionClasses = [...model.denyClasses];
    const run = begin('preview', 90_000);
    if (!run) return;
    update((before) => ({ ...before, ...clearPreview, busy: 'preview', error: null }));
    try {
      const value = await requestLocal(
        '/api/policy/preview',
        { expectedRawSha: state.expectedRawSha, changes },
        run.controller.signal,
      );
      if (!run.valid()) throw new Error();
      if (!policyPreviewMatches(value, state, changes)) throw new Error();
      update((before) => ({ ...before, preview: value, busy: null }));
    } catch {
      if (run.current())
        update((before) => ({
          ...before,
          busy: null,
          error:
            'No verified preview was prepared. The selection may already be denied, or policy evidence changed. Recheck before trying again.',
        }));
    } finally {
      run.finish();
    }
  };
  const apply = async () => {
    const preview = model.preview;
    if (!preview || disabled || active.current) return;
    const input = policyApplyInput(preview, model.ack, model.ackSharedScope);
    if (!input) {
      if (Date.parse(preview.expiresAt) <= Date.now())
        update((before) => ({
          ...before,
          preview: null,
          ack: false,
          ackSharedScope: false,
          error: 'This preview expired. Prepare a new preview.',
        }));
      return;
    }
    const run = begin('apply', 20_000);
    if (!run) return;
    update((before) => ({
      ...before,
      busy: 'apply',
      needsRecheck: true,
      error: null,
      ack: false,
      ackSharedScope: false,
    }));
    let receipt: PolicyReceipt | null = null;
    try {
      const value = await requestLocal('/api/policy/apply', input, run.controller.signal);
      if (!run.valid()) throw new Error();
      if (!policyReceiptMatches(value, preview)) throw new Error();
      receipt = value;
      update((before) => ({ ...before, preview: null, receipt: value, busy: null }));
    } catch {
      if (run.current())
        update((before) => ({
          ...before,
          preview: null,
          busy: null,
          needsRecheck: true,
          error:
            'Completion could not be verified. The policy may have changed. Recheck before another action.',
        }));
    } finally {
      run.finish();
    }
    if (receipt && currentKey.current === key) await load(receipt);
  };
  const loadEventDraft = async () => {
    const state = model.state;
    if (disabled || !state || !selection.incidentId || active.current) return;
    const run = begin('event', 20_000);
    if (!run) return;
    update((before) => ({
      ...before,
      ...clearPreview,
      eventBusy: true,
      eventError: null,
      eventMessage: null,
      eventComparison: null,
      denyClasses: [],
    }));
    try {
      const value = await requestLocal(
        '/api/incidents/compare',
        {
          id: selection.incidentId,
          expectedEvidenceSha: selection.incidentId.slice('incident-'.length),
        },
        run.controller.signal,
      );
      if (!run.valid()) throw new Error();
      if (
        !validateIncidentComparison(value) ||
        value.incidentId !== selection.incidentId ||
        value.currentPolicy.semanticSha !== state.policyFingerprint ||
        value.currentPolicy.rawSha !== state.expectedRawSha
      )
        throw new Error();
      const covered = value.scenarios.every((row) => row.effect === 'deny');
      update((before) => ({
        ...before,
        eventComparison: value,
        eventBusy: false,
        denyClasses: covered ? [] : [...value.classes].sort(),
        eventMessage: covered
          ? 'Both recorded-class scenarios already return Deny. No new block was selected.'
          : value.classes.length
            ? 'Recorded action categories selected. Review their full scope before previewing.'
            : 'This record contains no action categories to select.',
      }));
    } catch {
      if (run.current())
        update((before) => ({
          ...before,
          eventBusy: false,
          eventError:
            'The exact event and current policy could not be matched. No action categories were selected.',
        }));
    } finally {
      run.finish();
    }
  };
  return {
    ...model,
    workspaceId,
    readAllowed,
    changed,
    disabled,
    load: () => load(),
    setEffect,
    setThreshold,
    togglePromoted,
    toggleDenyClass,
    setAck,
    setAckSharedScope,
    prepare,
    apply,
    loadEventDraft,
  };
}
