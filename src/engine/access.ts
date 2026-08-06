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
 * Both yield `[path, value]` pairs so a highlight can name exactly where it hit.
 *
 * `filter()` takes whatever the host application has, so the hazards below are
 * not hypothetical. Each is a bug this module has actually shipped.
 *
 * DEPTH. Both walks are ITERATIVE, with an explicit stack. Recursion meant an
 * 18 KB record of plain nested JSON threw a raw `RangeError` that destroyed the
 * whole result set — a stack limit is not a property of the data, so it must not
 * be a property of the answer.
 *
 * SHARED REFERENCES, which is where two earlier attempts went wrong and is worth
 * spelling out. An object can be reachable by more than one path — a parent
 * pointer, an ORM back-reference, the same tag list on two fields — and in the
 * worst case the number of PATHS is exponential in the number of OBJECTS:
 * `{a: v, b: v}` nested twenty deep is 21 objects and a million paths.
 *
 *  - Doing nothing made that a denial of service: 21 objects took 8.7 seconds,
 *    doubling per level.
 *  - Refusing to re-enter an object already on the current branch fixed the cost
 *    and BROKE THE ANSWER. A fielded walk cannot loop — it takes exactly one step
 *    per query segment — so on `children.0.parent.name` the guard fired on a
 *    perfectly finite path and returned `false` where the truth was `root`.
 *    Worse, an acyclic record of the same shape answered `true`, so the result
 *    depended on object identity rather than on the data.
 *
 * What is correct AND bounded is to visit each object ONCE, keeping the first
 * path that reaches it. Every distinct value is still found, so no match is ever
 * missed; what is given up is the *duplicate* paths to a value already reported.
 * A cycle is then handled by the same rule, with nothing special about it. The
 * visible consequence — a value reachable twice is highlighted at one path, not
 * both — is documented on {@link allLeafValues} and {@link valuesAtPath}.
 *
 * HOSTILE ACCESSORS. Every property read and every own-property test goes through
 * a guard, because a getter, a `getOwnPropertyDescriptor` trap or an `ownKeys`
 * trap may throw. That is dirty DATA, so it is reported as a failed candidate and
 * dispositioned by `onValueError` like any other unreadable value — never allowed
 * to abort the run. `length` is never trusted either: `new Array(6e8)` with one
 * real element used to be expanded to its declared length and killed the process
 * outright, so both walks enumerate OWN KEYS and never the declared range.
 */

import { isDateLike, safeIsArray } from '../internal.js';

/**
 * A path kept as a LINKED LIST, built as the walk descends.
 *
 * One node per step, shared with every descendant, so extending a path costs
 * O(1) instead of copying an array.
 */
export interface PathTrail {
  readonly parent: PathTrail | null;
  readonly key: string | number;
}

/**
 * A candidate's path, in whichever form was cheap to produce.
 *
 * The fielded walk takes one step per QUERY segment, so an array there is
 * already short and bounded. The unfielded walk descends as deep as the record
 * goes, so it carries a trail and only materialises on demand — see
 * {@link pathOf}.
 */
export type PathRef = readonly (string | number)[] | PathTrail | null;

/**
 * Turn a path reference into an array.
 *
 * CALLED ONLY WHERE A PATH IS ACTUALLY NEEDED, which is on a match or a failure
 * report — never once per candidate. Materialising eagerly made the unfielded
 * walk QUADRATIC in record depth: a chain-shaped record (threaded comments, a
 * linked list, an ORM parent chain) has a leaf at every level, so the paths
 * summed to n²/2 entries. 16,000 levels took two seconds and 32,000 exhausted
 * the heap, from a record under a megabyte. A flat record with the same leaf
 * count took 19 ms, which is the tell: the cost was never the leaves.
 */
export const pathOf = (ref: PathRef): readonly (string | number)[] => {
  if (ref === null) {
    return [];
  }

  if (safeIsArray(ref)) {
    return ref;
  }

  const segments: (string | number)[] = [];

  for (let node: PathTrail | null = ref; node !== null; node = node.parent) {
    segments.push(node.key);
  }

  return segments.reverse();
};

