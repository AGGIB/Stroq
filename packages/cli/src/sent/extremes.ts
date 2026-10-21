// The smallest and the largest of a measure over a list, found by a loop.
//
// `Math.min(...list)` passes every item as one argument, and a call takes only so many: a
// machine can hold more key spellings than that, and the spread throws a RangeError. These walk
// the list instead, so their cost is the list's length and nothing else.

/** The smallest `measure` of `items`, and at most `ceiling`, which is also what no items give. */
export function smallest<T>(
  items: Iterable<T>,
  measure: (item: T) => number,
  ceiling: number,
): number {
  let low = ceiling;
  for (const item of items) {
    const value = measure(item);
    if (value < low) low = value;
  }
  return low;
}

/** The largest `measure` of `items`, and at least `floor`, which is also what no items give. */
export function largest<T>(
  items: Iterable<T>,
  measure: (item: T) => number,
  floor: number,
): number {
  let high = floor;
  for (const item of items) {
    const value = measure(item);
    if (value > high) high = value;
  }
  return high;
}
