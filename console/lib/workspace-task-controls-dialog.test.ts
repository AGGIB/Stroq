import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as schema from './workspace-task-controls';
import * as binding from './workspace-task-controls-binding';
import * as navigation from './workspace-review-navigation';
import {
  taskPreview,
  taskReceipt,
  taskRecord,
  taskState,
  taskWs,
} from './workspace-task-controls-fixtures';

function render(
  part: string,
  configure: (action: any) => void = () => {},
  selection = { requested: false, invalid: false, recordId: null as string | null },
) {
  const calls: unknown[] = [],
    elements: any[] = [],
    refs: { current: any }[] = [],
    effectDeps: (unknown[] | undefined)[] = [],
    effects: (() => void)[] = [],
    summaries = new Map<string, FocusElement>(),
    exports: any = {};
  let refCursor = 0,
    effectCursor = 0;
  const dom: any = { activeElement: null, body: null };
  class FocusElement {
    isConnected = true;
    disabled = false;
    ariaDisabled = false;
    focused = 0;
    scrolled: unknown[] = [];
    focusOptions: unknown[] = [];
    focus(options?: unknown) {
      this.focused++;
      this.focusOptions.push(options);
      dom.activeElement = this;
    }
    scrollIntoView(options: unknown) {
      this.scrolled.push(options);
    }
    matches() {
      return this.disabled || this.ariaDisabled;
    }
  }
  dom.body = new FocusElement();
  const controls: any = {
    state: taskState([taskRecord()]),
    open: true,
    operation: 'make-manual',
    preview: taskPreview(),
    ack: { effects: false, retention: false },
    busy: null,
    error: null,
    canPrepare: true,
    needsRecheck: false,
    unresolved: [],
    unresolvedRecords: [],
    receipt: taskReceipt(),
    acknowledge: (...args: unknown[]) => calls.push(args),
    apply: () => calls.push('apply'),
    close: () => calls.push('close'),
    refresh: () => calls.push('refresh'),
    recheck: (id: string) => calls.push(['recheck', id]),
    prepareRestore: (record: unknown) => calls.push(['restore', record]),
  };
  configure(controls);
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/workspace-task-controls.tsx'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const wrapper =
    (tag: string) =>
    ({ children, ...props }: any) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(props).filter(
            ([key, value]) =>
              !key.startsWith('on') && typeof value !== 'function' && key !== 'asChild',
          ),
        ),
        children,
      );
  vm.runInNewContext(code, {
    exports,
    document: dom,
    HTMLElement: FocusElement,
    require(name: string) {
      if (name === 'react')
        return {
          ...React,
          useEffect: (effect: () => void, deps?: unknown[]) => {
            const at = effectCursor++,
              before = effectDeps[at];
            if (!before || !deps || deps.some((value, index) => value !== before[index])) {
              effectDeps[at] = deps;
              effects.push(effect);
            }
          },
          useRef: (value: unknown) => {
            return (refs[refCursor++] ??= { current: value });
          },
        };
      if (name === 'react/jsx-runtime')
        return {
          ...jsx,
          jsx: (type: any, props: any, key: any) => {
            elements.push({ type, props });
            return jsx.jsx(type, props, key);
          },
          jsxs: (type: any, props: any, key: any) => {
            elements.push({ type, props });
            return jsx.jsxs(type, props, key);
          },
        };
      if (name === 'next/link') return { default: wrapper('a') };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === 'radix-ui')
        return {
          Dialog: {
            Root: ({ open, children }: any) => (open ? children : null),
            Portal: wrapper('div'),
            Overlay: wrapper('div'),
            Content: wrapper('div'),
            Title: wrapper('h2'),
            Description: wrapper('p'),
            Close: wrapper('button'),
          },
        };
      if (name === '@/components/platform-ui') return { Badge: wrapper('span') };
      if (name === '@/lib/workspace-task-controls') return schema;
      if (name === '@/lib/workspace-task-controls-binding') return binding;
      if (name === '@/lib/workspace-review-navigation') return navigation;
      throw Error(name);
    },
  });
  function rerender() {
    refCursor = effectCursor = 0;
    elements.length = 0;
    const html = renderToStaticMarkup(
      React.createElement(exports[part], {
        controls,
        selection,
        workspaceId: taskWs,
        onReturnFocus: () => calls.push('fallback-focus'),
      }),
    );
    for (const element of elements)
      if (element.type === 'summary' && element.props.ref) {
        const id = element.props.id,
          target = summaries.get(id) ?? new FocusElement();
        summaries.set(id, target);
        element.props.ref.current = target;
      }
    while (effects.length) effects.shift()!();
    return html;
  }
  const html = rerender();
  return {
    html,
    calls,
    elements,
    refs,
    dom,
    FocusElement,
    controls,
    selection,
    summaries,
    rerender,
  };
}
describe('actual task preview and recovery presentation', () => {
  it('returns Escape focus to the actual restore opener captured before dialog autofocus', () => {
    const page = render('WorkspaceTaskControlsDialog', (action) => {
      action.operation = 'restore';
      action.preview = taskPreview('restore');
    });
    const opener = new page.FocusElement(),
      heading = new page.FocusElement();
    page.dom.activeElement = opener;
    page.refs[1]!.current = heading;
    const dialog = page.elements.find(
      (element) => element.props.className === 'dialog-content mcp-containment-dialog',
    );
    dialog.props.onOpenAutoFocus({ preventDefault() {} });
    expect(page.dom.activeElement).toBe(heading);
    dialog.props.onCloseAutoFocus({ preventDefault() {} });
    expect(page.dom.activeElement).toBe(opener);
    expect(opener.focused).toBe(1);
    expect(page.calls).toEqual([]);
  });
  it('uses the existing fallback when the captured opener becomes disconnected or disabled', () => {
    for (const property of ['isConnected', 'disabled', 'ariaDisabled'] as const) {
      const page = render('WorkspaceTaskControlsDialog');
      const opener = new page.FocusElement();
      page.dom.activeElement = opener;
      const dialog = page.elements.find(
        (element) => element.props.className === 'dialog-content mcp-containment-dialog',
      );
      dialog.props.onOpenAutoFocus({ preventDefault() {} });
      opener[property] = property === 'isConnected' ? false : true;
      dialog.props.onCloseAutoFocus({ preventDefault() {} });
      expect(opener.focused).toBe(0);
      expect(page.calls).toEqual(['fallback-focus']);
    }
  });
  it('shows actual trigger counts and two unchecked consents before an explicit apply', () => {
    const page = render('WorkspaceTaskControlsDialog');
    expect(page.html).toContain('On folder open');
    expect(page.html).toContain('On worktree creation');
    expect(page.html).toContain('>2<');
    expect(page.html).toContain('>1<');
    expect(page.html).toContain('Manual tasks preserved');
    expect(page.html).toContain('unencrypted');
    expect(page.html).toContain(taskPreview().beforeSha256);
    expect(page.calls).toEqual([]);
    const checkboxes = page.elements.filter((element) => element.type === 'input');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((element) => element.props.checked === false)).toBe(true);
    const apply = page.elements.find(
      (element) => element.type === 'button' && element.props.children === 'Make tasks manual',
    );
    expect(apply.props.disabled).toBe(true);
    const accepted = render('WorkspaceTaskControlsDialog', (action) => {
      action.ack = { effects: true, retention: true };
    });
    expect(
      accepted.elements.find(
        (element) => element.type === 'button' && element.props.children === 'Make tasks manual',
      ).props.disabled,
    ).toBe(false);
  });
  it('uses a separate weakening warning and fresh unchecked consents for restoring triggers', () => {
    const page = render('WorkspaceTaskControlsDialog', (action) => {
      action.operation = 'restore';
      action.preview = taskPreview('restore');
    });
    expect(page.html).toContain('Restore automatic task settings');
    expect(page.html).toContain('restores automatic task triggers');
    expect(
      page.elements
        .filter((element) => element.type === 'input')
        .every((element) => element.props.checked === false),
    ).toBe(true);
  });
  it('keeps a confirmed write visible when recapture failed or the source changed afterward', () => {
    const page = render('WorkspaceTaskOutcome', (action) => {
      action.receipt.record.fileState = 'changed';
      action.receipt.record.canRestore = false;
      action.receipt.record.verification = {
        status: 'unavailable',
        runId: null,
        error: 'capture-unavailable',
      };
    });
    expect(page.html).toContain('File change confirmed');
    expect(page.html).toContain('File changed since this operation');
    expect(page.html).toContain('Fresh static capture unavailable');
    expect(page.html).not.toContain('Manual version present');
  });
  it('links a partial post-write capture to its exact saved workspace run', () => {
    const runId = '44444444-4444-4444-8444-444444444444';
    const page = render('WorkspaceTaskOutcome', (action) => {
      action.receipt.record.verification = {
        status: 'recorded',
        runId,
        captureSha256: '9'.repeat(64),
        capturedAt: action.receipt.checkedAt,
        complete: false,
        sourceMatches: true,
      };
    });
    expect(page.html).toContain('Partial static capture');
    expect(page.html).toContain(`/protection/workspace/?workspace=${taskWs}&amp;run=${runId}`);
    expect(page.html).not.toContain('Protected');
  });
  it('retains exact recovery selection on reload and never substitutes a missing record', () => {
    const missing = render('WorkspaceTaskRecovery', undefined, {
      requested: true,
      invalid: false,
      recordId: '55555555-5555-4555-8555-555555555555',
    });
    expect(missing.html).toContain('Selected recovery record unavailable');
    const selected = render('WorkspaceTaskRecovery', undefined, {
      requested: true,
      invalid: false,
      recordId: taskRecord().id,
    });
    expect(selected.html).toContain(`taskControl=${taskRecord().id}`);
    expect(selected.html).toContain('Recovery copy available');
    expect(selected.calls).toEqual([]);
    const restore = selected.elements.find(
      (element) => element.type === 'button' && element.props.children === 'Preview restore',
    );
    restore.props.onClick();
    expect(selected.calls).toEqual([['restore', taskRecord()]]);
  });
  it('focuses and reveals the exact selected record only after its async history arrives', () => {
    const record = taskRecord(),
      page = render(
        'WorkspaceTaskRecovery',
        (controls) => {
          controls.state = null;
        },
        {
          requested: true,
          invalid: false,
          recordId: record.id,
        },
      );
    expect(page.summaries.size).toBe(0);
    const other = { ...record, id: '55555555-5555-4555-8555-555555555555' };
    page.controls.state = taskState([other, record]);
    page.rerender();
    const target = page.summaries.get(`task-control-${record.id}`);
    expect(target?.focused).toBe(1);
    expect(target?.focusOptions).toEqual([{ preventScroll: true }]);
    expect(target?.scrolled).toEqual([{ block: 'center' }]);
    expect(page.dom.activeElement).toBe(target);
    expect(page.calls).toEqual([]);
  });
  it('does not steal focus on refresh or recheck but focuses a newly selected exact record', () => {
    const record = taskRecord(),
      other = { ...record, id: '55555555-5555-4555-8555-555555555555' },
      page = render(
        'WorkspaceTaskRecovery',
        (controls) => {
          controls.state = taskState([record, other]);
        },
        {
          requested: true,
          invalid: false,
          recordId: record.id,
        },
      );
    const target = page.summaries.get(`task-control-${record.id}`),
      opener = new page.FocusElement();
    expect(target?.focused).toBe(1);
    opener.focus();
    page.controls.state = taskState([{ ...record, revision: '9'.repeat(64) }, other]);
    page.rerender();
    expect(page.dom.activeElement).toBe(opener);
    expect(target?.focused).toBe(1);
    expect(target?.scrolled).toHaveLength(1);
    page.selection.recordId = other.id;
    page.rerender();
    expect(page.summaries.get(`task-control-${other.id}`)?.focused).toBe(1);
    expect(page.calls).toEqual([]);
  });
  it('never focuses another record for invalid, missing or unavailable selections', () => {
    for (const kind of ['invalid', 'missing', 'unavailable'] as const) {
      const page = render(
        'WorkspaceTaskRecovery',
        (controls) => {
          if (kind === 'unavailable')
            controls.state = { ...taskState([taskRecord()]), available: false };
        },
        {
          requested: true,
          invalid: kind === 'invalid',
          recordId: kind === 'missing' ? '55555555-5555-4555-8555-555555555555' : taskRecord().id,
        },
      );
      expect(page.dom.activeElement).toBe(null);
      expect([...page.summaries.values()].every((value) => value.focused === 0)).toBe(true);
      expect(page.calls).toEqual([]);
    }
  });
});
