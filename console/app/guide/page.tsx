import type { Metadata } from 'next';
import { GuidePage } from '@/components/platform/guide';

export const metadata: Metadata = { title: 'Guide' };
export default function Page() {
  return <GuidePage />;
}
