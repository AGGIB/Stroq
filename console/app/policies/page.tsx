import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PolicySettingsPage } from '@/components/platform/policy-settings';

export const metadata: Metadata = { title: 'Policies' };
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-stack" aria-busy="true">
          <div className="page-heading">
            <div>
              <h1>Policies</h1>
            </div>
          </div>
          <p className="control-meta" role="status">
            Loading policy controls…
          </p>
        </div>
      }
    >
      <PolicySettingsPage />
    </Suspense>
  );
}
