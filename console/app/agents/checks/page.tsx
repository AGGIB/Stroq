import { Suspense } from 'react';
import type { Metadata } from 'next';
import { LiveChecksPage } from '@/components/platform/live-checks';

export const metadata: Metadata = { title: 'Blocking checks' };
export default function Page() {
  return (
    <Suspense fallback={<p className="control-meta">Loading blocking-check history…</p>}>
      <LiveChecksPage />
    </Suspense>
  );
}
