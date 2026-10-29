import { Suspense } from 'react';
import { ActivityPage } from '@/components/platform-activity';
export default function Page() {
  return (
    <Suspense fallback={<p className="muted">Loading activity…</p>}>
      <ActivityPage />
    </Suspense>
  );
}
