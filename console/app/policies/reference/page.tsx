import type { Metadata } from 'next';
import Link from 'next/link';
import { PoliciesPage } from '@/components/platform/policies';
export const metadata: Metadata = { title: 'Rule reference' };
export default function Page() {
  return (
    <div className="page-stack">
      <Link className="inline-link" href="/policies/">
        ← Active policy settings
      </Link>
      <PoliciesPage />
    </div>
  );
}
