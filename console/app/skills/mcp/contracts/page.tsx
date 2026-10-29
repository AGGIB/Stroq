import type { Metadata } from 'next';
import { Suspense } from 'react';
import { McpToolContractsPage } from '@/components/platform/mcp-tool-contracts';
export const metadata: Metadata = { title: 'MCP tool review' };
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-stack">
          <h1>MCP tool review</h1>
          <p className="control-meta" role="status">
            Loading recorded contracts…
          </p>
        </div>
      }
    >
      <McpToolContractsPage />
    </Suspense>
  );
}
