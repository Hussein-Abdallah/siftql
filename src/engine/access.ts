/**
 * Reading candidate values out of a record.
 *
 * Two access patterns, and they are genuinely different operations:
 *
 * - FIELDED (`name.first:foo`) walks a known path. Arrays along the way are
 *   flattened, so `tags:red` matches `{ tags: ['red', 'blue'] }` — a field
 *   holding a list matches if ANY element does, which is what every search UI
 *   means and what Lucene does with a multi-valued field. A NUMERIC segment
 *   indexes instead of flattening, so `tags.0:red` addresses one element.
 * - UNFIELDED (`foo`) sweeps every leaf in the record.
 *
 * Both yield `[path, value]` pairs so a highlight can name exactly where it hit,
 * and both are hardened against data they did not expect: hostile input is the
 * norm here, since `filter()` takes whatever the host application has.
 */

export type Candidate = readonly [
  path: readonly (string | number)[],
  value: unknown,
  /**
   * True when this candidate is an object KEY rather than the value stored at
   * `path` (`matchKeys`). It has to travel with the candidate: a value type is
   * told through `ValueContext.isKey`, and a key hit has no textual footprint
   * inside the value, so it must not be reported with a pattern that cannot
   * match what lives there.
   */
  isKey?: boolean,
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

/**
 * Own properties only.
 *
 * `key in holder` walks the prototype chain, which makes every object appear to
 * have `constructor`, `toString`, `valueOf` and `hasOwnProperty` — so
 * `constructor:null` would report the wrong rows, and a class instance would
 * appear to carry all of its methods as fields.
 */
const hasOwn = (holder: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(holder, key);

/** An array index written as a path segment: `tags.0`, but not `tags.01`. */
const asIndex = (key: string): number | null => {
  if (!/^\d+$/u.test(key)) {
    return null;
  }

  const index = Number(key);

  return Number.isSafeInteger(index) ? index : null;
};

/**
 * Expand one array level into its elements.
 *
 * `Array.prototype.map` preserves holes, so a sparse array yields a sparse
 * result whose holes are `undefined` when iterated — and destructuring one
 * throws. Entries are used instead, which skips holes entirely.
 */
const explode = (
  path: readonly (string | number)[],
  value: readonly unknown[],
): Candidate[] =>
  [...value.entries()].map(
    ([index, element]) => [[...path, index], element] as Candidate,
  );

/**
 * Walk `path` from `item`.
 *
 * A missing key still yields `undefined` exactly once, so `member:null` matches
 * a record where the key is simply absent — "unset" and "explicitly null" are
 * the same answer to "is this empty?".
 */
export const valuesAtPath = (
  item: unknown,
  path: readonly string[],
): Candidate[] => {
  let frontier: Candidate[] = [[[], item]];

  for (const key of path) {
    const next: Candidate[] = [];
    const index = asIndex(key);

    for (const [prefix, value] of frontier) {
      // A numeric segment INDEXES an array rather than flattening it, so
      // `tags.0` names one element. Without this the segment is matched against
      // each element as a key and nothing is ever found.
      if (index !== null && Array.isArray(value)) {
        if (index < value.length) {
          next.push([[...prefix, index], value[index]]);
        }

        continue;
      }

      const holders: Candidate[] = Array.isArray(value)
        ? explode(prefix, value)
        : [[prefix, value]];

      for (const [holderPath, holder] of holders) {
        if (isPlainObject(holder)) {
          next.push([
            [...holderPath, key],
            hasOwn(holder, key) ? holder[key] : undefined,
          ]);
        }
      }
    }

    frontier = next;
  }

  // Flatten a terminal array so `tags:red` sees each element.
  return frontier.flatMap(([leafPath, value]) =>
    Array.isArray(value)
      ? explode(leafPath, value)
      : [[leafPath, value] as Candidate],
  );
};

/**
 * Every leaf in the record, for an unfielded term.
 *
 * With `matchKeys`, object keys are emitted as candidates too, which is what
 * lets a bare term find a record by the NAME of a field rather than its value.
 *
 * Cycles are tracked and skipped. A record referencing itself is ordinary in
 * application data (a parent pointer, a graph node), and recursing into one
 * used to overflow the stack and abort the entire filter rather than skipping
 * a single row.
 */
export const allLeafValues = (
  item: unknown,
  matchKeys: boolean,
): Candidate[] => {
  const found: Candidate[] = [];
  const seen = new Set<object>();

  const walk = (value: unknown, path: readonly (string | number)[]): void => {
    if (Array.isArray(value) || isPlainObject(value)) {
      if (seen.has(value)) {
        return;
      }

      seen.add(value);
    }

    if (Array.isArray(value)) {
      for (const [index, element] of value.entries()) {
        walk(element, [...path, index]);
      }

      return;
    }

    if (isPlainObject(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (matchKeys) {
          found.push([[...path, key], key, true]);
        }

        walk(nested, [...path, key]);
      }

      return;
    }

    found.push([path, value]);
  };

  walk(item, []);

  return found;
};

/** Dotted display form. Lossy when a key contains a dot; `segments` is exact. */
export const formatPath = (segments: readonly (string | number)[]): string =>
  segments.join('.');
