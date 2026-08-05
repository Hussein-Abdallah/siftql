import type { ResolvedTemporal } from './types.js';

/**
 * Chronologically order two resolved temporal values.
 *
 * Returns a negative number, zero, or a positive number in the usual comparator
 * convention — or `null` when the two values are not comparable at all because
 * they sit in different domains. A wall-clock `14:30` and a calendar
 * `2020-06-01` have no defined ordering between them; the only correct answers
 * are "these cannot be compared" or an error, never a number.
 *
 * Callers turn `null` into whatever their failure policy dictates.
 */
export const compareTemporal = (
  left: ResolvedTemporal,
  right: ResolvedTemporal,
): number | null => {
  if (left.domain !== right.domain) {
    return null;
  }

  if (left.value < right.value) {
    return -1;
  }

  if (left.value > right.value) {
    return 1;
  }

  return 0;
};

/**
 * True when two resolved values denote the same moment.
 *
 * Equality is by resolved value, not by surface form, so `2020-06-01T12:00:00Z`
 * and `2020-06-01T14:00:00+02:00` are equal — they are the same instant written
 * two ways. Mixed precision behaves the same way: `2020-06-01` is midnight UTC,
 * so it equals `2020-06-01T00:00:00Z`.
 */
export const equalsTemporal = (
  left: ResolvedTemporal,
  right: ResolvedTemporal,
): boolean => compareTemporal(left, right) === 0;
