import type { Metadata } from 'next';
import { PolicyCasesPage } from '@/components/platform/policy-cases';

export const metadata: Metadata = { title: 'Saved checks' };
export default function Page() {
  return <PolicyCasesPage />;
}
