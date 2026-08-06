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
    /*
     * A CHEAP NEGATIVE FILTER FIRST, INSIDE THE GUARD.
     *
     * The slot probe below works by throwing, and `isPlainObject` calls this
     * predicate on every object in every record — so the throw was being taken
     * on the overwhelmingly common case, at roughly 300x the cost of a
     * successful call. A whole `filter()` ran 4-12x slower.
     *
     * `Object.prototype.toString` reads the same [[DateValue]] slot and reports
     * instead of throwing, so it makes a good prefilter — but it is NOT
     * exception-free, which is how this line reopened the hole it was added
     * beside. It looks up `Symbol.toStringTag`, and on a Proxy that runs the
     * `get` trap; on a plain object it can run an accessor. Placed outside the
     * try, it sent a raw `Error` out of `test()` and `highlight()` while the
     * comment three lines above claimed every escape was a SiftQLError.
     *
     * Inside the guard it keeps the speed — a plain object still returns
     * '[object Object]' without the probe ever running — and an object that
     * fights back is simply not a Date, which is the correct answer.
     *
     * It is spoofable (`Symbol.toStringTag = 'Date'`), which is why it only
     * filters NEGATIVES: anything it rejects is certainly not a Date, and
     * anything it accepts still has to survive the probe.
     */
    if (Object.prototype.toString.call(value) !== '[object Date]') {
      return false;
    }

    // Reads the [[DateValue]] slot: throws for anything that merely inherits
    // from Date.prototype, succeeds for a real Date from any realm.
    Date.prototype.valueOf.call(value);

    return true;
  } catch {
    return false;
  }
};

/**
 * `Array.isArray`, surviving a revoked Proxy.
 *
 * `Array.isArray` is documented as never throwing, and for every ordinary value
 * that is true — but on a revoked Proxy it raises
 * `TypeError: Cannot perform 'IsArray' on a revoked proxy`. A revoked Proxy is
 * an ordinary thing to find in a record whose owner has torn down a scope, and
 * it reached eight call sites in the record walk and nine in the validator.
 */
export const safeIsArray = (value: unknown): value is readonly unknown[] => {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
};
