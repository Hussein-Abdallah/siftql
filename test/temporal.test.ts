import { describe, expect, it } from 'vitest';

import {
  compareTemporal,
  daysInMonth,
  detectTemporalFormat,
  equalsTemporal,
  InvalidDateFormatError,
  isLeapYear,
  isValidCalendarDate,
  parseIso,
  resolveTemporal,
} from '../src/temporal/index.js';

/** Expected instants, built from explicit numeric components (no string parsing). */
const JUNE_1_2020 = Date.UTC(2020, 5, 1, 0, 0, 0, 0);
const JUNE_1_2020_NOON = Date.UTC(2020, 5, 1, 12, 0, 0, 0);
const JUNE_1_2020_10AM = Date.UTC(2020, 5, 1, 10, 0, 0, 0);

const resolvedValue = (value: unknown): number | null =>
  resolveTemporal(value)?.value ?? null;

describe('calendar', () => {
  it('applies the full Gregorian leap year rule', () => {
    expect(isLeapYear(2020)).toBe(true);
    expect(isLeapYear(2021)).toBe(false);
    // Divisible by 100 but not 400 -- the rule most implementations get wrong.
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('rejects days that do not exist in the given month', () => {
    expect(isValidCalendarDate(2020, 2, 29)).toBe(true);
    expect(isValidCalendarDate(2021, 2, 29)).toBe(false);
    expect(isValidCalendarDate(2020, 4, 31)).toBe(false);
    expect(isValidCalendarDate(2020, 12, 31)).toBe(true);
  });
});

describe('detectTemporalFormat', () => {
  it('classifies the three temporal shapes', () => {
    expect(detectTemporalFormat('2020-06-01')).toBe('date');
    expect(detectTemporalFormat('2020/06/01')).toBe('date');
    expect(detectTemporalFormat('2020-06-01T12:00:00Z')).toBe('datetime');
    expect(detectTemporalFormat('2020-06-01T12:00:00.123+02:00')).toBe(
      'datetime',
    );
    expect(detectTemporalFormat('2020-06-01 12:00:00')).toBe('datetime');
    expect(detectTemporalFormat('14:30')).toBe('time');
    expect(detectTemporalFormat('14:30:59')).toBe('time');
  });

  it('returns null for non-temporal text', () => {
    expect(detectTemporalFormat('notadate')).toBeNull();
    expect(detectTemporalFormat('m')).toBeNull();
    expect(detectTemporalFormat('')).toBeNull();
  });

  it('rejects out-of-range components', () => {
    expect(detectTemporalFormat('2020-13-01')).toBeNull();
    expect(detectTemporalFormat('2020-06-32')).toBeNull();
    expect(detectTemporalFormat('25:00')).toBeNull();
    expect(detectTemporalFormat('12:60')).toBeNull();
  });

  it('rejects mixed date separators', () => {
    expect(detectTemporalFormat('2020-06/01')).toBeNull();
  });

  it('recognises a well-shaped but non-existent day, so it can fail loudly', () => {
    // Shape is valid, so this was clearly *meant* as a date...
    expect(detectTemporalFormat('2021-02-29')).toBe('date');
    // ...but it is not a real day, so it must not silently resolve.
    expect(parseIso('2021-02-29')).toBeNull();
  });
});

describe('parseIso', () => {
  it('reads a bare calendar date as midnight UTC', () => {
    expect(resolvedValue('2020-06-01')).toBe(JUNE_1_2020);
  });

  it('applies numeric UTC offsets', () => {
    expect(resolvedValue('2020-06-01T12:00:00+02:00')).toBe(JUNE_1_2020_10AM);
    expect(resolvedValue('2020-06-01T08:00:00-02:00')).toBe(JUNE_1_2020_10AM);
    expect(resolvedValue('2020-06-01T12:00:00+0200')).toBe(JUNE_1_2020_10AM);
    expect(resolvedValue('2020-06-01T12:00:00+02')).toBe(JUNE_1_2020_10AM);
  });

  it('treats an offset-less date-time as UTC, not machine-local', () => {
    // Deterministic regardless of the TZ the test host runs in.
    expect(resolvedValue('2020-06-01T12:00:00')).toBe(JUNE_1_2020_NOON);
  });

  it('truncates fractional seconds to milliseconds', () => {
    expect(resolvedValue('2020-06-01T00:00:00.5Z')).toBe(JUNE_1_2020 + 500);
    expect(resolvedValue('2020-06-01T00:00:00.123Z')).toBe(JUNE_1_2020 + 123);
    // Truncated, never rounded up into the next second.
    expect(resolvedValue('2020-06-01T00:00:00.9999Z')).toBe(JUNE_1_2020 + 999);
  });

  it('reads a bare time as milliseconds since midnight', () => {
    const parsed = parseIso('14:30');

    expect(parsed?.domain).toBe('timeOfDay');
    expect(parsed?.value).toBe(14 * 3_600_000 + 30 * 60_000);
  });

  it('does not roll invalid components over into the next month', () => {
    // new Date("2021-02-29") silently yields 1 March 2021; we return null.
    expect(resolvedValue('2021-02-29')).toBeNull();
    expect(resolvedValue('2020-02-30')).toBeNull();
    expect(resolvedValue('2020-13-45')).toBeNull();
  });

  it('is not sensitive to the host timezone', () => {
    // new Date("2020-06-01") is midnight UTC but new Date("2020-06-01T00:00:00")
    // is midnight *local* -- a difference of the host offset for one character.
    // Both resolve identically here, on any machine.
    expect(resolvedValue('2020-06-01')).toBe(JUNE_1_2020);
    expect(resolvedValue('2020-06-01T00:00:00')).toBe(JUNE_1_2020);
  });

  it('handles years below 100 without the 1900 offset bug', () => {
    const parsed = parseIso('0050-01-01');
    const expected = new Date(0);

    expected.setUTCFullYear(50, 0, 1);
    expected.setUTCHours(0, 0, 0, 0);

    expect(parsed?.value).toBe(expected.getTime());
  });
});

describe('resolveTemporal field values', () => {
  it('resolves ISO strings, epoch numbers, and Date objects alike', () => {
    expect(resolvedValue('2020-06-01T12:00:00Z')).toBe(JUNE_1_2020_NOON);
    expect(resolvedValue(JUNE_1_2020_NOON)).toBe(JUNE_1_2020_NOON);
    expect(resolvedValue(new Date(JUNE_1_2020_NOON))).toBe(JUNE_1_2020_NOON);
  });

  it('refuses an Invalid Date rather than producing NaN', () => {
    expect(resolveTemporal(new Date('nonsense'))).toBeNull();
    expect(resolveTemporal(Number.NaN)).toBeNull();
    expect(resolveTemporal(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('does not fall back to native parsing', () => {
    // new Date("June 1, 2020") works in V8; we deliberately do not.
    expect(resolveTemporal('June 1, 2020')).toBeNull();
    expect(resolveTemporal('notadate')).toBeNull();
  });
});

describe('dateFormat', () => {
  it('resolves a declared layout', () => {
    expect(
      resolveTemporal('01-06-2020', { dateFormat: 'DD-MM-YYYY' })?.value,
    ).toBe(JUNE_1_2020);
  });

  it('reads the same digits differently under a different layout', () => {
    // The whole point: siftql never guesses DD-MM vs MM-DD.
    expect(
      resolveTemporal('01-06-2020', { dateFormat: 'MM-DD-YYYY' })?.value,
    ).toBe(Date.UTC(2020, 0, 6));
  });

  it('tries an array of layouts in order', () => {
    const options = { dateFormat: ['DD/MM/YYYY', 'DD-MM-YYYY'] };

    expect(resolveTemporal('01-06-2020', options)?.value).toBe(JUNE_1_2020);
    expect(resolveTemporal('01/06/2020', options)?.value).toBe(JUNE_1_2020);
  });

  it('supports layouts carrying a time component', () => {
    expect(
      resolveTemporal('01-06-2020 12:00', { dateFormat: 'DD-MM-YYYY HH:mm' })
        ?.value,
    ).toBe(JUNE_1_2020_NOON);
  });

  it('still validates the calendar under a declared layout', () => {
    expect(
      resolveTemporal('29-02-2021', { dateFormat: 'DD-MM-YYYY' }),
    ).toBeNull();
  });

  it('rejects a malformed layout immediately', () => {
    expect(() => resolveTemporal('x', { dateFormat: 'DD-MM' })).toThrow(
      InvalidDateFormatError,
    );
    expect(() => resolveTemporal('x', { dateFormat: 'YYYY-YYYY' })).toThrow(
      InvalidDateFormatError,
    );
  });
});

describe('resolution order', () => {
  it('lets parseDate override a declared dateFormat', () => {
    const resolved = resolveTemporal('01-06-2020', {
      dateFormat: 'DD-MM-YYYY',
      parseDate: () => new Date(JUNE_1_2020_NOON),
    });

    expect(resolved?.value).toBe(JUNE_1_2020_NOON);
  });

  it('falls through to dateFormat when parseDate returns null', () => {
    const resolved = resolveTemporal('01-06-2020', {
      dateFormat: 'DD-MM-YYYY',
      // null means "not mine", not "invalid".
      parseDate: () => null,
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('prefers canonical ISO over parseDate', () => {
    const resolved = resolveTemporal('2020-06-01', {
      parseDate: () => new Date(0),
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('lets parseDate reinterpret numbers, e.g. epoch seconds', () => {
    const resolved = resolveTemporal(JUNE_1_2020 / 1000, {
      parseDate: (value) =>
        typeof value === 'number' ? new Date(value * 1000) : null,
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('does not consult the hook at all for canonical ISO', () => {
    let calls = 0;

    const resolved = resolveTemporal('2020-06-01', {
      parseDate: () => {
        calls += 1;

        return null;
      },
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
    expect(calls).toBe(0);
  });

  it('trusts the instant a hook returns, even a mis-zoned one', () => {
    // A hook is the one place the fail-loud guarantee cannot reach: it hands
    // back a number of milliseconds and that number is taken at face value.
    // The classic mistake is a library that parses in the host's local zone
    // (Luxon's fromFormat, day.js without a plugin) rather than UTC, which
    // silently shifts every result by the host offset.
    const misZoned = resolveTemporal('01-06-2020', {
      parseDate: () => JUNE_1_2020 + 4 * 3_600_000,
    });

    expect(misZoned?.value).toBe(JUNE_1_2020 + 4 * 3_600_000);
  });

  it('opts into native parsing only when the user asks for it', () => {
    const resolved = resolveTemporal('June 1, 2020', {
      parseDate: (value) => {
        const native = new Date(String(value));

        return Number.isNaN(native.getTime()) ? null : native;
      },
    });

    expect(resolved).not.toBeNull();
  });
});

describe('compareTemporal', () => {
  it('orders equivalent instants written in different offsets as equal', () => {
    const utc = resolveTemporal('2020-06-01T12:00:00Z');
    const offset = resolveTemporal('2020-06-01T14:00:00+02:00');

    expect(utc && offset && compareTemporal(utc, offset)).toBe(0);
  });

  it('orders across mixed precision', () => {
    const day = resolveTemporal('2020-06-01');
    const noon = resolveTemporal('2020-06-01T12:00:00Z');

    expect(day && noon && compareTemporal(day, noon)).toBe(-1);
    expect(noon && day && compareTemporal(noon, day)).toBe(1);
  });

  it('refuses to compare a wall-clock time against a calendar instant', () => {
    const time = resolveTemporal('14:30');
    const date = resolveTemporal('2020-06-01');

    // Both are numbers, but they measure different things. The only correct
    // answer is "not comparable" -- never a confident ordering.
    expect(time && date && compareTemporal(time, date)).toBeNull();
  });
});

describe('equalsTemporal', () => {
  it('is true for the same instant written two ways', () => {
    const utc = resolveTemporal('2020-06-01T12:00:00Z');
    const offset = resolveTemporal('2020-06-01T14:00:00+02:00');

    expect(utc && offset && equalsTemporal(utc, offset)).toBe(true);
  });

  it('is false across domains rather than throwing', () => {
    const time = resolveTemporal('14:30');
    const date = resolveTemporal('2020-06-01');

    expect(time && date && equalsTemporal(time, date)).toBe(false);
  });
});

describe('calendar guards', () => {
  it('rejects an out-of-range month', () => {
    expect(daysInMonth(2020, 0)).toBeNull();
    expect(daysInMonth(2020, 13)).toBeNull();
    expect(daysInMonth(2020, 1.5)).toBeNull();
  });

  it('rejects non-integer year or day', () => {
    expect(isValidCalendarDate(2020.5, 1, 1)).toBe(false);
    expect(isValidCalendarDate(2020, 1, 1.5)).toBe(false);
  });
});
