import { describe, expect, it } from 'vitest';
import { wholeCallFingerprint } from '../../src/scope/scope-check.js';
import { callOf, gateFixture, resourcesOf, verdictOf } from './gate-fixture.js';
import { PROJECT } from './helpers.js';

describe('resource inventories that cannot prove the whole call is in scope', () => {
  it('refuses a listed MCP call when paths were unresolved or truncated', async () => {
    const f = gateFixture({ scope: { mcp: [{ server: 'fs', tools: ['read_files'] }] } });
    for (const input of [{ path: `${PROJECT}/*` }, { paths: [`${PROJECT}/a`, '/outside/file'] }]) {
      const call = callOf('mcp__fs__read_files', input, {
        classes: ['mcp.call'],
        resources: resourcesOf([['read', `${PROJECT}/a`]], { pathsComplete: false }),
      });
      const verdict = await verdictOf(f, call);
      expect(verdict.decision.ruleId).toBe('task-scope-incomplete');
      expect(verdict.evidence.fingerprint).toBe(wholeCallFingerprint(call));
    }
  });

  it('keeps complete pathless MCP calls available', async () => {
    const f = gateFixture({ scope: { mcp: [{ server: 'docs', tools: ['search'] }] } });
    const call = callOf(
      'mcp__docs__search',
      { query: 'fixture' },
      {
        classes: ['mcp.call'],
        resources: resourcesOf([]),
      },
    );
    expect((await verdictOf(f, call)).decision.effect).toBe('allow');
  });

  it('refuses incomplete file resources on other non-shell tools too', async () => {
    const f = gateFixture({ scope: { tools: ['WebFetch'] } });
    const call = callOf(
      'WebFetch',
      { url: 'file:///outside/file' },
      {
        resources: resourcesOf([], { pathsComplete: false }),
      },
    );
    expect((await verdictOf(f, call)).decision.ruleId).toBe('task-scope-incomplete');
  });

  it.each(['Grep', 'Glob', 'LS'])(
    'does not infer descendant permissions from the root supplied by %s',
    async (tool) => {
      const f = gateFixture({
        scope: {
          tools: [tool],
          read: { allow: [`${PROJECT}/**`], deny: [`${PROJECT}/private/**`] },
        },
      });
      const input = { path: PROJECT, pattern: '**/*', recursive: true };
      const call = callOf(tool, input, { resources: resourcesOf([['read', PROJECT]]) });
      const refused = await verdictOf(f, call);
      expect(refused.decision.ruleId).toBe('task-scope-incomplete');
      const fingerprint = wholeCallFingerprint(call);
      expect(refused.evidence.fingerprint).toBe(fingerprint);
      f.escalate(fingerprint);
      // An approval of one search cannot silently authorize another pattern or recursion setting.
      for (const change of [{ pattern: 'private/*' }, { recursive: false }]) {
        expect(
          (
            await verdictOf(f, {
              ...call,
              event: { ...call.event, toolInput: { ...input, ...change } },
            })
          ).decision.effect,
        ).toBe('deny');
      }
      expect((await verdictOf(f, call)).decision.effect).toBe('allow');
      expect((await verdictOf(f, call)).decision.effect).toBe('deny');
    },
  );
});
