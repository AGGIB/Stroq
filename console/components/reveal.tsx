import type { CSSProperties, ReactNode } from 'react';

/**
 * Sections arrive 40 ms apart, in 240 ms, once. It is a CSS animation on transform and opacity, so
 * it plays before any script has loaded, leaves no styles behind and is switched off for people who
 * asked for less motion (see globals.css).
 */
export function Reveal({
  index,
  children,
}: {
  readonly index: number;
  readonly children: ReactNode;
}) {
  return (
    <div className="reveal" style={{ '--i': index } as CSSProperties}>
      {children}
    </div>
  );
}
