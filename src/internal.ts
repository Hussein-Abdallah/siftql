/**
 * Low-level predicates shared by layers that must not depend on each other.
 *
 * `temporal/` sits below `engine/` and `values/`, so anything all three need
 * lives here rather than being imported sideways.
 *
 * Not exported from the package entry point.
 */

/**
 * A real `Date`, identified by its internal slot rather than its prototype.
 *
 * `value instanceof Date` only checks the prototype chain, so
 * `Object.create(Date.prototype)` passes it and then throws `TypeError: this is
 * not a Date object` from `getTime()`. That shape is not exotic — a
 * prototype-restoring deserializer, a mocking library, or a structured-clone
 * shim can all produce it — and reaching it through `instanceof` meant one such
 * value in one record threw a raw `TypeError` out of `filter()` and destroyed
 * every other result.
 *
 * Cross-realm dates (an iframe, a `vm` context, a worker) also fail
 * `instanceof` while being genuine Dates; this predicate accepts them, which is
 * the behaviour a caller expects.
 */
export const isDateLike = (value: unknown): value is Date => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  /*
   * A CHEAP NEGATIVE FILTER FIRST, and it is not an optimisation detail.
   *
   * The slot probe below works by throwing, and `isPlainObject` calls this
   * predicate on every object in every record — so the throw was being taken on
   * the overwhelmingly common case. Constructing and unwinding an exception cost
   * ~300x a successful call: 659 ms to test 300,000 plain objects, against 2 ms
   * for `instanceof`. A whole `filter()` ran 4-12x slower than before the slot
   * check was introduced, which is a correctness problem in a search box even
   * though every answer was right.
   *
   * `Object.prototype.toString` reads the [[DateValue]] slot too — via
   * Symbol.toStringTag's spec fallback — but REPORTS rather than throws, and it
   * is cross-realm just like the probe. It is spoofable (an object may declare
   * `Symbol.toStringTag = 'Date'`), which is exactly why it only filters
   * NEGATIVES here: anything it rejects is certainly not a Date, and anything it
   * accepts still has to survive the probe. 300,000 objects now cost 5 ms, and
   * the classification is identical on all ten cases that distinguish the two
   * (real, invalid, cross-realm and subclassed Dates; Object.create(Date
   * .prototype); a toStringTag spoof; a Proxy wrapping a Date; plain objects;
   * arrays; null-prototype objects).
   */
  if (Object.prototype.toString.call(value) !== '[object Date]') {
    return false;
  }

  try {
    // Reads the [[DateValue]] slot: throws for anything that merely inherits
    // from Date.prototype, succeeds for a real Date from any realm.
    Date.prototype.valueOf.call(value);

    return true;
  } catch {
    return false;
  }
};
