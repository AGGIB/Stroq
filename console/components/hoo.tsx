import { owlSrc, type OwlFrame } from '@/lib/card';

/**
 * Hoo, the Stroq owl, as the terminal's card draws it: `pnpm owl:svg` writes these pictures from
 * the same grid and palette (`packages/cli/src/ui/mascot/sprites.ts`), so the console never holds a
 * copy of its own. The picture does not move, and it never carries the meaning: the words beside it
 * say the same thing, so it is hidden from a screen reader.
 */
export function Hoo({ frame, size = 96 }: { frame: OwlFrame; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="hoo" src={owlSrc(frame)} alt="" width={size} height={size} aria-hidden="true" />
  );
}
