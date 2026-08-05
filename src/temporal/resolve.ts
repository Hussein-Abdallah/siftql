import { parseWithFormats } from './format.js';
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

  return asInstant(result instanceof Date ? result.getTime() : result);
};

/**
 * Resolve any value into a comparable temporal value, or `null` if it is not
 * temporal at all.
 *
 * Resolution order — first match wins:
 *
 * 1. **`Date` instances.** Already an instant; there is no layout to interpret,
 *    so nothing can usefully override this. An Invalid Date resolves to `null`.
 * 2. **Canonical ISO 8601 strings**, via the built-in parser.
 * 3. **`options.parseDate`**, if supplied. Returning `null` means "not mine" and
 *    defers to the next step; it is never treated as an error.
 * 4. **`options.dateFormat`** declared layout(s), tried in order.
 * 5. **Finite numbers**, read as milliseconds since the Unix epoch.
 * 6. Otherwise `null`.
 *
 * Two notes on that order. `parseDate` sits ahead of `dateFormat` so a hook can
 * override a declared layout while still deferring via `null`. Numbers sit
 * *behind* `parseDate` rather than in step 2, so that a project storing
 * timestamps in seconds can reinterpret them — treating every bare number as
 * milliseconds with no way to intervene would be a silent factor-of-1000 error.
 *
 * There is deliberately no `new Date(string)` fallback anywhere in this chain.
 * Native parsing is engine- and locale-dependent and rolls invalid input over
 * instead of rejecting it (`new Date("2020-13-45")` yields a date in 2021).
 * Callers who want that leniency can opt into it explicitly through `parseDate`.
 */
export const resolveTemporal = (
  value: unknown,
  options: TemporalOptions = {},
): ResolvedTemporal | null => {
  if (value instanceof Date) {
    return asInstant(value.getTime());
  }

  if (typeof value === 'string') {
    const iso = parseIso(value);

    if (iso) {
      return iso;
    }
  }

  if (options.parseDate) {
    const hooked = fromHookResult(options.parseDate(value));

    if (hooked) {
      return hooked;
    }
  }

  if (typeof value === 'string' && options.dateFormat !== undefined) {
    const formatted = parseWithFormats(value, options.dateFormat);

    if (formatted) {
      return formatted;
    }
  }

  if (typeof value === 'number') {
    return asInstant(value);
  }

  return null;
};
