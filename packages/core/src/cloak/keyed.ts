/**
 * Cloaking a value because of the FIELD it arrived in.
 *
 * An MCP result is JSON, and the cloak already walks its parsed string leaves. The
 * enclosing key was in hand the whole time and thrown away before the detector saw
 * it — so `{"first_name":"Peter Parker"}` would have needed a model to guess at what
 * the server had already labelled.
 *
 * A key is schema. It is a stronger claim than NER can make about the same
 * characters, it costs no dependency, and it holds for names a model trained on
 * English prose has never seen, which is most of them. What it does not do is a name
 * in prose — `{"text":"call Peter about the invoice"}` — and that remains the gap an
 * NER pass would be for.
 *
 * The whole design rests on the key list being UNAMBIGUOUS, so the lists below are
 * short on purpose. A false positive here is not a privacy failure but it is a real
 * cost: the model reads `[STROQ_NAME_1]` where it needed a filename, and the agent
 * does worse work for nobody's benefit. Every exclusion below is written down with
 * its reason rather than left to be rediscovered.
 */
import type { CloakSpan } from './types.js';

/** `first_name`, `firstName`, `First-Name` and `FIRSTNAME` are one key. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Keys whose value is a person.
 *
 * `name` is deliberately absent, and it is the one everybody reaches for first: a
 * bare `name` is a filename, a repository, a branch, a product or a channel at least
 * as often as it is a person, and cloaking those replaces something the agent needs.
 * `username`, `login` and `handle` are absent for a different reason — they are
 * identifiers the server itself looks up, so a placeholder in one breaks the call
 * rather than protecting the person behind it.
 */
export const PERSON_KEYS: ReadonlySet<string> = new Set([
  'firstname',
  'lastname',
  'fullname',
  'middlename',
  'givenname',
  'familyname',
  'surname',
  'displayname',
  'legalname',
  'personname',
  'contactname',
  'customername',
  'clientname',
  'employeename',
  'patientname',
  'authorname',
  'ownername',
  'recipientname',
  'sendername',
  'attendee',
  'attendees',
  'attendeename',
]);

/**
 * Keys whose value is a street address.
 *
 * `address` on its own is absent: it is an IP address, an email address or a wallet
 * address at least as often as a postal one. `city`, `country` and `postcode` are
 * absent too — they identify nobody on their own and the agent frequently needs
 * them, so cloaking them costs utility for no privacy.
 */
export const PLACE_KEYS: ReadonlySet<string> = new Set([
  'streetaddress',
  'street',
  'addressline1',
  'addressline2',
  'address1',
  'address2',
  'homeaddress',
  'billingaddress',
  'shippingaddress',
  'mailingaddress',
  'postaladdress',
  'deliveryaddress',
]);

/**
 * Ceilings past which the value is not what its key says it is.
 *
 * A 4,000-character `surname` is prose that landed in the wrong field, and a
 * whole-leaf span there blanks a paragraph the agent needed. The limits are generous
 * — long enough for any real name or address — because the point is to reject the
 * obviously-wrong, not to police length.
 */
const MAX_NAME_CHARS = 200;
const MAX_ADDRESS_CHARS = 500;

/**
 * The span for one string leaf, given every key it was seen under.
 *
 * The whole leaf or nothing: the field IS the value, so there is no offset to find
 * inside it, and claiming a substring of a labelled field would leave the rest of a
 * name in place. Person wins over address when a leaf somehow qualifies as both,
 * because a person is the more sensitive claim.
 */
export function detectKeyedFields(text: string, keys: ReadonlySet<string>): readonly CloakSpan[] {
  if (text.trim() === '') return [];
  let kind: 'name' | 'address' | null = null;
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (PERSON_KEYS.has(normalized)) {
      kind = 'name';
      break;
    }
    if (PLACE_KEYS.has(normalized)) kind = 'address';
  }
  if (kind === null) return [];
  if (text.length > (kind === 'name' ? MAX_NAME_CHARS : MAX_ADDRESS_CHARS)) return [];
  /* Restorable, unlike a secret: the model is meant to act on a placeholder and the
     server is meant to receive the real value back. That is the whole point of the
     cloak for a name — a calendar invite still reaches the right person. */
  return [{ kind, start: 0, end: text.length, value: text, restorable: true }];
}
