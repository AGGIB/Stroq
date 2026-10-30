import { describe, expect, it } from 'vitest';
import { ownCommandSegments } from '../../src/actions/shell-top-level.js';

describe('the variables a command sets to a literal', () => {
  it('are put in their place in the segments the command runs after', () => {
    expect(ownCommandSegments('d=/tmp/x; $d/install')).toContain('/tmp/x/install');
    expect(ownCommandSegments('$d/install; d=/tmp/x')).not.toContain('/tmp/x/install');
  });

  // A 38 KB line of one value used four thousand times grew to 120 MB before these bounds.
  it('are put in within bounds: a long value stays as written, and so do uses past the room', () => {
    const long = 'x'.repeat(5000);
    expect(ownCommandSegments(`A=${long}; echo $A`)).toContain('echo $A');
    const many = ownCommandSegments(`A=${'y'.repeat(2000)}; echo ${'$A'.repeat(4000)}`);
    expect(Math.max(...many.map((segment) => segment.length))).toBeLessThan(48 * 1024);
  });
});
