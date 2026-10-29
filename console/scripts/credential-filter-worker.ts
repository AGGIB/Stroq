import { parentPort, workerData } from 'node:worker_threads';
import {
  CREDENTIAL_FILTER_REASONS,
  CREDENTIAL_FILTER_LIMITATIONS,
  CREDENTIAL_FILTER_TARGETS,
  type CredentialFilterTarget,
} from '../lib/credential-filters.ts';
import {
  filterState,
  prepareFilter,
  applyFilter,
  type Options,
} from './credential-filter-operations.ts';
import { hash } from './credential-filter-targets.mjs';
import { safeError, unavailableRow } from './credential-filter-inspect.ts';

async function run() {
  const options: Options = {
    project: workerData.project,
    userHome: workerData.userHome,
    home: workerData.home,
    platform: workerData.platform,
    claudeConfigDir: workerData.claudeConfigDir,
    version: workerData.version,
    deadline: workerData.deadline,
  };
  if (workerData.operation === 'state') {
    try {
      return {
        kind: 'result',
        body: await filterState(options, workerData.runtimeAvailable === true),
      };
    } catch {
      return {
        kind: 'result',
        body: {
          schema: 'stroq-credential-filters/1',
          source: 'local',
          workspaceId: `workspace-${hash(options.project).slice(0, 24)}`,
          generatedAt: new Date().toISOString(),
          available: false,
          reason: 'credential-filter-context-unavailable',
          targets: (Object.keys(CREDENTIAL_FILTER_TARGETS) as CredentialFilterTarget[]).map((id) =>
            unavailableRow(
              {
                id,
                ...CREDENTIAL_FILTER_TARGETS[id],
                location: id === 'claude-user' ? 'user' : 'workspace',
                context: id === 'claude-user' ? 'all-workspaces' : 'workspace',
              },
              'credential-filter-context-unavailable',
            ),
          ),
          limitations: CREDENTIAL_FILTER_LIMITATIONS,
        },
      };
    }
  }
  if (workerData.operation === 'preview')
    return {
      kind: 'plan',
      ...(await prepareFilter(
        options,
        workerData.input,
        workerData.previewId,
        workerData.expiresAt,
      )),
    };
  if (workerData.operation === 'apply')
    return {
      kind: 'result',
      body: await applyFilter(options, workerData.plan, workerData.fault ?? null),
    };
  throw new Error('invalid-request');
}
try {
  parentPort?.postMessage(await run());
} catch (error) {
  const message = (error as Error).message;
  const code = ['invalid-request', 'deadline-exceeded'].includes(message)
    ? message
    : safeError(error);
  parentPort?.postMessage({
    error:
      Object.hasOwn(CREDENTIAL_FILTER_REASONS, code) ||
      ['invalid-request', 'deadline-exceeded'].includes(code)
        ? code
        : 'credential-filter-unavailable',
  });
}
