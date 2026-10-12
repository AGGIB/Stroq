// Reading JSON that somebody else wrote, without trusting its shape.
//
// A manifest is whatever its author made it: an array where an object belongs, a number where a string
// does, a key called `__proto__`. Everything here reads only a key the object has itself, and answers
// with `undefined` or null for anything of the wrong kind, so an inspector can ask for what it wants
// and never has to ask whether it is safe to.
export type JsonObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object in `text`, or null if it is not JSON or not an object. */
export function parseJsonObject(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    // Any failure is the same answer: the text is not a manifest that can be read.
    return null;
  }
}

/** A key the object has itself; a name inherited from the prototype is not a key of an author's manifest. */
export function own(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export const ownString = (object: JsonObject, key: string): string | null => {
  const value = own(object, key);
  return typeof value === 'string' ? value : null;
};

export const ownObject = (object: JsonObject, key: string): JsonObject | null => {
  const value = own(object, key);
  return isObject(value) ? value : null;
};

/** The entries of an object, as `[key, value]`, in the order of the keys' text so that the order of a file does not matter. */
export function entriesOf(object: JsonObject): [string, unknown][] {
  return Object.keys(object)
    .sort()
    .map((key) => [key, object[key]]);
}
