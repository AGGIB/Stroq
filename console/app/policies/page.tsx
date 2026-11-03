import type { Metadata } from 'next';
import { RulesPage } from '@/components/platform/rules';

export const metadata: Metadata = { title: 'Rules' };
export default function Page() {
  return <RulesPage />;
}
