import type { Metadata } from 'next';
import { LivePage } from '@/components/platform/live-view';

export const metadata: Metadata = { title: 'Live' };
export default function Page() {
  return <LivePage />;
}
