import type { Metadata } from 'next';
import { PosturePage } from '@/components/platform/posture-check';

export const metadata: Metadata = { title: 'Settings check' };
export default function Page() {
  return <PosturePage />;
}
