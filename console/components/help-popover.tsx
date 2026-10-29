import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { STATUS, type StatusKind } from '@/lib/status';
import { StatusSquare } from './status-square';

interface HelpPopoverProps {
  readonly label: string;
  readonly items: ReadonlyArray<readonly [StatusKind, string]>;
}

/** What each square means, one click away instead of printed on every page. */
export function HelpPopover({ label, items }: HelpPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-6 rounded-full text-ink-3 hover:text-foreground"
        >
          <Info aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        aria-label={label}
        className="w-[22rem] max-w-[calc(100vw-1rem)] p-3.5 text-[13px] leading-[18px] text-ink-2"
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2.5">
          {items.map(([kind, text]) => (
            <div key={kind} className="contents">
              <dt className="flex items-center gap-2 whitespace-nowrap font-semibold text-foreground">
                <StatusSquare kind={kind} decorative />
                {STATUS[kind].label}
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
