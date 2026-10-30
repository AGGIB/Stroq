import { Suspense } from 'react';
import { InvestigationPage } from '@/components/platform-activity';
export default function Page() {
  return (
    <Suspense fallback={<p className="muted">Loading event…</p>}>
      <InvestigationPage />
    </Suspense>
  );
}
