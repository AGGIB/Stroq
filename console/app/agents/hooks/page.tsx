import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PageHeading, Panel } from '@/components/platform-ui';
import { HookCheckHistoryPage } from '@/components/platform/hook-check-history';

export const metadata: Metadata = { title: 'Stroq hook checks' };
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-stack">
          <PageHeading title="Stroq hook checks" />
          <Panel>
            <div className="panel-body">
              <p className="control-meta" role="status">
                Reading recorded hook checks…
              </p>
            </div>
          </Panel>
        </div>
      }
    >
      <HookCheckHistoryPage />
    </Suspense>
  );
}
