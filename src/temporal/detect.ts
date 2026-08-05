import { ISO_DATE, ISO_DATE_TIME, ISO_TIME } from './patterns.js';
import type { TemporalKind } from './types.js';

/**
 * Classify a string by its temporal *shape*.
 *
 * Returns `null` for anything that is not shaped like a date, date-time, or
 * time. A non-null result does not promise the value is a real date:
 * `2021-02-29` is shaped like a date but does not exist. That distinction is
 * intentional and load-bearing — it lets the engine tell "this operand was meant
 * to be a date and is broken" (fail loud) apart from "this operand is ordinary
 * text" (compare as a string).
 *
 * The three patterns are mutually exclusive, so match order does not affect the
 * result.
 */
export const detectTemporalFormat = (value: string): TemporalKind | null => {
  if (ISO_DATE.test(value)) {
    return 'date';
  }

  if (ISO_DATE_TIME.test(value)) {
    return 'datetime';
  }

  if (ISO_TIME.test(value)) {
    return 'time';
  }

  return null;
};
