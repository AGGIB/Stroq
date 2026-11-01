'use client';
import { FlaskConical } from 'lucide-react';
import { usePlatform } from './platform-provider';

/** Shown on every page while the made-up example is on, so it can never pass for the user's data. */
export function ExampleDataBanner() {
  const { source, localAccess, leaveExample } = usePlatform();
  if (source !== 'demo') return null;
  return (
    <div className="example-banner" role="status">
      <FlaskConical size={16} aria-hidden="true" />
      <p>
        <strong>Example data, not yours.</strong> Activity, Sessions and Overview show made-up
        events and agents.
      </p>
      <button type="button" className="button small" onClick={leaveExample}>
        {localAccess ? 'Back to my data' : 'Leave the example'}
      </button>
    </div>
  );
}
