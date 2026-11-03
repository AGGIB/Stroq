'use client';
import { LoaderCircle } from 'lucide-react';
import { Hoo } from './hoo';
import { usePlatform } from './platform-provider';
import { PageHeading } from './platform-ui';

/**
 * What a page that reads the journal shows when nothing is connected. It never fills the gap
 * with invented rows.
 */
export function NotConnected({ title }: { title: string }) {
  const { ready, loading, error } = usePlatform();
  const connecting = !ready || loading;
  return (
    <div className="page-stack">
      <PageHeading title={title} />
      {connecting ? (
        <div className="empty-state not-connected" role="status">
          <LoaderCircle size={30} className="spin" aria-hidden="true" />
          <h3>Connecting to Stroq…</h3>
          <p>Reading your journal on this machine.</p>
        </div>
      ) : (
        <div className="empty-state not-connected" role="status">
          <Hoo frame="idle" size={72} />
          <h3>Nothing to show yet</h3>
          <p>
            Not connected to Stroq on this machine. Run <code>npx @stroq/cli console</code> to open
            this page with your data.
          </p>
          {error ? <p className="risk-note">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
