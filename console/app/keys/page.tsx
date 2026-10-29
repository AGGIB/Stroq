import type { Metadata } from 'next';
import { Suspense } from 'react';
import { KeysPage } from '@/components/platform/keys';

export const metadata: Metadata = { title: 'Secrets' };
export default function Page() {
  return (
    <Suspense fallback={<div className="control-empty">Loading credential reports…</div>}>
      <KeysPage />
    </Suspense>
  );
}
