import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SELF_CHECK_AGENTS } from '../../src/commands/init-selfcheck.js';
import { HOST_CAPABILITIES, capabilitiesFor } from '../../src/hosts/capabilities.js';

/**
 * Which hosts a live check can be run against at all. A host that is not here, or is here as not
 * headless, is never driven: the state it gets is "unsupported", with the reason in this table.
 */
describe('the capability table', () => {
  it('lets Claude Code be driven without a caveat', () => {
    expect(HOST_CAPABILITIES['claude-code']).toEqual({ headless: true, caveats: [] });
  });

  // Measured on Codex 0.158.0-alpha.2 (2026-09-29; docs/AGENTS.md): `codex exec` ran a user-level hook
  // only with --dangerously-bypass-hook-trust, and never a project hook. A check driven that way
  // shows what Codex does with the trust check switched off, and says so.
  it('lets Codex be driven, with the caveat that its hook trust is bypassed', () => {
    expect(HOST_CAPABILITIES['codex']).toEqual({
      headless: true,
      caveats: ['hook-trust-bypassed'],
    });
  });

  it('lets the MCP proxy be checked without any host', () => {
    expect(HOST_CAPABILITIES['mcp']).toEqual({
      headless: true,
      caveats: ['host-free proxy check'],
    });
  });

  it.each(['cursor', 'windsurf', 'antigravity', 'copilot'])(
    'does not drive %s, which has no hook mode that can be run without a person',
    (agent) => {
      expect(HOST_CAPABILITIES[agent]).toEqual({
        headless: false,
        reason: 'no verified headless hook mode',
        caveats: [],
      });
    },
  );

  it('does not drive OpenClaw, which decides inside its Gateway, and points at the manual flow', () => {
    expect(HOST_CAPABILITIES['openclaw']).toEqual({
      headless: false,
      reason: 'enforced inside the Gateway process; use the manual --prompt flow',
      caveats: [],
    });
  });

  it('says why for every host it does not drive, and for no other', () => {
    for (const [agent, capability] of Object.entries(HOST_CAPABILITIES)) {
      if (capability.headless) expect(capability.reason, agent).toBeUndefined();
      else expect(capability.reason, agent).toMatch(/^[\x20-\x7e]{10,120}$/);
    }
  });

  // The caveats are copied into the stored result, whose schema takes plain ASCII of a bounded length.
  it('writes every caveat in a form the stored result accepts', () => {
    for (const capability of Object.values(HOST_CAPABILITIES))
      for (const caveat of capability.caveats) expect(caveat).toMatch(/^[\x20-\x7e]{1,120}$/);
  });

  it('cannot be changed by whoever reads it', () => {
    expect(Object.isFrozen(HOST_CAPABILITIES)).toBe(true);
    for (const capability of Object.values(HOST_CAPABILITIES)) {
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.isFrozen(capability.caveats)).toBe(true);
    }
  });
});

describe('the table against the agents the code knows', () => {
  it('has an entry for every agent `stroq init` can check after installing', () => {
    for (const agent of SELF_CHECK_AGENTS) expect(HOST_CAPABILITIES[agent], agent).toBeDefined();
  });

  // `HOOK_ROWS` in doctor.ts is not exported, and `doctor.ts` is not this table's to change: the ids
  // are read from the rows themselves, so that a row added there without an entry here fails here.
  it('has an entry for every row of the hook section of `stroq doctor`', () => {
    const doctor = readFileSync(
      fileURLToPath(new URL('../../src/commands/doctor.ts', import.meta.url)),
      'utf8',
    );
    const rows = /const HOOK_ROWS[\s\S]*?\}\[\] = \[([\s\S]*?)\n\];/.exec(doctor)?.[1] ?? '';
    const ids = [...rows.matchAll(/\bid: '([a-z-]+)'/g)].map((match) => match[1] ?? '');
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) expect(HOST_CAPABILITIES[id], id).toBeDefined();
  });

  it('has nothing for an agent that does not exist', () => {
    const doctor = readFileSync(
      fileURLToPath(new URL('../../src/commands/doctor.ts', import.meta.url)),
      'utf8',
    );
    for (const agent of Object.keys(HOST_CAPABILITIES))
      expect(doctor, agent).toContain(`id: '${agent}'`);
  });
});

describe('capabilitiesFor', () => {
  it('gives the entry of a known agent', () => {
    expect(capabilitiesFor('codex')).toBe(HOST_CAPABILITIES['codex']);
  });

  it.each(['nothing', '', 'Claude-Code', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'gives nothing for %j, which is not an agent',
    (agent) => {
      expect(capabilitiesFor(agent)).toBeUndefined();
    },
  );
});
