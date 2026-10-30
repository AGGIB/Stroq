import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SkillQuarantinePage } from '@/components/platform/skill-quarantine';
export const metadata: Metadata = { title: 'Skill quarantine' };
export default function Page() {
  return (
    <Suspense fallback={<div className="control-empty">Loading quarantine history…</div>}>
      <SkillQuarantinePage />
    </Suspense>
  );
}
