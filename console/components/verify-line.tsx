import { ShieldCheck } from 'lucide-react';
import { CopyCommand } from './copy-command';

/** One quiet row at the end of a page: the CLI command that checks this page's claim. */
export function VerifyLine({ text, command }: { readonly text: string; readonly command: string }) {
  return (
    <div className="mt-12 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-t border-border pt-4 text-[13px] text-ink-2">
      <ShieldCheck aria-hidden="true" className="size-4 text-ink-3" />
      <p className="min-w-[16rem] flex-1">
        <b className="font-semibold text-foreground">
          Don&apos;t take this page&apos;s word for it.
        </b>{' '}
        {text}
      </p>
      <CopyCommand command={command} className="w-auto min-w-[13.75rem]" />
    </div>
  );
}
