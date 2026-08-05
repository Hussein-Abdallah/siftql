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
 * THREE HAZARDS THAT ARE NOT HYPOTHETICAL, since `filter()` takes whatever the
 * host application has:
 *
 *  - DEPTH. Both walks are ITERATIVE, with an explicit stack. Recursion here
 *    meant an 18 KB record of plain nested JSON threw a raw `RangeError` that
 *    destroyed the whole result set — a stack limit is not a property of the
 *    data, so it must not be a property of the answer.
 *  - CYCLES AND ALIASES. Each walk tracks the ANCESTORS of the node it is
 *    visiting, not everything it has ever seen. The distinction is the whole
 *    point: a global visited-set also skips aliases, and the same object
 *    referenced from two different places is not a cycle — dropping the second
 *    reference loses real leaves. No tracking at all let `{a: [self, self]}`
 *    double the frontier per path segment; sixteen segments was 65,536
 *    candidates.
 *
 *    Both walks are LINEAR in the size of the record, which took two attempts.
 *    The obvious way to make the ancestor set per-branch is to copy it on
 *    descent, and that is O(depth) per node — so a 60,000-level record went from
 *    a crash to a thirty-second hang, which is not an improvement.
 *    {@link allLeafValues} therefore keeps one mutable set with explicit exit
 *    markers, and builds paths as a linked list materialised only for values it
 *    actually emits. {@link valuesAtPath} still copies, because there the set is
 *    bounded by the number of segments in the QUERY (`a.b.c` is three) rather
 *    than by the depth of the data.
 *  - HOSTILE ACCESSORS. Every property read goes through {@link safeRead},
 *    because a getter or a Proxy trap may throw. That is dirty DATA, so it is
 *    reported as a failed candidate and dispositioned by `onValueError` like any
 *    other unreadable value — never allowed to abort the run.
 */

import { isDateLike } from '../internal.js';

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
  /**
   * Set when reading this value THREW — a getter or a Proxy trap. The candidate
   * is still reported so the engine can route it through the failure policy
   * rather than losing the whole record.
   */
  readError?: unknown,
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !isDateLike(value);

