import type { Metadata } from 'next';
import { SessionsPage } from '@/components/platform/sessions';

export const metadata: Metadata = { title: 'Sessions' };
export default function Page() {
  return <SessionsPage />;
}
