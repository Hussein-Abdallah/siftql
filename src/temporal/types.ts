/**
 * Temporal value model.
 *
 * A resolved temporal value carries a *domain* as well as a number, because
 * "12:00" and "2020-06-01" are not points on the same line. Collapsing both to a
 * bare `number` would let the engine compare milliseconds-since-midnight against
 * milliseconds-since-epoch and return a confident, meaningless answer. The domain
 * tag is what lets comparison fail loudly instead.
 */

/** The surface shape a temporal literal was written in. */
export type TemporalKind = 'date' | 'datetime' | 'time';

/**
 * The line a resolved value sits on.
 *
 * - `instant`: an absolute point in time, measured in milliseconds since the
 *   Unix epoch (UTC). Both `date` and `datetime` kinds resolve here, which is
 *   what makes mixed-precision comparison (`2020-06-01` vs
 *   `2020-06-01T12:00:00Z`) work chronologically.
 * - `timeOfDay`: a wall-clock time with no date, measured in milliseconds since
 *   midnight. Only the `time` kind resolves here.
 *
 * Values from different domains are never comparable.
 */
export type TemporalDomain = 'instant' | 'timeOfDay';

/** A temporal value that has been successfully resolved to a number. */
export type ResolvedTemporal = {
  /** Which line `value` sits on. Never compare across domains. */
  readonly domain: TemporalDomain;
  /** The surface form this was resolved from, retained for diagnostics. */
  readonly kind: TemporalKind;
  /**
   * Milliseconds since the Unix epoch (`instant`) or since midnight
   * (`timeOfDay`). Always a finite integer.
   */
  readonly value: number;
};

/**
 * User-supplied parser hook.
 *
 * Returning `null` means "I did not handle this value, continue the resolution
 * chain". It does not mean "this is invalid" and must not be used to signal an
 * error; siftql decides when to fail.
 */
export type ParseDateHook = (value: unknown) => Date | number | null;

/** Options governing how raw values are resolved into temporal values. */
export type TemporalOptions = {
  /**
   * Declared non-ISO layout(s), e.g. `'DD-MM-YYYY'`. An array is tried in order
   * and the first layout that parses wins. Declaring the layout is what makes
   * `01-06-2020` unambiguous; siftql never guesses between DD-MM and MM-DD.
   */
  readonly dateFormat?: string | readonly string[] | undefined;
  /**
   * Escape hatch for formats the built-in parser does not cover. Plug in Luxon,
   * date-fns, Day.js, or anything else. See {@link ParseDateHook} for the
   * meaning of a `null` return.
   */
  readonly parseDate?: ParseDateHook | undefined;
};
