import type { Metadata } from 'next';
import { IncidentsPage } from '@/components/platform/incidents';
import { Suspense } from 'react';
export const metadata: Metadata = { title: 'Investigations' };
export default function Page() {
  return (
    <Suspense fallback={<div className="control-empty">Loading investigations…</div>}>
      <IncidentsPage />
    </Suspense>
  );
}
