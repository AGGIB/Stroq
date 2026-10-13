import { describe, expect, it } from 'vitest';
import { wholeCallFingerprint } from '../../src/scope/scope-check.js';
import { fileTarget, fingerprintOf } from '../../src/scope/fingerprint.js';
import type { ActionClass } from '../../src/types.js';
import { callOf, gateFixture, resourcesOf, verdictOf } from './gate-fixture.js';

const HINT = /to extend: stroq permit extend fix-login-1 ([0-9a-f]{64})/;
const fpOf = (reason: string): string => HINT.exec(reason)?.[1] ?? '';
const SRC = '/work/project/src/a.ts';

describe('step 3: the scope refuses', () => {
  it('refuses a tool that is not in the list, with a hint to extend it', async () => {
    const f = gateFixture();
    const verdict = await verdictOf(f, callOf('WebSearch', { query: 'x' }));
    expect(verdict.decision.effect).toBe('deny');
    expect(verdict.decision.ruleId).toBe('task-scope-tool');
    expect(verdict.evidence.kind).toBe('scope');
    expect(fpOf(verdict.decision.reason)).toBe(
      wholeCallFingerprint(callOf('WebSearch', { query: 'x' })),
    );
    expect(verdict.evidence.fingerprint).toBe(fpOf(verdict.decision.reason));
  });

  it('allows a tool that is in the list when nothing else is wrong', async () => {
    const f = gateFixture();
    const verdict = await verdictOf(f, callOf('TodoWrite', { todos: [] }));
    expect(verdict.decision.effect).toBe('allow');
    expect(verdict.evidence.kind).toBe('in-scope');
    expect(verdict.taskId).toBe(f.taskId);
  });

  it('matches tool names exactly: case and prefixes do not count', async () => {
    const f = gateFixture({ scope: { tools: ['Read'] } });
    for (const tool of ['read', 'READ', 'Read ', 'ReadX', 'Rea', '']) {
      const verdict = await verdictOf(f, callOf(tool));
      expect(verdict.decision.ruleId, tool).toBe('task-scope-tool');
    }
  });

  describe('paths', () => {
    it('allows a read inside the read globs and a write inside the write globs', async () => {
      const f = gateFixture();
      const read = callOf('Read', { file_path: SRC }, { resources: resourcesOf([['read', SRC]]) });
      const write = callOf(
        'Edit',
        { file_path: SRC },
        { resources: resourcesOf([['write', SRC]]) },
      );
      expect((await verdictOf(f, read)).decision.effect).toBe('allow');
      expect((await verdictOf(f, write)).decision.effect).toBe('allow');
    });

    it('refuses a path outside the allow globs, naming it', async () => {
      const f = gateFixture();
      const verdict = await verdictOf(
        f,
        callOf(
          'Read',
          { file_path: '/etc/hosts' },
          { resources: resourcesOf([['read', '/etc/hosts']]) },
        ),
      );
      expect(verdict.decision.ruleId).toBe('task-scope-path');
      expect(verdict.decision.reason).toContain('/etc/hosts');
      expect(fpOf(verdict.decision.reason)).toBe(fingerprintOf('Read', 'file:read', '/etc/hosts'));
    });

    it('refuses a path inside a deny glob even though an allow glob covers it', async () => {
      const f = gateFixture();
      const env = '/work/project/app/.env.local';
      const verdict = await verdictOf(
        f,
        callOf('Read', { file_path: env }, { resources: resourcesOf([['read', env]]) }),
      );
      expect(verdict.decision.ruleId).toBe('task-scope-path');
    });

    it('holds a write to the write globs, not the read globs', async () => {
      const f = gateFixture();
      const readme = '/work/project/README.md';
      const read = callOf(
        'Read',
        { file_path: readme },
        { resources: resourcesOf([['read', readme]]) },
      );
      const write = callOf(
        'Write',
        { file_path: readme },
        { resources: resourcesOf([['write', readme]]) },
      );
      expect((await verdictOf(f, read)).decision.effect).toBe('allow');
      const refused = await verdictOf(f, write);
      expect(refused.decision.ruleId).toBe('task-scope-path');
      expect(fpOf(refused.decision.reason)).toBe(wholeCallFingerprint(write));
    });

    it('holds the real path to the same rules: a link inside the root that leads out is outside', async () => {
      const f = gateFixture();
      const link = '/work/project/src/link';
      const verdict = await verdictOf(
        f,
        callOf(
          'Read',
          { file_path: link },
          { resources: resourcesOf([['read', link, '/etc/passwd']]) },
        ),
      );
      expect(verdict.decision.ruleId).toBe('task-scope-path');
      expect(fpOf(verdict.decision.reason)).toBe(
        fingerprintOf('Read', 'file:read', fileTarget(link, '/etc/passwd')),
      );
    });

    it('checks every path of a call and refuses if any one is outside', async () => {
      const f = gateFixture();
      const verdict = await verdictOf(
        f,
        callOf(
          'Edit',
          {},
          {
            resources: resourcesOf([
              ['write', SRC],
              ['write', '/work/project/package.json'],
            ]),
          },
        ),
      );
      expect(verdict.decision.ruleId).toBe('task-scope-path');
      expect(verdict.decision.reason).toContain('package.json');
      expect(verdict.decision.reason).not.toContain('src/a.ts');
    });

    it('refuses a relative or .. path rather than guessing', async () => {
      const f = gateFixture();
      for (const path of ['src/a.ts', '/work/project/src/../../../etc/passwd']) {
        const verdict = await verdictOf(
          f,
          callOf('Read', {}, { resources: resourcesOf([['read', path]]) }),
        );
        expect(verdict.decision.ruleId, path).toBe('task-scope-path');
      }
    });

    it('does not let control characters in a path reach the reason text', async () => {
      const f = gateFixture();
      const path = '/etc/\u001b]52;c;Zm9v\u0007/\nx';
      const verdict = await verdictOf(
        f,
        callOf('Read', {}, { resources: resourcesOf([['read', path]]) }),
      );
      expect(verdict.decision.reason).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/);
    });

    it('holds an MCP call to the path rules for the paths its arguments name', async () => {
      const f = gateFixture({ scope: { mcp: [{ server: 'docs', tools: '*' }] } });
      const mcp = { server: 'docs', tool: 'open' };
      const bad = callOf(
        'mcp__docs__open',
        { path: '/etc/shadow' },
        {
          mcp,
          resources: resourcesOf([['read', '/etc/shadow']]),
        },
      );
      expect((await verdictOf(f, bad)).decision.ruleId).toBe('task-scope-path');
      const good = callOf(
        'mcp__docs__open',
        { path: SRC },
        { mcp, resources: resourcesOf([['read', SRC]]) },
      );
      expect((await verdictOf(f, good)).decision.effect).toBe('allow');
    });
  });

  describe('paths that cannot be read in full', () => {
    it.each(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])(
      'refuses %s when its paths are not complete',
      async (tool) => {
        const f = gateFixture({ scope: { tools: [tool] } });
        const verdict = await verdictOf(
          f,
          callOf(
            tool,
            { pattern: '**' },
            { resources: resourcesOf([['read', SRC]], { pathsComplete: false }) },
          ),
        );
        expect(verdict.decision.ruleId).toBe('task-scope-incomplete');
        expect(verdict.evidence.kind).toBe('scope');
      },
    );

    it('treats a classification with no resources at all (an older code path) as incomplete', async () => {
      const f = gateFixture();
      for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) {
        const verdict = await verdictOf(f, callOf(tool, { file_path: SRC }));
        expect(verdict.decision.ruleId, tool).toBe('task-scope-incomplete');
      }
    });

    it('does not ask a tool that touches no files for paths it does not have', async () => {
      const f = gateFixture({
        scope: { tools: ['TodoWrite', 'WebSearch'], net: { mode: 'hosts', hosts: ['a.invalid'] } },
      });
      expect((await verdictOf(f, callOf('TodoWrite'))).decision.effect).toBe('allow');
      expect((await verdictOf(f, callOf('WebSearch'))).decision.effect).toBe('allow');
    });

    // A tool the classifier read no resources of may open any file; a subagent can do anything.
    it.each(['Task', 'NotebookRead', 'LSP', 'SomethingNew'])(
      'holds %s to the scope as an incomplete call, because nothing says what it opens',
      async (tool) => {
        const f = gateFixture({ scope: { tools: [tool] } });
        const verdict = await verdictOf(f, callOf(tool, { filePath: '/etc/passwd' }));
        expect(verdict.decision.effect).toBe('deny');
        expect(verdict.decision.ruleId).toBe('task-scope-incomplete');
      },
    );
  });

  describe('the network', () => {
    const NET: ActionClass[] = ['shell.network', 'network.fetch', 'git.push_external'];

    it.each(NET)('refuses %s when the scope says no network', async (cls) => {
      const f = gateFixture({ scope: { tools: ['Bash', 'WebFetch'] } });
      const verdict = await verdictOf(f, callOf('Bash', { command: 'x' }, { classes: [cls] }));
      expect(verdict.decision.ruleId).toBe('task-scope-net');
    });

    it('lets a call with no network class through under net none', async () => {
      const f = gateFixture();
      const verdict = await verdictOf(
        f,
        callOf('Bash', { command: 'echo hi' }, { classes: ['mcp.call'] }),
      );
      expect(verdict.decision.effect).toBe('allow');
    });

    it('allows a listed host, an exact name or under a wildcard, and refuses any other', async () => {
      const f = gateFixture({
        scope: {
          tools: ['WebFetch'],
          net: { mode: 'hosts', hosts: ['api.example.com', '*.example.org'] },
        },
      });
      const fetchOf = (host: string) =>
        callOf(
          'WebFetch',
          { url: `https://${host}/x` },
          {
            classes: ['network.fetch'],
            hosts: [host],
            resources: resourcesOf([], { urls: [{ url: `https://${host}/x`, host }] }),
          },
        );
      for (const host of [
        'api.example.com',
        'API.example.com',
        'a.example.org',
        'a.b.example.org',
      ]) {
        expect((await verdictOf(f, fetchOf(host))).decision.effect, host).toBe('allow');
      }
      for (const host of [
        'example.com',
        'evil.com',
        'example.org',
        'api.example.com.evil.com',
        'xexample.org',
      ]) {
        expect((await verdictOf(f, fetchOf(host))).decision.ruleId, host).toBe('task-scope-net');
      }
    });

    it('refuses a network call whose host cannot be read when only some hosts are allowed', async () => {
      const f = gateFixture({
        scope: { tools: ['Bash'], net: { mode: 'hosts', hosts: ['api.example.com'] } },
      });
      const verdict = await verdictOf(
        f,
        callOf('Bash', { command: 'x' }, { classes: ['shell.network'] }),
      );
      expect(verdict.decision.ruleId).toBe('task-scope-net');
    });

    it('refuses when any one of several hosts is not allowed', async () => {
      const f = gateFixture({
        scope: { tools: ['Bash'], net: { mode: 'hosts', hosts: ['api.example.com'] } },
      });
      const verdict = await verdictOf(
        f,
        callOf(
          'Bash',
          { command: 'x' },
          { classes: ['shell.network'], hosts: ['api.example.com', 'evil.com'] },
        ),
      );
      expect(verdict.decision.ruleId).toBe('task-scope-net');
    });

    it('ignores a port and a trailing dot when it compares hosts', async () => {
      const f = gateFixture({
        scope: { tools: ['Bash'], net: { mode: 'hosts', hosts: ['api.example.com'] } },
      });
      const verdict = await verdictOf(
        f,
        callOf(
          'Bash',
          { command: 'x' },
          { classes: ['shell.network'], hosts: ['api.example.com.:8443'] },
        ),
      );
      expect(verdict.decision.effect).toBe('allow');
    });
  });

  describe('MCP', () => {
    const mcpCall = (server: string, tool: string, args: Record<string, unknown> = {}) =>
      callOf(`mcp__${server}__${tool}`, args, { classes: ['mcp.call'], mcp: { server, tool } });

    it('refuses a server that is not listed, and a tool that is not listed on a listed server', async () => {
      const f = gateFixture({ scope: { mcp: [{ server: 'docs', tools: ['search'] }] } });
      expect((await verdictOf(f, mcpCall('other', 'search'))).decision.ruleId).toBe(
        'task-scope-mcp',
      );
      expect((await verdictOf(f, mcpCall('docs', 'delete'))).decision.ruleId).toBe(
        'task-scope-mcp',
      );
      expect((await verdictOf(f, mcpCall('docs', 'search'))).decision.effect).toBe('allow');
    });

    it('allows every tool of a server listed with *', async () => {
      const f = gateFixture({ scope: { mcp: [{ server: 'docs', tools: '*' }] } });
      expect((await verdictOf(f, mcpCall('docs', 'anything'))).decision.effect).toBe('allow');
      expect((await verdictOf(f, mcpCall('docs2', 'anything'))).decision.ruleId).toBe(
        'task-scope-mcp',
      );
    });

    it('governs MCP calls by the mcp list and not by the tools list', async () => {
      const f = gateFixture({ scope: { tools: ['mcp__docs__search'], mcp: [] } });
      expect((await verdictOf(f, mcpCall('docs', 'search'))).decision.ruleId).toBe(
        'task-scope-mcp',
      );
    });

    it('refuses everything MCP when the scope lists no server', async () => {
      const f = gateFixture();
      expect((await verdictOf(f, mcpCall('docs', 'search'))).decision.ruleId).toBe(
        'task-scope-mcp',
      );
    });

    it('falls back to reading the server and tool from the name when the classifier gave none', async () => {
      const f = gateFixture({ scope: { mcp: [{ server: 'docs', tools: ['search'] }] } });
      const verdict = await verdictOf(
        f,
        callOf('mcp__docs__search', {}, { classes: ['mcp.call'] }),
      );
      expect(verdict.decision.effect).toBe('allow');
      const odd = await verdictOf(f, callOf('mcp__', {}, { classes: ['mcp.call'] }));
      expect(odd.decision.ruleId).toBe('task-scope-mcp');
    });

    it('names the call by server/tool and the digest of its arguments', async () => {
      const f = gateFixture();
      const verdict = await verdictOf(f, mcpCall('docs', 'search', { q: 'x', n: 2 }));
      expect(fpOf(verdict.decision.reason)).toBe(
        wholeCallFingerprint(mcpCall('docs', 'search', { n: 2, q: 'x' })),
      );
    });
  });

  describe('shell', () => {
    it('refuses a shell tool when the scope says shell is denied', async () => {
      const f = gateFixture({ scope: { shell: 'denied' } });
      const verdict = await verdictOf(f, callOf('Bash', { command: 'npm test' }));
      expect(verdict.decision.ruleId).toBe('task-scope-shell');
      expect(fpOf(verdict.decision.reason)).toBe(
        wholeCallFingerprint(callOf('Bash', { command: 'npm test' })),
      );
    });

    it('covers PowerShell and Monitor too', async () => {
      const f = gateFixture({ scope: { shell: 'denied', tools: ['PowerShell', 'Monitor'] } });
      for (const tool of ['PowerShell', 'Monitor']) {
        expect((await verdictOf(f, callOf(tool, { command: 'x' }))).decision.ruleId).toBe(
          'task-scope-shell',
        );
      }
    });

    // The hook cannot see what a command opens: `python x.py` and `npm test` read and write
    // whatever they like. File access of a shell command is the sandbox's job, and the gate
    // says so by not pretending to check the paths the classifier happened to find.
    it('does not hold an allowed shell command to the path rules', async () => {
      const f = gateFixture();
      const verdict = await verdictOf(
        f,
        callOf(
          'Bash',
          { command: 'cat /etc/hosts' },
          { resources: resourcesOf([['read', '/etc/hosts']], { shell: true }) },
        ),
      );
      expect(verdict.decision.effect).toBe('allow');
    });

    it('still holds an allowed shell command to the tool list and the network rule', async () => {
      const f = gateFixture({ scope: { tools: ['Read'] } });
      expect((await verdictOf(f, callOf('Bash', { command: 'x' }))).decision.ruleId).toBe(
        'task-scope-tool',
      );
      const g = gateFixture();
      expect(
        (await verdictOf(g, callOf('Bash', { command: 'x' }, { classes: ['shell.network'] })))
          .decision.ruleId,
      ).toBe('task-scope-net');
    });
  });

  it('reports the first refusal when there are several, in the order tool, shell, path, incomplete, net', async () => {
    const f = gateFixture({ scope: { tools: ['Read'], shell: 'denied' } });
    const verdict = await verdictOf(
      f,
      callOf(
        'Bash',
        { command: 'x' },
        { classes: ['shell.network'], resources: resourcesOf([['read', '/etc/x']]) },
      ),
    );
    expect(verdict.decision.ruleId).toBe('task-scope-tool');
  });
});
