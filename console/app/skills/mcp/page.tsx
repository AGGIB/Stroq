import type { Metadata } from 'next';
import { Suspense } from 'react';
import { McpContainmentPage } from '@/components/platform/mcp-containment';

export const metadata: Metadata = { title: 'MCP registrations' };
export default function Page() {
  return (
    <Suspense fallback={<div className="control-empty">Loading MCP registration history…</div>}>
      <McpContainmentPage />
    </Suspense>
  );
}
