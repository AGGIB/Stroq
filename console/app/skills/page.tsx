import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SkillsMcpPage } from '@/components/platform/inventory';
export const metadata: Metadata = { title: 'Skills & MCP' };
export default function Page() {
  return (
    <Suspense fallback={<div className="control-empty">Loading skills and MCP servers…</div>}>
      <SkillsMcpPage />
    </Suspense>
  );
}