/** Own properties only — `key in holder` would walk the prototype chain. */
const hasOwn = (holder: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(holder, key);

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

type ReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** Read one property, surviving a throwing getter or Proxy trap. */
const safeRead = (holder: object, key: PropertyKey): ReadResult => {
  try {
    return { ok: true, value: (holder as Record<PropertyKey, unknown>)[key] };
  } catch (error) {
    return { error, ok: false };
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

/** Array length, surviving a lying or throwing accessor. */
const safeLength = (value: readonly unknown[]): number => {
  const read = safeRead(value, 'length');

  return read.ok && typeof read.value === 'number' && read.value >= 0
    ? Math.min(read.value, value.length)
    : 0;
};

/** One branch of a walk, carrying the ancestors seen along THAT branch. */
interface Step {
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly seen: ReadonlySet<object>;
  /** Set when reading this value threw; carried through to the Candidate. */
  readonly readError?: unknown;
}

const descend = (step: Step, value: unknown): ReadonlySet<object> => {
  if (typeof value !== 'object' || value === null) {
    return step.seen;
  }

  const next = new Set(step.seen);

  next.add(value);

  return next;
};

/** A walk step becomes a candidate, carrying any read failure with it. */
const asCandidate = (step: Step): Candidate =>
  'readError' in step
    ? [step.path, step.value, false, step.readError]
    : [step.path, step.value];

/** Expand one array level, skipping holes and surviving hostile accessors. */
const explode = (step: Step): Step[] => {
  const array = step.value as readonly unknown[];
  const length = safeLength(array);
  const steps: Step[] = [];

  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(array, String(index))) {
      // A hole. `Array.prototype.entries()` yields `[i, undefined]` for these
      // rather than skipping them, so the check is explicit.
      continue;
    }

    const read = safeRead(array, index);

    steps.push({
      path: [...step.path, index],
      seen: step.seen,
      value: read.ok ? read.value : undefined,
      ...(read.ok ? {} : { readError: read.error }),
    });
  }

  return steps;
};

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
  let frontier: Step[] = [{ path: [], seen: new Set(), value: item }];

  for (const key of path) {
    const next: Step[] = [];
    const index = asIndex(key);

    for (const step of frontier) {
      const { value } = step;

      // A numeric segment INDEXES an array rather than flattening it, so
      // `tags.0` names one element.
      if (index !== null && Array.isArray(value)) {
        if (index < safeLength(value) && hasOwn(value, key)) {
          const read = safeRead(value, index);

          next.push({
            path: [...step.path, index],
            seen: descend(step, value),
            value: read.ok ? read.value : undefined,
            ...(read.ok ? {} : { readError: read.error }),
          });
        }

        continue;
      }

      const holders: Step[] = Array.isArray(value) ? explode(step) : [step];

      for (const holder of holders) {
        if (!isPlainObject(holder.value)) {
          continue;
        }

        // Refuse to re-enter an object already on this branch. Without it a
        // self-referential array doubles the frontier per segment.
        if (holder.seen.has(holder.value)) {
          continue;
        }

        const read = hasOwn(holder.value, key)
          ? safeRead(holder.value, key)
          : ({ ok: true, value: undefined } as ReadResult);

        next.push({
          path: [...holder.path, key],
          seen: descend(holder, holder.value),
          value: read.ok ? read.value : undefined,
          ...(read.ok ? {} : { readError: read.error }),
        });
      }
    }

    frontier = next;
  }

  // Flatten a terminal array so `tags:red` sees each element.
  return frontier.flatMap((step): Candidate[] =>
    Array.isArray(step.value)
      ? explode(step).map((leaf) => asCandidate(leaf))
      : [asCandidate(step)],
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

  /*
   * Two things here are chosen to keep the walk LINEAR in the size of the
   * record, because the first version of this fix was linear in neither and a
   * 60,000-level record took thirty seconds — a crash traded for a hang, which
   * is no better.
   *
   * 1. ONE mutable ancestor set with explicit exit markers, rather than a fresh
   *    copy per branch. Copying gave the right per-branch answer at O(depth) per
   *    node, so O(depth^2) overall. The set holds exactly the ancestors of the
   *    node being visited: an object is added when entered and removed when its
   *    subtree is finished, which is the same "is it on MY branch" question a
   *    copy answered, at O(1).
   *
   * 2. Paths as a LINKED LIST, materialised only for values actually emitted.
   *    `[...path, key]` per node is also O(depth) per node; a deep record has
   *    one leaf at the bottom and no need for the 59,999 intermediate arrays.
   */
  interface Trail {
    readonly parent: Trail | null;
    readonly key: string | number;
  }

  const materialise = (trail: Trail | null): (string | number)[] => {
    const segments: (string | number)[] = [];

    for (let node = trail; node !== null; node = node.parent) {
      segments.push(node.key);
    }

    return segments.reverse();
  };

  type Frame =
    | {
        readonly kind: 'visit';
        readonly trail: Trail | null;
        readonly value: unknown;
        readonly readError?: unknown;
      }
    | { readonly kind: 'leave'; readonly value: object };

  const stack: Frame[] = [{ kind: 'visit', trail: null, value: item }];
  const ancestors = new Set<object>();

  while (stack.length > 0) {
    const frame = stack.pop();

    if (!frame) {
      break;
    }

    if (frame.kind === 'leave') {
      ancestors.delete(frame.value);
      continue;
    }

    const { trail, value } = frame;

    if (Array.isArray(value) || isPlainObject(value)) {
      // A cycle: this object is an ancestor of itself. Stop, rather than walk
      // forever. An object reachable by two SEPARATE paths is not a cycle and is
      // still visited both times, because both are real places it lives.
      if (ancestors.has(value)) {
        continue;
      }

      ancestors.add(value);
      // Popped only after everything below it, which is what makes the set hold
      // ancestors rather than everything already seen.
      stack.push({ kind: 'leave', value });

      const keys = Array.isArray(value)
        ? Array.from({ length: safeLength(value) }, (_, index) => index).filter(
            // A hole. Array.prototype.entries() yields [i, undefined] for these
            // rather than skipping them, so the check is explicit.
            (index) => hasOwn(value, String(index)),
          )
        : safeKeys(value);

      // Reversed so the stack yields children in source order.
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];

        if (key === undefined) {
          continue;
        }

        const read = safeRead(value, key);

        stack.push({
          kind: 'visit',
          trail: { key, parent: trail },
          value: read.ok ? read.value : undefined,
          ...(read.ok ? {} : { readError: read.error }),
        });
      }

      if (matchKeys && !Array.isArray(value)) {
        for (const key of keys) {
          found.push([[...materialise(trail), key], key, true]);
        }
      }

      continue;
    }

    found.push(
      'readError' in frame
        ? [materialise(trail), value, false, frame.readError]
        : [materialise(trail), value],
    );
  }

  return found;
};

/** Dotted display form. Lossy when a key contains a dot; `segments` is exact. */
export const formatPath = (segments: readonly (string | number)[]): string =>
  segments.join('.');
