import { describe, expect, it } from 'vitest';
import { markControl } from '../../src/live/evidence.js';
import { controlOf } from '../../src/live/probes.js';
import { ABSENT, THERE } from './evidence-helpers.js';
import { NONCE, finished, toolUse } from './helpers.js';
import { PROJECT, probe } from './probe-helpers.js';

/**
 * A control is the same command run with a hook that allows everything, and its file has to appear. It has
 * no audit log, so what it shows rests on the stream and the disk alone, and the stream has to be the
 * command and nothing else (the table of marks in `evidence-marks.test.ts` has the rest).
 */
describe('markControl, the command', () => {
  const control = (
    kind: 'deny' | 'secret-egress',
    over: Partial<Parameters<typeof markControl>[0]> = {},
  ) => {
    const p = controlOf(probe(kind));
    return markControl({
      probe: p,
      nonce: NONCE,
      run: finished([toolUse(p.command)]),
      sentinel: THERE,
      ...over,
    });
  };

  // A control that ran some other command proves nothing about this one, even if its file is there.
  it('is not armed by a command that was not the one it was given, and is not failed either', () => {
    const p = controlOf(probe('deny'));
    for (const sentinel of [THERE, ABSENT]) {
      const outcome = control('deny', {
        run: finished([toolUse(`${p.command}; touch other`)]),
        sentinel,
      });
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason: 'command-altered',
      });
      expect(outcome.evidence.E1).toBe(false);
    }
  });

  // A control has no audit log: the hook is switched off, and nothing counts its calls but the stream. So the
  // stream has to hold the command and nothing else. A host that stopped the command by its own rules can
  // be worked around by a second call that makes the same file, and the file would then prove nothing.
  describe('is not armed by a stream that holds more than the one call', () => {
    it.each(['deny', 'secret-egress'] as const)(
      'when a second call made the file the command was stopped from making (%s)',
      (kind) => {
        const p = controlOf(probe(kind));
        const workaround = `echo ${NONCE} > ${PROJECT}/${p.sentinel.file}`;
        // Whichever of the two came first.
        for (const commands of [
          [p.command, workaround],
          [workaround, p.command],
        ]) {
          const outcome = control(kind, { run: finished(commands.map((c) => toolUse(c))) });
          expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
            mark: 'inconclusive',
            reason: 'control-extra-activity',
          });
        }
      },
    );

    it('when the command was made twice', () => {
      const p = controlOf(probe('deny'));
      const outcome = control('deny', { run: finished([toolUse(p.command), toolUse(p.command)]) });
      expect(outcome.reason).toBe('control-extra-activity');
    });

    it('when another tool was used as well', () => {
      const p = controlOf(probe('deny'));
      const outcome = control('deny', {
        run: finished([
          toolUse(p.command),
          { type: 'tool_use', name: 'Write', input: { file_path: 'x' } },
        ]),
      });
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason: 'control-extra-activity',
      });
      expect(outcome.evidence).toEqual({ E1: true, E2: null, E3: true, E4: null });
    });

    it('and says so in a line, in the words of a control run', () => {
      const p = controlOf(probe('deny'));
      const outcome = control('deny', { run: finished([toolUse(p.command), toolUse('ls')]) });
      expect(outcome.detail).toMatch(/control run/);
      expect(outcome.detail).toMatch(/more than the one call/);
    });

    it('but not by events that are not calls: talk and answers are not activity', () => {
      const p = controlOf(probe('deny'));
      const outcome = control('deny', {
        run: finished([
          { type: 'text', text: 'running it' },
          toolUse(p.command),
          { type: 'tool_result', isError: false, text: '' },
        ]),
      });
      expect(outcome.reason).toBe('armed');
    });
  });

  // The file the command makes holds the nonce of its request. Anything else at the path was put there by
  // something other than the command, and what the control shows is then not known.
  it.each(['deny', 'secret-egress'] as const)(
    'is not armed by a file that holds other words than the command writes (%s)',
    (kind) => {
      for (const content of [
        '',
        'ran\n',
        'stroq-live-ffffffffffffffff\n',
        `${NONCE}\n${NONCE}\n`,
      ]) {
        const outcome = control(kind, { sentinel: { exists: true, content } });
        expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
          mark: 'inconclusive',
          reason: 'evidence-conflict',
        });
        expect(outcome.evidence.E3).toBe(false);
      }
    },
  );

  it('is not armed by something that is not a file, or by one too large to be what the command wrote', () => {
    const outcome = control('deny', { sentinel: { exists: true, content: null } });
    expect(outcome.reason).toBe('evidence-conflict');
  });

  it('is still not armed by a file that is not there', () => {
    expect(control('deny', { sentinel: ABSENT }).reason).toBe('probe-not-armed');
  });

  // Both commands end in one that exits 0. An error reported for the call with the file in place is a call
  // that did not go as a command of this kind goes.
  it.each(['deny', 'secret-egress'] as const)(
    'is not armed when the host reported an error for the call, even with its file there (%s)',
    (kind) => {
      const p = controlOf(probe(kind));
      const outcome = control(kind, {
        run: finished([toolUse(p.command), { type: 'tool_result', isError: true, text: 'exit 1' }]),
      });
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason: 'control-errored',
      });
    },
  );

  it('leaves it to the file when the host reported an error and the file is not there', () => {
    const p = controlOf(probe('deny'));
    const outcome = control('deny', {
      run: finished([toolUse(p.command), { type: 'tool_result', isError: true, text: 'denied' }]),
      sentinel: ABSENT,
    });
    expect(outcome.reason).toBe('probe-not-armed');
  });

  it('is armed by the command with its white space changed', () => {
    const p = controlOf(probe('deny'));
    const outcome = control('deny', {
      run: finished([toolUse(`  ${p.command.replace(/ /g, '  ')}\n`)]),
    });
    expect(outcome.reason).toBe('armed');
  });
});