export type Candidate = readonly [
  path: PathRef,
  value: unknown,
  /**
   * True when this candidate is an object KEY rather than the value stored at
   * `path` (`matchKeys`). It has to travel with the candidate: a value type is
   * told through `ValueContext.isKey`, and a key hit has no textual footprint
   * inside the value, so it must not be reported with a pattern that cannot
   * match what lives there.
   */
  isKey?: boolean,
  /**
   * Set when reading this value THREW — a getter, or a Proxy trap. The candidate
   * is still reported so the engine can route it through the failure policy
   * rather than losing the whole record.
   */
  readError?: unknown,
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !safeIsArray(value) &&
  !isDateLike(value);

type ReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** Read one property, surviving a throwing getter or `get` trap. */
const safeRead = (holder: object, key: PropertyKey): ReadResult => {
  try {
    return { ok: true, value: (holder as Record<PropertyKey, unknown>)[key] };
  } catch (error) {
    return { error, ok: false };
  }
};

/**
 * Own properties only — `key in holder` would walk the prototype chain.
 *
 * Guarded, because `hasOwnProperty` invokes the `getOwnPropertyDescriptor` trap
 * on a Proxy and that trap may throw. Treating a failed interrogation as "not
 * present" is the safe direction: the key is skipped rather than read through a
 * mechanism that has already misbehaved once.
 */
const hasOwn = (holder: object, key: PropertyKey): boolean => {
  try {
    return Object.prototype.hasOwnProperty.call(holder, key);
  } catch {
    return false;
  }
};

/** List own enumerable string keys, surviving a hostile `ownKeys` trap. */
const safeKeys = (holder: object): string[] => {
  try {
    return Object.keys(holder);
  } catch {
    return [];
  }
};

/**
 * The indices an array actually HOLDS, in order.
 *
 * Never `length`. A sparse `new Array(600_000_000)` carrying one element
 * declares half a billion slots, and expanding that range — even lazily, via
 * `Array.from({ length })` — exhausted the heap and killed the process, from a
 * 200-byte record. `Object.keys` on the same array returns one key. A `length`
 * trap that lies is bounded by the same reasoning, since its answer is never
 * consulted.
 */
const ownIndices = (array: readonly unknown[]): number[] => {
  const indices: number[] = [];

  for (const key of safeKeys(array)) {
    const index = asIndex(key);

    if (index !== null) {
      indices.push(index);
    }
  }

  // Object.keys yields integer keys in ascending order already; sorting keeps
  // that true for an exotic object whose ownKeys trap does not.
  return indices.sort((left, right) => left - right);
};

/**
 * An array index written as a path segment: `tags.0`, but NOT `tags.01`.
 *
 * A leading zero is not a canonical index, and treating it as one shadows a
 * real object key: `{ '01': … }` is an ordinary property and must stay
 * reachable.
 */
const asIndex = (key: string): number | null => {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) {
    return null;
  }

  const index = Number(key);

  return Number.isSafeInteger(index) ? index : null;
};

/** One branch of a walk. `readError` is set when reading this value threw. */
interface Step {
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly readError?: unknown;
}

const asCandidate = (step: Step): Candidate =>
  'readError' in step
    ? [step.path, step.value, false, step.readError]
    : [step.path, step.value];

const stepFrom = (
  path: readonly (string | number)[],
  key: string | number,
  read: ReadResult,
): Step => ({
  path: [...path, key],
  value: read.ok ? read.value : undefined,
  ...(read.ok ? {} : { readError: read.error }),
});

/** Expand one array level into its own elements, skipping holes. */
const explode = (step: Step): Step[] =>
  ownIndices(step.value as readonly unknown[]).map((index) =>
    stepFrom(step.path, index, safeRead(step.value as object, index)),
  );

/**
 * Walk `path` from `item`.
 *
 * A missing key still yields `undefined` exactly once, so `member:null` matches
 * a record where the key is simply absent — "unset" and "explicitly null" are
 * the same answer to "is this empty?".
 *
 * When two segments of the frontier arrive at the SAME object, only the first is
 * carried forward; see the module header. The value is still found, at one path.
 */
