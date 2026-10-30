import type { Metadata } from 'next';
import { SkillsPage } from '@/components/platform/skills';
export const metadata: Metadata = { title: 'Scan content' };
export default function Page() {
  return <SkillsPage />;
}
