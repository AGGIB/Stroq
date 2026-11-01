'use client';
import { LoaderCircle, Plug } from 'lucide-react';
import Link from 'next/link';
import { usePlatform } from './platform-provider';
import { PageHeading } from './platform-ui';

/**
 * What a page that reads the journal shows when nothing is connected. It never fills the gap
 * with invented rows; the only example data is the one a user turns on in Settings.
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
          <Plug size={30} aria-hidden="true" />
          <h3>Nothing to show yet</h3>
          <p>
            Not connected to Stroq on this machine. Run <code>npx @stroq/cli console</code> to open
            this page with your data.
          </p>
          {error ? <p className="risk-note">{error}</p> : null}
          <p className="not-connected-hint">
            Want to look around first? Choose Example data in{' '}
            <Link href="/settings/">Settings</Link>. Every page then says it is an example.
          </p>
        </div>
      )}
    </div>
  );
}
