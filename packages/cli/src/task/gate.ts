import {
  FileKeyStore,
  FilePermitStore,
  SignedPermitSchema,
  createScopeGate,
  type Policy,
  type ScopeGate,
  type StoreRead,
} from '@stroq/core';
import { policySha256 } from '../policy/digest.js';
import { permitHash } from './contract.js';

/** Environment pins come from the parent launcher, never from task files. */
export function taskGate(home: string, policy: Policy, env: NodeJS.ProcessEnv): ScopeGate {
  const store = new FilePermitStore({ home });
  const keys = new FileKeyStore({ home });
  return createScopeGate({
    taskId: env['STROQ_TASK_ID'],
    store: {
      readPermit: (id): StoreRead => {
        const read = store.readPermit(id);
        if (read.kind !== 'present') return read;
        try {
          const signed = SignedPermitSchema.parse(JSON.parse(read.text));
          if (
            permitHash(signed.body) !== env['STROQ_TASK_HASH'] ||
            signed.keyId !== env['STROQ_TASK_KEY_ID']
          )
            return { kind: 'void', reason: 'unreadable' };
          return read;
        } catch {
          return { kind: 'void', reason: 'unreadable' };
        }
      },
      readEscalation: (id, fp) => store.readEscalation(id, fp),
      consumeEscalation: (id, fp, text) => store.consumeEscalation(id, fp, text),
    },
    keys: {
      readPublicKey: () => {
        const key = keys.readPublicKey();
        return key.kind === 'ok' && key.keyId !== env['STROQ_TASK_KEY_ID']
          ? { kind: 'bad', reason: 'not-a-key' }
          : key;
      },
    },
    context: () => ({
      nonce: env['STROQ_TASK_NONCE'] ?? '',
      projectRoot: env['STROQ_TASK_ROOT'] ?? '',
      policyDigest: policySha256(policy),
      stateDigests: {},
    }),
  });
}
