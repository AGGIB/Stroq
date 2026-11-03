'use client';
import { Suspense } from 'react';
import { PageHeading } from '@/components/platform-ui';
import { useScrollToHash } from '@/hooks/use-scroll-to-hash';
import { PolicyHistory } from './policy-history';
import { PolicySettings } from './policy-settings';
import { RulesReference } from './policies';
import { TryAction } from './try-action';

const loading = (what: string) => (
  <p className="control-meta" role="status">
    {what}
  </p>
);

/**
 * Rules: what a command would get, the rules you can turn on with a preview and a test before they
 * are written, what changed and the undo of it, and the reference of the rules there are. The saved
 * policy checks that gate a write are on their own page, linked from the rules you can change.
 */
export function RulesPage() {
  useScrollToHash(true);
  return (
    <div className="page-stack rules-page">
      <PageHeading
        title="Rules"
        description="What a command would get, the rules you can turn on, what changed and the rules reference. Nothing is written until you apply a tested change."
      />
      <TryAction />
      <PolicySettings />
      <Suspense fallback={loading('Reading the history…')}>
        <PolicyHistory />
      </Suspense>
      <Suspense fallback={loading('Reading the reference…')}>
        <RulesReference />
      </Suspense>
    </div>
  );
}
