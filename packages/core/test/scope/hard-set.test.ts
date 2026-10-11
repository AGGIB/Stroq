import { describe, expect, it } from 'vitest';
import { HARD_CLASSES, firstHardClass, isHardClass } from '../../src/scope/hard-set.js';
import { ACTION_CLASSES } from '../../src/types.js';

describe('HARD_CLASSES', () => {
  it('is exactly the seven classes no task scope can lift', () => {
    expect([...HARD_CLASSES]).toEqual([
      'secret.egress',
      'secret.unscannable',
      'fs.canary',
      'config.self',
      'config.git_exec',
      'shell.exec_encoded',
      'origin.suspect',
    ]);
  });

  it('names only classes that exist', () => {
    for (const name of HARD_CLASSES) expect(ACTION_CLASSES).toContain(name);
  });

  it('cannot be changed by the code that imports it', () => {
    expect(Object.isFrozen(HARD_CLASSES)).toBe(true);
    expect(() => (HARD_CLASSES as unknown as string[]).push('shell.network')).toThrow(TypeError);
    expect(() => {
      (HARD_CLASSES as unknown as string[])[0] = 'x';
    }).toThrow(TypeError);
  });
});

describe('isHardClass and firstHardClass', () => {
  it('knows a hard class from any other', () => {
    expect(isHardClass('secret.egress')).toBe(true);
    expect(isHardClass('shell.network')).toBe(false);
    expect(isHardClass('config.self_touch')).toBe(false);
  });

  it('finds none in a call with only ordinary classes, or none at all', () => {
    expect(firstHardClass(['shell.network', 'mcp.call'])).toBeNull();
    expect(firstHardClass([])).toBeNull();
  });

  it('names the first in the order of the set, whatever order the call listed them in', () => {
    expect(firstHardClass(['origin.suspect', 'secret.egress'])).toBe('secret.egress');
    expect(firstHardClass(['shell.network', 'config.git_exec', 'fs.canary'])).toBe('fs.canary');
  });
});
