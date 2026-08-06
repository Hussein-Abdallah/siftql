import { isDateLike } from '../internal.js';
import { formatWidth, readWithFormats } from './format.js';
import { parseIso } from './iso.js';
import type { ResolvedTemporal, TemporalOptions } from './types.js';

/**
 * Message used whenever a value that was *meant* to be temporal cannot be
 * resolved. Exported so the engine can raise it consistently; the temporal
 * module itself never throws for unresolvable data, it returns `null` and lets
 * the caller apply the configured failure policy.
 */
export const SUPPORTED_TEMPORAL_MESSAGE =
  'Expected an ISO 8601 date (2020-06-01), date-time (2020-06-01T12:00:00Z, ' +
  'offsets and fractional seconds supported), 24-hour time (14:30), epoch ' +
  'milliseconds, or a Date. To accept other layouts, set options.dateFormat ' +
  'or options.parseDate.';

const asInstant = (value: number): ResolvedTemporal | null =>
  Number.isFinite(value)
    ? { domain: 'instant', kind: 'datetime', value }
    : null;

/** Normalise what a user hook handed back into our internal representation. */
const fromHookResult = (
  result: Date | number | null,
): ResolvedTemporal | null => {
  if (result === null) {
    return null;
  }

  // isDateLike, not instanceof: a hook may hand back a cross-realm Date, and
  // must not be able to throw out of here with a Date-prototyped impostor.
  return asInstant(isDateLike(result) ? result.getTime() : result);
};

/**
 * Resolve any value into a comparable temporal value, or `null` if it is not
 * temporal at all.
 *
 * Resolution order — first match wins:
 *
 * 1. **`Date` instances.** Already an instant; there is no layout to interpret,
 *    so nothing can usefully override this. An Invalid Date resolves to `null`.
 * 2. **`options.parseDate`**, if supplied. Returning `null` means "not mine" and
 *    defers to the next step; it is never treated as an error.
 * 3. **`options.dateFormat`** declared layout(s), tried in order.
 * 4. **Canonical ISO 8601 strings**, via the built-in parser.
 * 5. **Finite numbers**, read as milliseconds since the Unix epoch.
 * 6. Otherwise `null`.
 *
 * Three notes on that order. `parseDate` sits ahead of `dateFormat` so a hook
 * can override a declared layout while still deferring via `null`. A DECLARED
 * layout sits ahead of the built-in ISO parser, because anything else means
 * siftql guessing against an instruction it was given. Numbers sit *behind*
 * `parseDate` rather than near the top, so that a project storing timestamps in
 * seconds can reinterpret them — treating every bare number as milliseconds with
 * no way to intervene would be a silent factor-of-1000 error.
 *
 * There is deliberately no `new Date(string)` fallback anywhere in this chain,
 * for three separate reasons:
 *
 * - It rolls impossible dates over instead of rejecting them:
 *   `new Date("2021-02-29")` is 1 March 2021.
 * - It is inconsistent about zones within a single API: `new Date("2020-06-01")`
 *   is midnight *UTC*, while `new Date("2020-06-01T00:00:00")` is midnight
 *   *local*. One character changes the answer by the host's UTC offset.
 * - Anything it cannot read as ISO 8601 falls back to implementation-defined
 *   parsing, so results vary by engine and locale.
 *
 * Callers who want that leniency can opt into it explicitly through `parseDate`,
 * which makes the risk their deliberate choice rather than a blessed default.
 */
export const resolveTemporal = (
  value: unknown,
  options: TemporalOptions = {},
): ResolvedTemporal | null => {
  if (isDateLike(value)) {
    return asInstant(value.getTime());
  }

  if (options.parseDate) {
    const hooked = fromHookResult(options.parseDate(value));

    if (hooked) {
      return hooked;
    }
  }

  if (
    options.dateFormat !== undefined &&
    (typeof value === 'string' || typeof value === 'number')
  ) {
    /*
     * A declared layout applies to BOTH sides of the comparison.
     *
     * Numbers are stringified first, because a layout such as `YYYYMMDD`
     * describes digits and a field holding `20200601` as a NUMBER means the
     * same day as one holding it as a string. Reading the operand through the
     * layout while reading the value as epoch milliseconds put the two sides
     * fifty years apart and reported them as comparable.
     *
     * A genuine epoch-millisecond value is unaffected: 1593000000000 does not
     * match an 8-character layout, so it falls through to the branch below.
     */
    const read = readWithFormats(
      typeof value === 'number' ? String(value) : value,
      options.dateFormat,
    );

    if (read.outcome === 'parsed') {
      return read.value;
    }

    /*
     * IMPOSSIBLE STOPS HERE. A value that fits the declared layout has been
     * claimed by it, so if its fields name no real instant the answer is a
     * refusal — falling through would hand it to a parser the caller never asked
     * for. Under `YYYY-DD-MM`, falling through would read `2020-02-29` as 29
     * February via ISO while `2020-02-11` reads as 11 February via the layout —
     * one column meaning two things depending on whether the second field
     * exceeds 12.
     */
    if (read.outcome === 'impossible') {
      return null;
    }
  }

  /*
   * The built-in ISO parser runs AFTER a declared layout, not before it.
   *
   * Running first, it silently overrode the layout for exactly the values both
   * could read. Under `dateFormat: 'YYYY-DD-MM'`, `2020-11-06` came back as 6
   * November — the ISO reading — while `2020-20-07` came back as 20 July,
   * because a day of 20 fails the ISO month group and fell through to the
   * layout. So one column was read two ways, split on whether the day happened
   * to be 12 or less, and nothing reported a problem. `format.ts` promises the
   * opposite in as many words: "siftql will not guess which you meant. You state
   * the layout; siftql obeys it exactly."
   *
   * A string that does not match the declared layout still resolves as ISO, so
   * declaring a layout for one column does not break an ISO timestamp in
   * another.
   */
  if (typeof value === 'string') {
    const iso = parseIso(value);

    if (iso) {
      return iso;
    }
  }

  if (typeof value === 'number') {
    /*
     * A DECLARED calendar layout overrides the epoch reading for numbers.
     *
     * With `dateFormat: 'YYYYMMDD'`, the number 20200631 is "June 31st" — a day
     * that does not exist. Falling through to epoch milliseconds read it as
     * 1970-01-01T05:36:40Z instead, so a query for everything before 2000
     * matched it. The operand and the value must be read the same way or the
     * comparison is meaningless; an impossible date is refused, not reinterpreted.
     */
    const widths =
      options.dateFormat === undefined
        ? []
        : (typeof options.dateFormat === 'string'
            ? [options.dateFormat]
            : options.dateFormat
          ).map((format) => formatWidth(format));

    // Only refuse a number that is the right SHAPE for a declared layout. A
    // 13-digit epoch is plainly not an attempt at YYYYMMDD and still resolves.
    if (widths.includes(String(value).length)) {
      return null;
    }

    return asInstant(value);
  }

  return null;
};
