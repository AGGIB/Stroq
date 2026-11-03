// Which owl the card shows. A module of its own, with nothing from the terminal in it, so that the
// console reads the same rule the terminal does.
import type { FrameName } from '../ui/mascot/sprites.js';
import type { CardData } from './data.js';

/** What the owl says about the result: found something, found nothing, or had nothing to read. */
export function owlFrame(data: CardData): FrameName {
  if (data.coverage.found === 0) return 'idle';
  return data.moments.length > 0 ? 'alert' : 'happy';
}
