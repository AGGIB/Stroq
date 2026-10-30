import { cva, type VariantProps } from 'class-variance-authority';
import { STATUS, type Glyph, type StatusKind } from '@/lib/status';
import { cn } from '@/lib/utils';

// The one status signal in the console. Shape and glyph carry the meaning with the colour.

const square = cva('inline-grid shrink-0 place-items-center', {
  variants: {
    tone: {
      red: 'bg-st-red text-st-on',
      green: 'bg-st-green text-st-on',
      amber: 'bg-st-amber text-st-on',
      'amber-outline': 'text-st-amber-ink shadow-[inset_0_0_0_1.5px_var(--st-amber)]',
      grey: 'bg-st-grey text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline-strong)]',
    },
    size: {
      sm: 'size-4 rounded-[4px] [&_svg]:size-2.5',
      md: 'size-5 rounded-[5px] [&_svg]:size-3',
      lg: 'size-8 rounded-lg [&_svg]:size-[17px]',
    },
  },
  defaultVariants: { size: 'md' },
});

const PATHS: Readonly<Record<Glyph, readonly string[]>> = {
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  question: ['M8.5 8.5a3.5 3.5 0 0 1 6.8 1.2c0 2.3-3.3 3-3.3 4.8', 'M12 19h.01'],
  exclaim: ['M12 5v9', 'M12 19h.01'],
  flag: ['M6 21V4', 'M6 4h11l-2.5 4.5L17 13H6'],
  eye: [
    'M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0',
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  ],
  minus: ['M6 12h12'],
  send: ['M7 7h10v10', 'M7 17 17 7'],
};

interface StatusSquareProps extends Pick<VariantProps<typeof square>, 'size'> {
  readonly kind: StatusKind;
  /** Set when the words are already visible next to the square. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function StatusSquare({ kind, size, decorative = false, className }: StatusSquareProps) {
  const { glyph, tone, label } = STATUS[kind];
  const a11y = decorative
    ? { 'aria-hidden': true }
    : { role: 'img', 'aria-label': label, title: label };
  return (
    <span className={cn(square({ tone, size }), className)} {...a11y}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {PATHS[glyph].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
}
