import { describe, expect, it } from 'vitest';
import {
  CONFIRM_SENSITIVE_MAX,
  confirmationScreen,
  renderPassport,
} from '../../src/commands/vet-render.js';
import { many, passportWith } from '../helpers/vet-passport.js';

/** Lines in the order a real passport has them: by kind, alphabetically, so `allowed-tools` leads. */
const flood = (tools: number) =>
  passportWith([
    ...many(tools, (i) => ({
      kind: 'allowed-tools' as const,
      subject: `mcp__srv__t${String(i).padStart(2, '0')}`,
      sensitive: true,
    })),
    { kind: 'cred.file' as const, subject: '~/.ssh/id_rsa', sensitive: true },
    { kind: 'exec' as const, subject: 'curl | sh', sensitive: true },
    { kind: 'net' as const, subject: 'evil.example', sensitive: true },
  ]);

describe('the order of the rows on a screen', () => {
  it('puts credentials, the network and execution before a long list of allowed tools', () => {
    const out = renderPassport(flood(30));

    expect(out).toContain('~/.ssh/id_rsa');
    expect(out).toContain('evil.example');
    expect(out).toContain('curl | sh');
    expect(out.indexOf('~/.ssh/id_rsa')).toBeLessThan(out.indexOf('evil.example'));
    expect(out.indexOf('evil.example')).toBeLessThan(out.indexOf('curl | sh'));
    expect(out.indexOf('curl | sh')).toBeLessThan(out.indexOf('mcp__srv__t00'));
  });

  it('ranks hooks and install scripts after execution and before tools', () => {
    const out = renderPassport(
      passportWith([
        { kind: 'allowed-tools' as const, subject: 'tool-a', sensitive: true },
        { kind: 'hook' as const, subject: 'hook-a', sensitive: true },
        { kind: 'install-script' as const, subject: 'script-a', sensitive: true },
        { kind: 'tool' as const, subject: 'tool-b', sensitive: true },
        { kind: 'exec' as const, subject: 'exec-a', sensitive: true },
        { kind: 'cred.env' as const, subject: 'cred-a', sensitive: true },
      ]),
    );
    const order = ['cred-a', 'exec-a', 'hook-a', 'script-a', 'tool-a', 'tool-b'].map((text) =>
      out.indexOf(text),
    );

    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('the screen a person types a digest against', () => {
  it('shows every sensitive row, however many rows the vet screen would show', () => {
    const out = confirmationScreen(flood(60), '/src/skill');

    expect(out).toContain('SENSITIVE (63)');
    expect(out).toContain('~/.ssh/id_rsa');
    expect(out).toContain('evil.example');
    for (let i = 0; i < 60; i += 1)
      expect(out).toContain(`mcp__srv__t${String(i).padStart(2, '0')} `);
    expect(out).not.toMatch(/and \d+ more lines? not shown \([^)]*sensitive/);
  });

  it('may still leave the rows that are not sensitive out, and says how many', () => {
    const passport = passportWith([
      ...many(40, (i) => ({ subject: `sensitive-${i}`, sensitive: true })),
      ...many(30, (i) => ({ subject: `plain-${i}`, sensitive: false })),
    ]);
    const out = confirmationScreen(passport, '/src/skill');

    expect(out).toContain('sensitive-39');
    expect(out).not.toContain('plain-0 ');
    expect(out).toMatch(/and 30 more lines not shown \(30 other\)/);
  });

  it('shows exactly what the vet screen shows for a small passport', () => {
    const passport = passportWith(many(6, (i) => ({ subject: `s${i}`, sensitive: i < 3 })));

    expect(confirmationScreen(passport, '/src/skill')).toBe(renderPassport(passport));
  });

  it('refuses a passport with more sensitive rows than the cap, counting what would be hidden', () => {
    const passport = passportWith(
      many(CONFIRM_SENSITIVE_MAX + 7, (i) => ({ subject: `s${i}`, sensitive: true })),
    );

    expect(() => confirmationScreen(passport, '/src/my skill')).toThrow(
      /7 sensitive lines would be hidden/,
    );
    expect(() => confirmationScreen(passport, '/src/my skill')).toThrow(
      /stroq vet --from '\/src\/my skill' --json/,
    );
  });

  it.each([
    ['/src/$(touch x)', `'/src/$(touch x)'`],
    ['/src/`id`', "'/src/`id`'"],
    ['/src/a;b', `'/src/a;b'`],
  ])(
    'quotes the source %s so that a shell reads it as one word and runs nothing',
    (source, word) => {
      const passport = passportWith(
        many(CONFIRM_SENSITIVE_MAX + 1, (i) => ({ subject: `s${i}`, sensitive: true })),
      );

      expect(() => confirmationScreen(passport, source)).toThrow(`stroq vet --from ${word} --json`);
    },
  );

  it('accepts exactly the cap', () => {
    const passport = passportWith(
      many(CONFIRM_SENSITIVE_MAX, (i) => ({ subject: `s${i}`, sensitive: true })),
    );

    expect(confirmationScreen(passport, '/src/skill')).toContain(
      `SENSITIVE (${CONFIRM_SENSITIVE_MAX})`,
    );
  });

  it.each(["/src/it's", '/src/a\\b', '/src/a!b', '/src/a\nb'])(
    'prints no command for the source %j, only a sentence',
    (source) => {
      const passport = passportWith(
        many(CONFIRM_SENSITIVE_MAX + 1, (i) => ({ subject: `s${i}`, sensitive: true })),
      );

      expect(() => confirmationScreen(passport, source)).toThrow(
        /the path has characters that cannot be quoted safely for a shell, so no command is shown$/,
      );
    },
  );

  it('writes a source that holds a control character out in the refusal, never raw', () => {
    const passport = passportWith(
      many(CONFIRM_SENSITIVE_MAX + 1, (i) => ({ subject: `s${i}`, sensitive: true })),
    );
    let message = '';
    try {
      confirmationScreen(passport, '/src/\u001b[31mred\u202e');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/1 sensitive line would be hidden/);
    expect(message).not.toMatch(/[\u001b\u202e]/u);
  });
});
