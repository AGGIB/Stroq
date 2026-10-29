'use client';

import { animate } from 'motion/react';
import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

// Magic UI NumberTicker, adapted for Stroq:
// - the markup always holds the final number, so first paint, no-JS and screen readers are right;
// - one short ease-out (280 ms) instead of a slow spring, and the width of the final number is
//   reserved, so nothing around it shifts while it counts;
// - people who asked for less motion see the final number at once;
// - with `playOnceKey` it rolls only the first time in a browser session.

interface NumberTickerProps extends ComponentPropsWithoutRef<'span'> {
  value: number;
  startValue?: number;
  delay?: number;
  decimalPlaces?: number;
  playOnceKey?: string;
}

const DURATION_S = 0.28;
const EASE = [0.23, 1, 0.32, 1] as const;

function format(n: number, decimalPlaces: number): string {
  return Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(Number(n.toFixed(decimalPlaces)));
}

function wasPlayed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function markPlayed(key: string): void {
  try {
    window.sessionStorage.setItem(key, '1');
  } catch {
    // Storage is blocked: the numbers will roll again next time, which is harmless.
  }
}

export function NumberTicker({
  value,
  startValue = 0,
  delay = 0,
  className,
  decimalPlaces = 0,
  playOnceKey,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = format(value, decimalPlaces);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || (playOnceKey !== undefined && wasPlayed(playOnceKey))) return;

    node.textContent = format(startValue, decimalPlaces);
    const controls = animate(startValue, value, {
      duration: DURATION_S,
      delay,
      ease: EASE,
      onUpdate: (latest) => {
        node.textContent = format(latest, decimalPlaces);
      },
      onComplete: () => {
        node.textContent = final;
        if (playOnceKey !== undefined) markPlayed(playOnceKey);
      },
    });
    return () => {
      controls.stop();
      node.textContent = final;
    };
  }, [value, startValue, delay, decimalPlaces, playOnceKey, final]);

  return (
    <span className={cn('inline-grid tabular-nums', className)} {...props}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {final}
      </span>
      <span ref={ref} aria-hidden="true" className="col-start-1 row-start-1">
        {final}
      </span>
      <span className="sr-only">{final}</span>
    </span>
  );
}
