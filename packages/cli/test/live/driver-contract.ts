/**
 * What a driver starts its host with for one request, in the parts the contract of a control run is about.
 *
 * The control of a probe is the same command with the hook taken out. It shows the host would have run the
 * command had the hook let it, and that is worth something only if the host is the same one in both: the
 * same model, settings, permission rules, allowed tools, flags, environment and working directory. A control
 * started with a looser permission mode, an allow rule only it has, or a hook that says "allow" (which
 * skips the host's own permission step in some hosts) arms a probe the real run's host would never have
 * run, and a stop by the host's own rules then looks like a stop by the hook.
 *
 * What a driver's tests run to show it keeps the contract is `controlBreaches` below, on the invocations its
 * driver made for a probe and for the control of that probe.
 */
export interface Invocation {
  /** The nonce of the request, which the prompt carries and which differs from one request to the next. */
  readonly nonce: string;
  readonly prompt: string;
  readonly model: string;
  /** The session the host is given. It is the request's own and differs from one request to the next. */
  readonly sessionId: string;
  /** Every other flag the host is started with, in order. */
  readonly flags: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly permissions: { readonly mode: string; readonly allow: readonly string[] };
  /** What the hook is: its command, and whether it ever says "allow". */
  readonly hook: { readonly command: string; readonly decides: 'nothing' | 'allow' };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const same = (one: unknown, other: unknown): boolean =>
  JSON.stringify(one) === JSON.stringify(other);

const withoutNonce = (invocation: Invocation): string =>
  invocation.prompt.replaceAll(invocation.nonce, '<nonce>');

/**
 * What a control does that the contract forbids, as the names of the parts of its invocation: anything that
 * differs from the real run's but the hook, the session and the nonce; a hook that is the real one; and a
 * hook that says anything at all. Empty for a control that keeps the contract.
 */
export function controlBreaches(real: Invocation, control: Invocation): string[] {
  const breaches: string[] = [];
  if (withoutNonce(real) !== withoutNonce(control)) breaches.push('prompt');
  for (const part of ['model', 'flags', 'settings', 'permissions', 'cwd', 'env'] as const)
    if (!same(real[part], control[part])) breaches.push(part);
  if (control.hook.command === real.hook.command) breaches.push('hook-command');
  if (control.hook.decides !== 'nothing') breaches.push('hook-decides');
  return breaches;
}
