/**
 * Reading candidate values out of a record.
 *
 * Two access patterns, and they are genuinely different operations:
 *
 * - FIELDED (`name.first:foo`) walks a known path. Arrays along the way are
 *   flattened, so `tags:red` matches `{ tags: ['red', 'blue'] }` — a field
 *   holding a list matches if ANY element does, which is what every search UI
 *   means and what Lucene does with a multi-valued field.
 * - UNFIELDED (`foo`) sweeps every leaf in the record.
 *
 * Both yield `[path, value]` pairs so a highlight can name exactly where it hit.
 */

export type Candidate = readonly [
  path: readonly (string | number)[],
  value: unknown,
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

/**
 * Walk `path` from `item`, flattening arrays encountered on the way.
 *
 * A missing key yields `undefined` exactly once, so `member:null` can match a
 * record where the key is simply absent — "unset" and "explicitly null" are the
 * same answer to "is this empty?".
 */
export const valuesAtPath = (
  item: unknown,
  path: readonly string[],
): Candidate[] => {
  let frontier: Candidate[] = [[[], item]];

  for (const key of path) {
    const next: Candidate[] = [];

    for (const [prefix, value] of frontier) {
      // Flatten one array level before descending, so tags.0.name and tags.name
      // both reach the same leaves.
      const holders: Candidate[] = Array.isArray(value)
        ? value.map((element, index) => [[...prefix, index], element] as const)
        : [[prefix, value]];

      for (const [holderPath, holder] of holders) {
        if (isPlainObject(holder) && key in holder) {
          next.push([[...holderPath, key], holder[key]]);
        } else if (isPlainObject(holder)) {
          // Absent key: still a candidate, so `null` can match it.
          next.push([[...holderPath, key], undefined]);
        }
      }
    }

    frontier = next;
  }

  // Flatten a terminal array so `tags:red` sees each element.
  return frontier.flatMap(([path_, value]) =>
    Array.isArray(value)
      ? value.map((element, index) => [[...path_, index], element] as Candidate)
      : [[path_, value] as Candidate],
  );
};

/**
 * Every leaf in the record, for an unfielded term.
 *
 * With `matchKeys`, object keys are emitted as candidates too, which is what
 * lets a bare term find a record by the NAME of a field rather than its value.
 */
export const allLeafValues = (
  item: unknown,
  matchKeys: boolean,
): Candidate[] => {
  const found: Candidate[] = [];

  const walk = (value: unknown, path: readonly (string | number)[]): void => {
    if (Array.isArray(value)) {
      for (const [index, element] of value.entries()) {
        walk(element, [...path, index]);
      }

      return;
    }

    if (isPlainObject(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (matchKeys) {
          found.push([[...path, key], key]);
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
