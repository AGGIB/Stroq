import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuditLog,
  FileKeyStore,
  FilePermitStore,
  SignedPermitSchema,
  isTaskId,
  newEscalationBody,
  readRegularFile,
  signEscalation,
  verifyPermit,
  type SignedPermit,
} from '@stroq/core';
import { stroqHome } from '../paths.js';
import { confirmTask } from './task.js';

export interface PermitDeps {
  readonly home?: string;
  readonly now?: () => Date;
  readonly confirm?: () => Promise<boolean>;
}

function readTask(home: string, taskId: string, now: Date, archived = false): SignedPermit {
  let stored: ReturnType<typeof readRegularFile> | null = null;
  if (archived) {
    try {
      stored = readRegularFile(join(home, 'tasks', taskId, 'permit.json'), 64 * 1024, {
        noFollow: true,
      });
    } catch {
      /* The permit store supplies the fail-closed missing/unreadable reason below. */
    }
  }
  const found =
    stored?.kind === 'text'
      ? { kind: 'present' as const, text: stored.text }
      : new FilePermitStore({ home }).readPermit(taskId);
  if (found.kind !== 'present')
    throw new Error(`task permit unavailable: ${found.kind === 'void' ? found.reason : 'missing'}`);
  const signed = SignedPermitSchema.parse(JSON.parse(found.text));
  const publicKey = new FileKeyStore({ home }).readPublicKey();
  if (publicKey.kind !== 'ok') throw new Error('permit public key is unavailable');
  const checked = verifyPermit(found.text, publicKey.key, {
    now: archived ? new Date(signed.body.issuedAt) : now,
    nonce: signed.body.nonce,
    projectRoot: signed.body.projectRoot,
    policyDigest: signed.body.policyDigest,
    stateDigests: signed.body.stateDigests,
    sessionId: signed.body.sessionId,
    taskId,
  });
  if (!checked.ok) throw new Error(`invalid permit: ${checked.reason}`);
  return signed;
}

export async function runPermit(argv: readonly string[], deps: PermitDeps = {}): Promise<number> {
  const [verb, taskId, fingerprint] = argv;
  const home = deps.home ?? stroqHome();
  const now = (deps.now ?? (() => new Date()))();
  if (verb === 'list' && argv.length === 1) return listPermits(home, now);
  if (
    !isTaskId(taskId) ||
    !['show', 'extend', 'revoke'].includes(verb ?? '') ||
    argv.length !== (verb === 'extend' ? 3 : 2)
  )
    throw new Error(
      'usage: stroq permit list | show <task> | extend <task> <fingerprint> | revoke <task>',
    );
  if (verb === 'revoke') {
    readTask(home, taskId, now, true);
    new FilePermitStore({ home }).revoke(taskId);
    process.stdout.write(
      `Revoked task ${taskId}; further tools are denied and the launcher stops the agent when it observes revocation.\n`,
    );
    return 0;
  }
  const signed = readTask(home, taskId, now, verb === 'show');
  if (verb === 'show') {
    process.stdout.write(`${JSON.stringify(signed.body, null, 2)}\n`);
    return 0;
  }
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error('invalid operation fingerprint');
  return extendPermit(home, signed, fingerprint, deps);
}

function listPermits(home: string, now: Date): number {
  let ids: string[];
  try {
    ids = readdirSync(join(home, 'tasks')).filter(isTaskId).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    ids = [];
  }
  for (const id of ids) {
    const found = new FilePermitStore({ home }).readPermit(id);
    let status: string = found.kind === 'void' ? found.reason : found.kind;
    if (found.kind === 'present') {
      try {
        status =
          Date.parse(readTask(home, id, now, true).body.expiresAt) <= now.getTime()
            ? 'expired'
            : 'active';
      } catch {
        status = 'invalid';
      }
    }
    process.stdout.write(`${id}\t${status}\n`);
  }
  return 0;
}

async function extendPermit(
  home: string,
  signed: SignedPermit,
  fingerprint: string,
  deps: PermitDeps,
): Promise<number> {
  const taskId = signed.body.taskId;
  const audit = new AuditLog(join(home, 'audit.jsonl'));
  if (!(await audit.verify()).ok) throw new Error('audit chain is not valid; no extension issued');
  const refused = (await audit.readAll())
    .reverse()
    .find(
      (entry) =>
        entry.taskId === taskId &&
        entry.phase === 'pre' &&
        entry.scope !== undefined &&
        entry.scope.fingerprint === fingerprint &&
        entry.decision?.effect === 'deny' &&
        ['scope', 'ask'].includes(entry.scope.kind),
    );
  if (refused === undefined)
    throw new Error('no extendable refused operation with that fingerprint');
  if (
    refused.operation === undefined ||
    refused.operation.startsWith('[REDACTED:secret-index-unavailable]')
  )
    throw new Error(
      'the complete redacted operation is unavailable; retry the refused call before extending',
    );
  process.stdout.write(
    `Refused operation: ${refused.tool}\n${refused.operation}\n${refused.decision?.reason}\nFingerprint: ${fingerprint}\nAllow exactly this operation once (at most five minutes).\n`,
  );
  if (!(await (deps.confirm ?? confirmTask)())) return 1;
  const issued = (deps.now ?? (() => new Date()))();
  const current = readTask(home, taskId, issued);
  if (current.sig !== signed.sig || current.keyId !== signed.keyId)
    throw new Error('permit changed while asking; no extension issued');
  const keys = new FileKeyStore({ home }).loadOrCreate();
  const ttlMs = Math.min(300_000, Date.parse(signed.body.expiresAt) - issued.getTime());
  const extension = signEscalation(
    newEscalationBody({
      taskId,
      nonce: signed.body.nonce,
      fingerprint: fingerprint as string,
      now: issued,
      ttlMs,
    }),
    keys.privateKey,
  );
  new FilePermitStore({ home }).writeEscalation(
    taskId,
    fingerprint as string,
    JSON.stringify(extension),
  );
  return 0;
}
