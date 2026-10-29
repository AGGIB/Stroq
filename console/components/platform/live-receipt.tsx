'use client';
import { useMemo, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Panel } from '@/components/platform-ui';
import { usePosture } from './use-posture';
import { buildReceipt } from '@/lib/receipt';
import type { JournalSummary } from '@/lib/journal-view';

type CopyState = 'idle' | 'copied' | 'failed';

/** The receipt, shown as the exact text that Copy and Download hand over. Counts only. */
export function LiveReceipt({ summary }: { summary: JournalSummary | null }) {
  const { audit } = usePosture();
  const [copy, setCopy] = useState<CopyState>('idle');
  const made = useMemo(() => {
    const at = new Date();
    const text = summary === null ? null : buildReceipt(summary, audit, at);
    return text === null ? null : { text, day: at.toISOString().slice(0, 10) };
  }, [summary, audit]);
  if (made === null) return null;

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(made.text);
      setCopy('copied');
      setTimeout(() => setCopy('idle'), 2500);
    } catch {
      setCopy('failed');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([made.text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `stroq-receipt-${made.day}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      title="Receipt"
      actions={
        <div className="live-receipt-actions">
          <button className="button" onClick={() => void copyText()}>
            {copy === 'copied' ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Copy size={15} aria-hidden="true" />
            )}
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </button>
          <button className="button" onClick={download}>
            <Download size={15} aria-hidden="true" />
            Download
          </button>
        </div>
      }
    >
      <p className="live-note">
        Counts only, to paste into a chat or a ticket. This is exactly the text that is copied.
        {copy === 'failed' ? ' Your browser did not allow copying; select the text below.' : ''}
      </p>
      <pre className="live-receipt-text" tabIndex={0} aria-label="Receipt text">
        {made.text}
      </pre>
    </Panel>
  );
}
