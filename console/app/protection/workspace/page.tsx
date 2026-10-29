import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FolderSearch } from 'lucide-react';
import { PageHeading, Panel } from '@/components/platform-ui';
import { WorkspaceReviewPage } from '@/components/platform/workspace-review';
export const metadata: Metadata = { title: 'Workspace review' };
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-stack">
          <PageHeading title="Workspace review" />
          <Panel>
            <div className="control-empty" role="status">
              <FolderSearch size={28} />
              <p>Reading saved workspace checks…</p>
            </div>
          </Panel>
        </div>
      }
    >
      <WorkspaceReviewPage />
    </Suspense>
  );
}
