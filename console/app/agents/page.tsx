import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AgentsPage } from '@/components/platform/agents';
import { AgentsLoading } from '@/components/platform/agents-loading';

export const metadata: Metadata = { title: 'Agents' };
export default function Page() {
  return (
    <Suspense fallback={<AgentsLoading />}>
      <AgentsPage />
    </Suspense>
  );
}
