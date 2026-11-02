import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardData } from '../../src/card/data.js';
import { renderCard } from '../../src/card/render.js';
import { renderShow } from '../../src/card/show.js';
import { readLastCard, writeLastCard } from '../../src/card/store.js';
import type { Machine } from './machine.js';

/**
 * Everything a run of the card prints or keeps: the card, its JSON, `stroq show` for every moment, and
 * every file under the Stroq home. One text to look for a value in.
 */
export function everythingOf(m: Machine, data: CardData): string {
  writeLastCard(
    m.stroqHome,
    { version: data.version, generated: data.generated, days: data.days },
    data.moments,
  );
  const read = readLastCard(m.stroqHome);
  const shown =
    read.kind === 'card' ? read.card.moments.flatMap((x) => renderShow(read.card, x)) : [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }))
      e.isDirectory() ? walk(join(dir, e.name)) : files.push(join(dir, e.name));
  };
  walk(m.stroqHome);
  return [
    JSON.stringify(data),
    renderCard(data, m.home).join('\n'),
    shown.join('\n'),
    ...files.map((f) => readFileSync(f, 'utf8')),
  ].join('\n');
}
