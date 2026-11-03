import type { Metadata } from 'next';
import { CheckPage } from '@/components/platform/check';

export const metadata: Metadata = { title: 'Check' };
export default function Page() {
  return <CheckPage />;
}
