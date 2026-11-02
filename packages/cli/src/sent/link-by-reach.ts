// How a stage that holds only a text linked to a key (a key file named, the environment printed, a folder or a
// pattern that takes the file in) came to be placed: as a send of the key, or as a maybe linked to it.
import { linkedPlace, type Place, type Via } from './place.js';
import type { Reach } from './shell-read.js';

/**
 * How a text that is not a key's value links a stage to the key: a key file named, the environment
 * printed, a folder or a pattern that takes the file in. A stage that makes a request is a send of the key
 * only if the text reached it as data (`proof`): `named` is the stage naming it in its own words or being
 * piped what a stage that names it printed, `piped` is only the second (a printer that also sends is not
 * the data it sends), `none` is never (a folder or a pattern names no file). Any other request is the
 * key's maybe, linked by `via`.
 */
export interface Link {
  readonly via: Via;
  readonly proof: 'named' | 'piped' | 'none';
  /**
   * For `piped`: whether a stage's own words embed the printer (`curl -d "$(env)"`, `--data @<(printenv)`),
   * so that what it printed is the request's own data though no stage before it printed it.
   */
  readonly embeds?: (stageText: string) => boolean;
  /**
   * For `folder`: whether every word of a stage that names the folder stands where its program takes a string
   * (`gh pr list svc`), so that nothing of the folder goes.
   */
  readonly strings?: (stageText: string) => boolean;
}

/** A place a stage gave, as a maybe unless the link is the proof of a send. */
export function linkedByReach(
  place: Place | null,
  reach: Reach,
  link: Link | undefined,
): Place | null {
  if (place === null || link === undefined || place.tier !== 'third_party') return place;
  const flows =
    link.proof === 'named'
      ? reach.piped || (reach.direct && link.strings?.(reach.stage.text) !== true)
      : link.proof === 'piped' &&
        ((reach.piped && !reach.direct) ||
          (reach.direct && link.embeds?.(reach.stage.text) === true));
  if (flows) return place;
  // Reached only because an earlier step held the text: it is no more than that.
  return linkedPlace(place, reach.direct || reach.piped ? link.via : 'earlier-step');
}
