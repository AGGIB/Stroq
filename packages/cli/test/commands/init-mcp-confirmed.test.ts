import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { initMcp } from '../../src/commands/init-mcp.js';
import { addMcp } from '../../src/install/mcp-install.js';
import { configPinStatus } from '../../src/mcp/pin-status.js';
import { reconfirmCommand } from '../../src/mcp/pin-argument.js';
import { mcpFixture } from '../helpers/mcp-install.js';

/**
 * A wrapper that `stroq add --kind mcp` wrote and the lock confirms is held to the command line `add` wrote, token
 * for token. `stroq init --agent mcp` used to rewrite it (a new `--cwd`, `--pass-env` and node path), which the pin
 * then refused at run time with no warning at the moment of the rewrite. Now `init` leaves it as it is, says so, and
 * prints the one command that confirms a changed wrapper.
 */
async function run(f: Awaited<ReturnType<typeof mcpFixture>>, dryRun = false, cloak = false) {
  const out: string[] = [];
  const err: string[] = [];
  vi.stubEnv('STROQ_HOME', f.options.stroqHome);
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => (out.push(String(text)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => (err.push(String(text)), true));
  const code = await initMcp('project', ['/other/node', '/other/stroq/dist/index.js'], dryRun, {
    config: f.config,
    unwrap: false,
    cloak,
  });
  return { code, out: out.join(''), err: err.join('') };
}

describe('stroq init --agent mcp and a wrapper that add confirmed', () => {
  it('leaves the entry as add wrote it, byte for byte, and keeps the other servers wrapped', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);
    const before = await readFile(f.config, 'utf8');
    const written = (await f.servers())['demo'];

    const { code, out } = await run(f);

    expect(code).toBe(0);
    const after = await f.servers();
    expect(after['demo']).toEqual(written);
    // the entry that no add wrote is wrapped as ever
    expect(after['other'].args).toEqual(expect.arrayContaining(['mcp', '--server', 'other']));
    expect(await readFile(f.config, 'utf8')).not.toBe(before);
    expect(out).toMatch(/kept demo/);
  });

  it('prints the exact command that confirms a changed wrapper', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);

    const { out } = await run(f);

    expect(out).toContain('stroq add demo --kind mcp --force');
    expect(out).toContain(reconfirmCommand('demo'));
  });

  it('keeps it when --cloak is asked for, and says the cloak is not on for it', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);
    const written = (await f.servers())['demo'];

    const { out } = await run(f, false, true);

    expect((await f.servers())['demo']).toEqual(written);
    expect(out).toMatch(/--cloak/);
    expect(out).toContain('stroq add demo --kind mcp --force');
  });

  it('shows the same on a dry run: the preview keeps the entry and the lines go to stderr', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);
    const before = await readFile(f.config, 'utf8');
    const written = (await f.servers())['demo'];

    const { out, err } = await run(f, true);

    expect(await readFile(f.config, 'utf8')).toBe(before);
    expect(JSON.parse(out).mcpServers.demo).toEqual(written);
    expect(err).toContain('stroq add demo --kind mcp --force');
  });

  it('leaves doctor green for it: the pin is still the one that was confirmed', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);

    await run(f);
    vi.restoreAllMocks();
    vi.stubEnv('STROQ_HOME', f.options.stroqHome);
    const statuses = await configPinStatus(f.config);

    expect(statuses.map((s) => [s.name, s.ok])).toEqual([['mcp pin "demo"', true]]);
  });

  it('wraps a pinned wrapper that no lock record confirms, and keeps its --pin as before', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);
    // the lock of another machine: the entry is a wrapper with a pin, and nothing here confirms it
    vi.stubEnv('STROQ_HOME', `${f.options.stroqHome}-elsewhere`);
    const pinned = (await f.servers())['demo'];
    const pin = pinned.args[pinned.args.indexOf('--pin') + 1];

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (out.push(String(text)), true));
    await initMcp('project', ['/other/node', '/other/stroq/dist/index.js'], false, {
      config: f.config,
      unwrap: false,
      cloak: false,
    });

    const after = (await f.servers())['demo'];
    expect(after.command).toBe('/other/node');
    expect(after.args).toContain(pin);
    expect(out.join('')).not.toContain('--kind mcp --force');
  });
});

describe('the command that confirms a wrapper again', () => {
  it.each([
    ['demo', 'stroq add demo --kind mcp --force'],
    ['weather-2_a', 'stroq add weather-2_a --kind mcp --force'],
  ])('is the plain line for %s', (name, line) => {
    expect(reconfirmCommand(name)).toBe(line);
  });

  it.each([
    ["it's", "stroq add 'it'\\''s' --kind mcp --force"],
    ['a b', "stroq add 'a b' --kind mcp --force"],
    ['$(touch x)', "stroq add '$(touch x)' --kind mcp --force"],
  ])('quotes %j for a shell', (name, line) => {
    expect(reconfirmCommand(name)).toBe(line);
  });

  it.each([
    ['a\nb', '<unprintable-name>'],
    ['a\u001b[2Jb', '<unprintable-name>'],
    ['a\u202eb', '<unprintable-name>'],
    ['x'.repeat(5000), '<name-too-long>'],
  ])('does not print %j as a command or let it move the terminal', (name, shown) => {
    const text = reconfirmCommand(name);

    expect(text).toBe(`stroq add ${shown} --kind mcp --force`);
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  });

  it('prints the empty name as an empty argument', () => {
    expect(reconfirmCommand('')).toBe("stroq add '' --kind mcp --force");
  });
});
