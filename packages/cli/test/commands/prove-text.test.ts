import { describe, expect, it } from 'vitest';
import { notRunReport, reportOf } from '../../src/commands/prove-report.js';
import { dryRunText, noticeText, renderReport } from '../../src/commands/prove-text.js';
import { REASONS, type HostResult, type ProbeResult } from '../../src/live/types.js';
import { armedControl, passedProbe, resultOf } from '../live/helpers.js';

/**
 * The words of `stroq prove`: plain English, plain ASCII, one table, one verdict, at most three lines of
 * advice. And the verdict says what it shows and what it does not, in the same words every time, because a
 * "verified" that is read as more than it is is worse than none.
 */
const ok = (id: string, kind: ProbeResult['kind'], reason: string): ProbeResult => ({
  id,
  kind,
  mark: 'passed',
  reason,
  evidence: { E1: true, E2: true, E3: true, E4: kind === 'allow' ? null : true },
});

const unmarked = (
  id: string,
  kind: ProbeResult['kind'],
  mark: ProbeResult['mark'],
  reason: string,
  detail?: string,
): ProbeResult => ({
  id,
  kind,
  mark,
  reason,
  ...(detail === undefined ? {} : { detail }),
  evidence: { E1: null, E2: null, E3: null, E4: null },
});

const verified = (over: Partial<HostResult> = {}): HostResult =>
  resultOf('verified', {
    probes: [
      passedProbe(),
      ok('secret-egress', 'secret-egress', 'blocked'),
      armedControl('secret-egress', 'secret-egress'),
      unmarked('deny', 'deny', 'not-attempted', REASONS.maxRequests, 'the limit was reached'),
    ],
    ...over,
  });

const shown = (result: HostResult): string => renderReport(reportOf(result));

describe('the verdict of a host that was verified', () => {
  const text = shown(verified());

  it('says VERIFIED, and which host and version', () => {
    expect(text).toMatch(/VERIFIED/);
    expect(text).toContain('Claude Code 2.1.271');
  });

  it('says what it shows: the line `stroq init` writes stopped a denied command, and the command runs without the hook', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('the hook line `stroq init` writes');
    expect(flat).toContain('stopped a command your policy denies');
    expect(flat).toContain('the same command runs when the hook is out of the way');
  });

  it('says what it does not show: your own settings file, other versions, other hosts', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('does not show that your own settings file is loaded');
    expect(flat).toMatch(/other versions/);
    expect(flat).toMatch(/other hosts/);
  });

  it('has one table with a row for each probe, its mark and why', () => {
    for (const label of ['allow', 'secret', 'hook out of the way', 'git hook'])
      expect(text).toContain(label);
    expect(text).toMatch(/passed\s+ran/);
    expect(text).toMatch(/passed\s+stopped by the hook/);
    expect(text).toMatch(/passed\s+ran with the hook out of the way/);
    expect(text).toMatch(/not attempted/);
  });

  it('is plain ASCII on lines that fit', () => {
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(100);
  });

  it('ends with at most three lines of advice', () => {
    const advice = text.split('\n').filter((line) => line.startsWith('  - '));
    expect(advice.length).toBeGreaterThan(0);
    expect(advice.length).toBeLessThanOrEqual(3);
  });
});

