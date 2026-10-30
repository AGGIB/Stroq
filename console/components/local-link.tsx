'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Link2 } from 'lucide-react';
export function CopyLocalLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<string | null>(href);
  useEffect(() => {
    current.current = href;
    setCopied(false);
    setError(false);
    return () => {
      current.current = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [href]);
  return (
    <div className="local-copy-link">
      <button
        className="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${window.location.origin}${href}`);
            if (current.current !== href) return;
            setError(false);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          } catch {
            if (current.current === href) setError(true);
          }
        }}
      >
        {copied ? <Check size={16} /> : <Link2 size={16} />}
        {copied ? 'Copied' : 'Copy local link'}
      </button>
      {error && (
        <span className="control-meta" role="status">
          Link could not be copied.
        </span>
      )}
    </div>
  );
}
