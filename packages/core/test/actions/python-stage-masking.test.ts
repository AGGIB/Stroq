import { describe, expect, it } from 'vitest';
import { INLINE_PAYLOAD } from '../../src/actions/inline-payload.js';
import { readPythonStages, type PythonStageContext } from '../../src/actions/python-stages.js';
import { lex } from '../../src/actions/shell-lex.js';
import { GATE_TIMINGS, leastTime, timeOf } from '../cpu-time.js';

const contextOf = (text: string): PythonStageContext => ({
  texts: [text],
  stages: [lex(text).pipelines],
  depth: 0,
  consumer: () => 'unknown',
  payload: (program) => INLINE_PAYLOAD.test(program),
});

describe('putting fully read Python stages out of the way', () => {
  it('preserves gaps, unread programs and the order of the commands it starts', () => {
    const first = `python3 -c "import os; os.system('echo first')"`;
    const second = `python3 -c "import os; os.system('echo second')"`;
    const unread = `python3 -c "import os; os.system(command)"`;
    const other = `node -e "require('child_process').execSync(x)"`;
    const text = `echo '\u{1f989}';  ${first} ;\t${other}\n${unread} && ${second} ; python3 -c x`;
    expect(readPythonStages(contextOf(text))).toEqual({
      masked: `echo '\u{1f989}';  true ;\t${other}\n${unread} && true ; true`,
      started: ['echo first', 'echo second'],
      signals: ['inline-interpreter-payload'],
      unparsed: [],
    });
  });

  it('replaces repeated stages at their own offsets, keeping comments and here-documents', () => {
    const text = `python3 -c x;python3 -c x\n# python3 -c x\ncat <<'EOF'\npython3 -c x\nEOF\n  python3 -c x  `;
    expect(readPythonStages(contextOf(text))).toEqual({
      masked: `true;true\n# python3 -c x\ncat <<'EOF'\npython3 -c x\nEOF\n  true  `,
      started: [],
      signals: [],
      unparsed: [],
    });
  });

  it('stays linear when many fully read stages need replacing', () => {
    const unit = 'python3 -c x; ';
    const context = (size: number): PythonStageContext =>
      contextOf(unit.repeat(Math.ceil(size / unit.length)).slice(0, size));
    // Isolate the reader: otherwise the other, linear passes can hide a quadratic masking step.
    const small = context(128 * 1024);
    const large = context(512 * 1024);
    const quarter = timeOf(() => readPythonStages(small));
    const tooSlow = (ms: number): boolean => ms >= 1_000 && ms >= 8 * quarter;
    const full = leastTime(() => timeOf(() => readPythonStages(large)), tooSlow, GATE_TIMINGS);
    expect(
      tooSlow(full),
      `${quarter.toFixed(0)} ms at 128 KiB, ${full.toFixed(0)} ms at 512 KiB`,
    ).toBe(false);
  });
});
