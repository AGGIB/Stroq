import type { Metadata } from 'next';
import { Suspense } from 'react';
import { History } from 'lucide-react';
import { PageHeading, Panel } from '@/components/platform-ui';
import { PolicyHistoryPage } from '@/components/platform/policy-history';
export const metadata: Metadata = { title: 'Policy history' };
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-stack">
          <PageHeading title="Policy history" />
          <Panel>
            <div className="control-empty" role="status">
              <History size={28} aria-hidden="true" />
              <p>Reading recorded policy changes…</p>
            </div>
          </Panel>
        </div>
      }
    >
      <PolicyHistoryPage />
    </Suspense>
  );
}
