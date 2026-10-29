import type { Metadata } from 'next';
import { TryActionPage } from '@/components/platform/try-action';

export const metadata: Metadata = { title: 'Try an action' };
export default function Page() {
  return <TryActionPage />;
}
