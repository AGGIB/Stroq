import type { Metadata } from 'next';
import { ProtectionPage } from '@/components/platform/protection';

export const metadata: Metadata = { title: 'Protection' };
export default function Page() {
  return <ProtectionPage />;
}
