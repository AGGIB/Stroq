// Internal fixture-only interruption seams; never accepted from an HTTP request.
export type Fault =
  | 'after-intent'
  | 'after-move'
  | 'before-final-manifest'
  | 'restore-before-skill'
  | 'pause-after-intent'
  | null;
export async function inject(fault: Fault, point: Fault) {
  if (fault === 'pause-after-intent' && point === 'after-intent')
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  if (fault === point) throw new Error('injected-fault');
}
