import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const seen = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(seen.search),
  usePathname: () => '/policies/',
}));
vi.mock('next/link', async () => {
  const { createElement: h } = await import('react');
  return { default: ({ href, children, ...rest }: any) => h('a', { href, ...rest }, children) };
});
vi.mock('@/components/copy-command', async () => {
  const { createElement: h } = await import('react');
  return { CopyCommand: ({ command }: { command: string }) => h('code', null, command) };
});
vi.mock('@/components/platform/try-action', async () => {
  const { createElement: h } = await import('react');
  return { TryAction: () => h('section', { id: 'try' }, 'try section') };
});
vi.mock('@/components/platform/policy-settings', async () => {
  const { createElement: h } = await import('react');
  return { PolicySettings: () => h('section', { id: 'rules' }, 'rules section') };
});
vi.mock('@/components/platform/policy-history', async () => {
  const { createElement: h } = await import('react');
  return { PolicyHistory: () => h('section', { id: 'history' }, 'history section') };
});

import { RulesPage } from '@/components/platform/rules';
import { RulesReference } from '@/components/platform/policies';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  seen.search = '';
});

describe('the Rules screen', () => {
  it('puts Try an action first, then the rules, the history and the reference', () => {
    const out = renderToStaticMarkup(createElement(RulesPage));
    const order = ['id="try"', 'id="rules"', 'id="history"', 'id="reference"'].map((id) =>
      out.indexOf(id),
    );
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text(out)).toContain('Nothing is written until you apply a tested change.');
  });
});

describe('the rules reference', () => {
  const render = () => text(renderToStaticMarkup(createElement(RulesReference)));

  it('lists every rule, and says how many', () => {
    const out = render();
    expect(out).toContain('Rules reference');
    expect(out).toMatch(/Rules\s+\d+ \/ \d+/);
    expect(out).toContain('deny-secret-egress');
    expect(out).toContain('deny-encoded-exec');
  });

  it('opens on the rule a link names, and shows only what matches', () => {
    seen.search = 'find=deny-secret-egress';
    const out = render();
    expect(out).toContain('deny-secret-egress');
    expect(out).not.toContain('deny-encoded-exec');
    expect(out).toContain('1 / ');
  });

  it('says there is no match for an unknown rule, and ignores a search that is not plain', () => {
    seen.search = 'find=nothing-like-this';
    expect(render()).toContain('No matching rules');
    seen.search = 'find=' + encodeURIComponent('x'.repeat(200));
    expect(render()).toContain('deny-encoded-exec');
  });
});
