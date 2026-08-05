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

  try {
    // Reads the [[DateValue]] slot: throws for anything that merely inherits
    // from Date.prototype, succeeds for a real Date from any realm.
    Date.prototype.valueOf.call(value);

    return true;
  } catch {
    return false;
  }
};
