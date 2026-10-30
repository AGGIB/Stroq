import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TaskLocksPage } from '@/components/platform/task-locks';
import { AgentGlyph, PageHeading, Panel } from '@/components/platform-ui';
export const metadata: Metadata = { title: 'Task permissions' };
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-stack">
          <PageHeading title="Task permissions" />
          <Panel>
            <div className="control-empty" role="status">
              <AgentGlyph name="Claude Code" />
              <p>Reading task permissions…</p>
            </div>
          </Panel>
        </div>
      }
    >
      <TaskLocksPage />
    </Suspense>
  );
}
