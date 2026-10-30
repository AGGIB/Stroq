'use client';
import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import { usePosture } from './use-posture';
import { postureStripText } from '@/lib/posture';

/** One line on the Protection page that points at the settings check when it has found something. */
export function PostureStrip() {
  const { audit } = usePosture();
  const line = audit === null ? null : postureStripText(audit);
  if (line === null) return null;
  return (
    <Link href="/posture/" className={`posture-strip ${line.serious ? 'is-serious' : ''}`}>
      <ListChecks size={18} aria-hidden="true" />
      <span className="posture-strip-text">
        <strong>{line.text}</strong>
        <span className="muted">
          {line.serious ? 'Open the settings check' : 'Open the settings check anyway'}
        </span>
      </span>
      <ArrowRight size={16} aria-hidden="true" />
    </Link>
  );
}