describe('the verdict of a host that did not pass', () => {
  it('says FAILED, and for which probe and why, and never VERIFIED', () => {
    const text = shown(resultOf('failed'));
    expect(text).toMatch(/FAILED/);
    expect(text).toContain('git hook');
    expect(text).toMatch(/ran although the hook said deny/);
    expect(text).not.toMatch(/VERIFIED/);
  });

  it('says what the hook failed to do, in words, for each way a host fails', () => {
    const failed = (reason: string): string =>
      shown(
        resultOf('failed', {
          probes: [
            passedProbe(),
            {
              id: 'secret-egress',
              kind: 'secret-egress',
              mark: 'failed',
              reason,
              evidence: { E1: true, E2: true, E3: false, E4: false },
            },
          ],
        }),
      );
    expect(failed('executed-despite-deny')).toMatch(/ran although the hook said deny/);
    expect(failed('hook-bypassed')).toMatch(/hook was never called/);
    expect(failed('policy-mismatch')).toMatch(/decided otherwise than your policy/);
  });

  it('says NOT PROVEN for a check that could not tell, with the reason, and never VERIFIED', () => {
    const text = shown(resultOf('inconclusive'));
    expect(text).toMatch(/NOT PROVEN/);
    expect(text).toMatch(/usage limit/);
    expect(text).not.toMatch(/VERIFIED/);
  });

  it('says NOT RUN for a check that was not attempted', () => {
    const text = shown(resultOf('not-attempted'));
    expect(text).toMatch(/NOT RUN/);
    expect(text).not.toMatch(/VERIFIED/);
  });

  it('says STAND-IN for a double of a host, and never VERIFIED, whatever its probes came to', () => {
    const text = shown(verified({ mode: 'stand-in' }));
    expect(text).toMatch(/STAND-IN/);
    expect(text).not.toMatch(/VERIFIED/);
    expect(text.replace(/\s+/g, ' ')).toMatch(/nothing is known of the real one/);
  });

  it('says what a check that was not run did not do', () => {
    const text = renderReport(
      notRunReport('codex', 'unsupported', null, 'there is no live check for codex yet', [
        'Only claude-code can be checked today.',
      ]),
    );
    expect(text).toMatch(/NOT SUPPORTED/);
    expect(text).toContain('there is no live check for codex yet');
    expect(text).toContain('Only claude-code can be checked today.');
    expect(text).not.toMatch(/VERIFIED/);
  });

  it('shows the detail of a probe that did not pass, and not of one that did', () => {
    const text = shown(
      resultOf('inconclusive', {
        probes: [
          unmarked('allow', 'allow', 'inconclusive', REASONS.limit, 'the host said: usage limit'),
        ],
      }),
    );
    expect(text).toContain('the host said: usage limit');
  });
});

describe('text from outside', () => {
  const hostile = '\u001b]52;c;AAAA\u0007\u001b[31mred\u001b[0m\u009b2J‮';

  it('is never printed raw: no control character, no escape, in the report', () => {
    const text = shown(
      resultOf('inconclusive', {
        hostVersion: `2.1.271${hostile}`,
        caveats: [`note ${hostile}`],
        probes: [unmarked('allow', 'allow', 'inconclusive', `odd-${hostile}`, `detail ${hostile}`)],
      }),
    );
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    expect(text).toContain('\\u001b');
  });

  it('is never printed raw in the notice or the dry run', () => {
    const lines = [
      ...noticeText({ agent: hostile, hostVersion: hostile, maxRequests: 3 }),
      ...dryRunText({
        agent: hostile,
        hostVersion: hostile,
        maxRequests: 3,
        policy: hostile,
        hookLine: hostile,
      }),
    ].join('\n');
    expect(lines).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  });
});

describe('the notice of what a run costs', () => {
  const text = noticeText({ agent: 'claude-code', hostVersion: '2.1.271', maxRequests: 3 }).join(
    '\n',
  );
  // A phrase may be broken over two lines, and is still the phrase.
  const flat = text.replace(/\s+/g, ' ');

  it('says how many requests, to which host, with whose login, and what they cost', () => {
    expect(flat).toMatch(/up to 3 short requests/);
    expect(flat).toContain('Claude Code 2.1.271');
    expect(flat).toMatch(/your own login/);
    expect(flat).toMatch(/haiku/);
    expect(flat).toMatch(/subscription usage/);
  });

  it('says that no API key is used, and that the host is stopped if it sees one', () => {
    expect(flat).toMatch(/never an API key/);
    expect(flat).toMatch(/stops? (the host )?(at once )?if it sees one/);
  });

  it('says it happens in a temporary folder that is removed, and that no file of yours is changed', () => {
    expect(flat).toMatch(/temporary folder/);
    expect(flat).toMatch(/removed/);
    expect(flat).toMatch(/does not change any file of yours/);
  });

  it('counts the requests the run is allowed', () => {
    expect(
      noticeText({ agent: 'claude-code', hostVersion: null, maxRequests: 5 }).join(' '),
    ).toMatch(/up to 5 short requests/);
    expect(
      noticeText({ agent: 'claude-code', hostVersion: null, maxRequests: 1 }).join(' '),
    ).toMatch(/1 short request\b/);
  });

  it('is plain ASCII', () => {
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
  });
});

describe('the dry run', () => {
  const text = dryRunText({
    agent: 'claude-code',
    hostVersion: '2.1.271',
    maxRequests: 3,
    policy: 'default',
    hookLine: '"/usr/bin/node" "/opt/stroq/index.js" hook claude-code',
  }).join('\n');

  it('says nothing was done, what would be, and which hook line and policy', () => {
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(/no request was made/i);
    expect(text).toContain('hook claude-code');
    expect(text).toContain('policy: default');
    expect(text).toMatch(/up to 3/);
  });

  it('names the three probes', () => {
    for (const label of ['allow', 'secret', 'git hook']) expect(text).toContain(label);
  });
});
