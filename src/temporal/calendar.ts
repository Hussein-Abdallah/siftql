/**
 * Calendar arithmetic, written out rather than delegated to `Date` string
 * parsing.
 *
 * `new Date("2020-02-30")` and `Date.UTC(2020, 1, 30)` both roll over into March
 * instead of reporting that the input was nonsense. Rolling over is precisely the
 * silently-wrong behaviour siftql exists to avoid, so every component is range-
 * and calendar-checked before a timestamp is ever constructed.
 */

/** Proleptic Gregorian leap year rule. */
export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Number of days in a 1-indexed month, or `null` if the month is out of range.
 */
export const daysInMonth = (year: number, month: number): number | null => {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  // Safe: month is a validated integer in 1..12.
  return MONTH_LENGTHS[month - 1] ?? null;
};

/**
 * True only if the year/month/day triple names a real calendar day.
 *
 * This is stricter than the shape check performed during format detection:
 * `2021-02-29` has a valid *shape* but is not a real date.
 */
export const isValidCalendarDate = (
  year: number,
  month: number,
  day: number,
): boolean => {
  if (!Number.isInteger(year) || !Number.isInteger(day)) {
    return false;
  }

  const limit = daysInMonth(year, month);

  return limit !== null && day >= 1 && day <= limit;
};

/** True only if the time-of-day components are in range. */
export const isValidTimeOfDay = (
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): boolean =>
  Number.isInteger(hour) &&
  Number.isInteger(minute) &&
  Number.isInteger(second) &&
  Number.isInteger(millisecond) &&
  hour >= 0 &&
  hour <= 23 &&
  minute >= 0 &&
  minute <= 59 &&
  // Leap seconds are not representable in the JS time value, so 60 is rejected.
  second >= 0 &&
  second <= 59 &&
  millisecond >= 0 &&
  millisecond <= 999;

/**
 * Build a UTC timestamp from already-validated components.
 *
 * Uses `setUTCFullYear` rather than `Date.UTC`, because `Date.UTC` maps years
 * 0-99 into 1900-1999 — so `Date.UTC(50, 0, 1)` is 1950, not the year 50.
 */
export const utcTimestamp = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number => {
  const date = new Date(0);

  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);

  return date.getTime();
};

/** Milliseconds elapsed since midnight, for wall-clock times with no date. */
export const millisecondsSinceMidnight = (
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number => hour * 3_600_000 + minute * 60_000 + second * 1_000 + millisecond;
