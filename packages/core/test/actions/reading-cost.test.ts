import { describe, expect, it } from 'vitest';
import { MAX_READING_COST_US, isTooCostly, readingCost } from '../../src/actions/reading-cost.js';
import { cpuNow } from '../cpu-time.js';

describe('readingCost: what a command costs to read, found before it is read', () => {
  it('is nothing for nothing, and grows with every place a reading stops at', () => {
    expect(readingCost('')).toBe(0);
    const plain = readingCost('echo hello');
    expect(readingCost('echo hello world')).toBeGreaterThan(plain);
    expect(readingCost('echo hello; echo world')).toBeGreaterThan(
      readingCost('echo hello echo world'),
    );
    expect(readingCost('echo $(date)')).toBeGreaterThan(readingCost('echo date'));
    expect(readingCost('echo `date`')).toBeGreaterThan(readingCost('echo date'));
    expect(readingCost('cat <<EOF')).toBeGreaterThan(readingCost('cat EOF'));
    expect(readingCost('cat <(ls)')).toBeGreaterThan(readingCost('cat ls'));
  });

  it('is about the length, for a command that is one long word', () => {
    const cost = readingCost(`echo ${'a'.repeat(1_000_000)}`);
    expect(cost).toBeGreaterThan(1_000_000);
    expect(cost).toBeLessThan(1_500_000);
  });

  it('keeps an ordinary command, and a long one that is ordinary, far under the bound', () => {
    expect(isTooCostly('git commit -m "fix the thing" && git push origin main')).toBe(false);
    const script = 'if [ -f "$f" ]; then\n  echo "found $f" | tee -a log\nfi\n'.repeat(500);
    expect(isTooCostly(script)).toBe(false);
  });

  it('counts eval and trap, which read what follows them as a command, and not words that hold them', () => {
    expect(readingCost('eval x')).toBeGreaterThan(readingCost('evaluate x') + 50);
    expect(readingCost('trap x')).toBeGreaterThan(readingCost('trapped x') + 50);
  });

  it('turns away a command made of a hundred thousand commands', () => {
    expect(isTooCostly('echo x;'.repeat(100_000))).toBe(true);
    expect(isTooCostly('$('.repeat(50_000))).toBe(true);
    expect(readingCost('echo x;'.repeat(100_000))).toBeGreaterThan(MAX_READING_COST_US);
  });

  it('is itself cheap to find out: a pass, not a reading', () => {
    const command = 'echo $(date); cat <<EOF | tee "x"\n'.repeat(30_000);
    const started = cpuNow();
    readingCost(command);
    expect(cpuNow() - started).toBeLessThan(250);
  });
});