export const valuesAtPath = (
  item: unknown,
  path: readonly string[],
): Candidate[] => {
  let frontier: Step[] = [{ path: [], value: item }];

  /*
   * A read that threw part-way ALONG the path, rather than at its end.
   *
   * These cannot stay in the frontier — there is no value to descend into — but
   * dropping them silently was its own defect: under `onValueError: 'throw'` a
   * throwing getter on an intermediate segment produced no match and no error, so
   * a caller who had explicitly asked to be told about dirty data was told
   * nothing. They are reported as failed candidates instead.
   */
  const failed: Candidate[] = [];

  for (const key of path) {
    const next: Step[] = [];
    const index = asIndex(key);
    // Visit each object once per segment: the alias-collapsing rule from the
    // module header, applied one level at a time.
    const visited = new Set<object>();

    const push = (step: Step): void => {
      if ('readError' in step) {
        failed.push(asCandidate(step));

        return;
      }

      if (typeof step.value === 'object' && step.value !== null) {
        if (visited.has(step.value)) {
          return;
        }

        visited.add(step.value);
      }

      next.push(step);
    };

    for (const step of frontier) {
      const { value } = step;

      // A numeric segment INDEXES an array rather than flattening it, so
      // `tags.0` names one element.
      if (index !== null && safeIsArray(value)) {
        if (hasOwn(value, String(index))) {
          push(stepFrom(step.path, index, safeRead(value, index)));
        }

        continue;
      }

      const holders: Step[] = safeIsArray(value) ? explode(step) : [step];

      for (const holder of holders) {
        if ('readError' in holder) {
          failed.push(asCandidate(holder));

          continue;
        }

        if (!isPlainObject(holder.value)) {
          continue;
        }

        push(
          stepFrom(
            holder.path,
            key,
            hasOwn(holder.value, key)
              ? safeRead(holder.value, key)
              : { ok: true, value: undefined },
          ),
        );
      }
    }

    frontier = next;
  }

  // Flatten a terminal array so `tags:red` sees each element.
  return [
    ...failed,
    ...frontier.flatMap((step): Candidate[] =>
      safeIsArray(step.value)
        ? explode(step).map((leaf) => asCandidate(leaf))
        : [asCandidate(step)],
    ),
  ];
};

/**
 * Every leaf in the record, for an unfielded term.
 *
 * With `matchKeys`, object keys are emitted as candidates too, which is what
 * lets a bare term find a record by the NAME of a field rather than its value.
 *
 * Each object is visited once, so a value reachable by several paths is reported
 * at the FIRST path that reaches it — see the module header for why that beats
 * both the alternatives.
 */
export const allLeafValues = (
  item: unknown,
  matchKeys: boolean,
): Candidate[] => {
  const found: Candidate[] = [];

  /*
   * Paths as a LINKED LIST, and NOT materialised here at all.
   *
   * Building `[...path, key]` per node is O(depth) per node and quadratic
   * overall; a 60,000-level record took thirty seconds. The trail fixed that for
   * a record with ONE leaf at the bottom — but a chain-shaped record has a leaf
   * at EVERY level, and materialising each one's path put the quadratic straight
   * back: 16,000 levels took two seconds, 32,000 exhausted the heap.
   *
   * So the trail travels with the candidate and `pathOf` builds the array only
   * where one is genuinely read, which is on a match or a failure — never once
   * per leaf.
   */
  interface Frame {
    readonly trail: PathTrail | null;
    readonly value: unknown;
    readonly readError?: unknown;
  }

  const stack: Frame[] = [{ trail: null, value: item }];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const frame = stack.pop();

    if (!frame) {
      break;
    }

    const { trail, value } = frame;
    const isContainer =
      !('readError' in frame) && (safeIsArray(value) || isPlainObject(value));

    if (isContainer) {
      const container = value as object;

      if (visited.has(container)) {
        continue;
      }

      visited.add(container);

      const keys: (string | number)[] = safeIsArray(container)
        ? ownIndices(container)
        : safeKeys(container);

      // Reversed so the stack yields children in source order.
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];

        if (key === undefined) {
          continue;
        }

        const read = safeRead(container, key);

        stack.push({
          trail: { key, parent: trail },
          value: read.ok ? read.value : undefined,
          ...(read.ok ? {} : { readError: read.error }),
        });
      }

      if (matchKeys && !safeIsArray(container)) {
        for (const key of keys) {
          found.push([{ key, parent: trail }, key, true]);
        }
      }

      continue;
    }

    found.push(
      'readError' in frame
        ? [trail, value, false, frame.readError]
        : [trail, value],
    );
  }

  return found;
};

/** Dotted display form. Lossy when a key contains a dot; `segments` is exact. */
export const formatPath = (segments: readonly (string | number)[]): string =>
  segments.join('.');
