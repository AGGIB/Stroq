'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isCopyable } from '@/lib/shell';
import { cn } from '@/lib/utils';

const COPIED_MS = 1600;

interface CopyCommandProps {
  readonly command: string;
  readonly className?: string;
}

/**
 * A real CLI command on one line. The console only reads; changes run in your terminal.
 * A command that holds a newline or hidden characters, or that is too long to be seen whole, is
 * never offered: what you see is exactly what you copy.
 */
export function CopyCommand({ command, className }: CopyCommandProps) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  if (!isCopyable(command)) {
    return (
      <p
        className={cn(
          'min-h-8 w-full rounded-md bg-code px-2.5 py-1.5 text-xs text-ink-2',
          className,
        )}
        role="note"
      >
        This command contains characters Stroq will not show or copy.
      </p>
    );
  }

  function selectCommand() {
    const node = codeRef.current;
    const selection = window.getSelection();
    if (node === null || selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // No clipboard access: select the text so ⌘C still works.
      selectCommand();
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-8 w-full min-w-0 items-center gap-1 rounded-md bg-code pl-2.5 pr-0.5',
        className,
      )}
    >
      <code
        ref={codeRef}
        tabIndex={0}
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {command}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={copy}
            aria-label={`Copy command: ${command}`}
            className={cn(
              'size-7 shrink-0 text-ink-3 hover:text-foreground',
              copied && 'text-st-green hover:text-st-green',
            )}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
      </Tooltip>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  );
}
