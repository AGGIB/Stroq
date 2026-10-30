import {
  validateCodexSkillControlSelection,
  type CodexSkillControlSelection,
} from '../lib/codex-skill-controls.ts';
import {
  collectCodexSkillSources,
  type PrivateCodexSkillCandidate,
} from './codex-skill-source-capture.ts';
import { captureCodexSkillSourceContext } from './codex-skill-source-context.ts';
import { assertUnchanged } from './agent-setup-files.mjs';
import {
  controlContext,
  sourceSnapshot,
  same,
  fail,
  type ControlOptions,
} from './codex-skill-control-binding.ts';
/** Resolves only opaque source/candidate identities in a fresh complete server capture. */
export async function selectCodexSkillControl(
  options: ControlOptions,
  request: CodexSkillControlSelection,
) {
  if (
    !validateCodexSkillControlSelection(request) ||
    request.expectedRuntimeSha256 !== options.runtimeSha256
  )
    fail('codex-control-stale');
  const context = await captureCodexSkillSourceContext(options);
  if (!context.controlContextId || context.controlContextId !== request.controlContextId)
    fail('codex-control-stale');
  let documents: PrivateCodexSkillCandidate[] = [];
  const report = await collectCodexSkillSources(context, {
    deadline: options.deadline,
    runtimeSha256: options.runtimeSha256,
    onPrivateCapture: (v) => {
      documents = v;
    },
  });
  const item = report.items.find(
    (v) => v.id === request.candidateId && v.sourceId === request.sourceId,
  );
  const row = report.sources.find((v) => v.id === request.sourceId);
  const document = documents.find(
    (v) => v.id === request.candidateId && v.sourceId === request.sourceId,
  );
  if (
    !item ||
    !row ||
    !document ||
    item.entrypointSha256 !== request.expectedEntrypointSha256 ||
    report.settings.sha256 !== request.expectedConfigSha256
  )
    fail('codex-control-stale');
  if (
    context.configuration.ignoredRules !== 0 ||
    row.status !== 'complete' ||
    item.metadata !== 'valid' ||
    item.scan.status === 'incomplete' ||
    !document.name ||
    !['ready', 'missing'].includes(report.settings.status)
  )
    fail('codex-control-incomplete');
  if (item.declaredState === 'disabled') fail('codex-control-already-disabled');
  if (item.declaredState === 'unknown') fail('codex-control-incomplete');
  const selected = await controlContext(options),
    before = await sourceSnapshot(selected);
  if (
    selected.id !== request.controlContextId ||
    before.sha256 !== (request.expectedConfigSha256 ?? 'absent')
  )
    fail('codex-control-stale');
  await context.assertCurrent();
  const sameNameCopies = documents.filter(
    (d) =>
      d.id !== document.id &&
      d.name === document.name &&
      report.items.some((i) => i.id === d.id && i.metadata === 'valid'),
  ).length;
  return { context: selected, before, item, document, sameNameCopies };
}
export async function assertSelectedCandidate(
  pin: {
    root: PrivateCodexSkillCandidate['root'];
    path: string;
    snapshot: PrivateCodexSkillCandidate['snapshot'];
  } | null,
) {
  if (!pin) return;
  try {
    const current = await assertUnchanged(pin.root, pin.path, pin.snapshot);
    if (!same(current.directories, pin.snapshot.directories)) fail('codex-control-stale');
  } catch {
    // A pinned selection becoming unreadable, replaced or changed invalidates this preview.
    fail('codex-control-stale');
  }
}
