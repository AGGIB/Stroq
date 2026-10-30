import type { Metadata } from 'next';
import { Overview } from '@/components/platform-overview';
export const metadata: Metadata = { title: 'Activity overview' };
export default function Page() {
  return <Overview />;
}
