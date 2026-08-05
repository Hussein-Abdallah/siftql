import {
  isValidCalendarDate,
  isValidTimeOfDay,
  millisecondsSinceMidnight,
  utcTimestamp,
} from './calendar.js';
import { ISO_DATE, ISO_DATE_TIME, ISO_TIME } from './patterns.js';
import type { ResolvedTemporal } from './types.js';

/**
 * Parse a fractional-second string to whole milliseconds.
 *
 * Truncates rather than rounds: `.9999` is 999ms, not 1000ms. Rounding could
 * carry into the next second and move a value across a range boundary.
 */
const fractionToMilliseconds = (fraction: string | undefined): number => {
  if (fraction === undefined) {
    return 0;
  }

  return Number(fraction.slice(0, 3).padEnd(3, '0'));
};

/**
 * Convert a UTC offset designator to minutes east of UTC.
 *
 * `undefined` (a naive value with no designator) is treated as UTC. Resolving it
 * as *local* time instead would make the same query return different results on
 * a London server and a Tokyo browser; UTC is the only choice that is
 * deterministic everywhere. This is documented behaviour, not a guess.
 */
const offsetToMinutes = (offset: string | undefined): number => {
  if (offset === undefined || offset === 'Z' || offset === 'z') {
    return 0;
  }

  const sign = offset.startsWith('-') ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;

  return sign * (hours * 60 + minutes);
};

const parseIsoDate = (value: string): ResolvedTemporal | null => {
  const groups = ISO_DATE.exec(value)?.groups;

  if (!groups) {
    return null;
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);

  if (!isValidCalendarDate(year, month, day)) {
    return null;
  }

  return {
    domain: 'instant',
    kind: 'date',
    value: utcTimestamp(year, month, day, 0, 0, 0, 0),
  };
};

const parseIsoDateTime = (value: string): ResolvedTemporal | null => {
  const groups = ISO_DATE_TIME.exec(value)?.groups;

  if (!groups) {
    return null;
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = groups.second === undefined ? 0 : Number(groups.second);
  const millisecond = fractionToMilliseconds(groups.fraction);

  if (
    !isValidCalendarDate(year, month, day) ||
    !isValidTimeOfDay(hour, minute, second, millisecond)
  ) {
    return null;
  }

  const local = utcTimestamp(year, month, day, hour, minute, second, millisecond);
  const offsetMinutes = offsetToMinutes(groups.offset);

  return {
    domain: 'instant',
    kind: 'datetime',
    // Subtracting the offset converts the wall-clock reading into the
    // corresponding UTC instant: 12:00+02:00 is 10:00Z.
    value: local - offsetMinutes * 60_000,
  };
};

const parseIsoTime = (value: string): ResolvedTemporal | null => {
  const groups = ISO_TIME.exec(value)?.groups;

  if (!groups) {
    return null;
  }

  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = groups.second === undefined ? 0 : Number(groups.second);
  const millisecond = fractionToMilliseconds(groups.fraction);

  if (!isValidTimeOfDay(hour, minute, second, millisecond)) {
    return null;
  }

  return {
    domain: 'timeOfDay',
    kind: 'time',
    value: millisecondsSinceMidnight(hour, minute, second, millisecond),
  };
};

/**
 * Parse a canonical ISO 8601 date, date-time, or 24-hour time.
 *
 * Returns `null` when the string is not one of those shapes, and also when it
 * has a valid shape but names a day that does not exist (`2021-02-29`). Callers
 * distinguish the two cases with `detectTemporalFormat`.
 */
export const parseIso = (value: string): ResolvedTemporal | null =>
  parseIsoDate(value) ?? parseIsoDateTime(value) ?? parseIsoTime(value);
