import { SiftQLConfigError } from '../errors.js';
import {
  isValidCalendarDate,
  isValidTimeOfDay,
  millisecondsSinceMidnight,
  utcTimestamp,
} from './calendar.js';
import type { ResolvedTemporal } from './types.js';

/**
 * Declared-layout parsing, for data that is not ISO 8601.
 *
 * The point of `dateFormat` is to remove ambiguity, not to add cleverness:
 * `01-06-2020` is 1 June under `DD-MM-YYYY` and 6 January under `MM-DD-YYYY`,
 * and siftql will not guess which you meant. You state the layout; siftql obeys
 * it exactly.
 *
 * Supported tokens — anything else in the layout is matched literally:
 *
 * | Token | Meaning                        |
 * | ----- | ------------------------------ |
 * | YYYY  | 4-digit year                   |
 * | MM    | 2-digit month, 01-12           |
 * | DD    | 2-digit day, 01-31             |
 * | HH    | 2-digit hour, 00-23 (24-hour)  |
 * | mm    | 2-digit minute, 00-59          |
 * | ss    | 2-digit second, 00-59          |
 * | SSS   | 3-digit millisecond            |
 *
 * Two-digit years (`YY`) are deliberately unsupported: mapping `68` to a century
 * requires a pivot rule, and a pivot rule is a guess. Use `parseDate` if you have
 * two-digit years and can supply the missing context yourself.
 *
 * Layouts describe *naive* wall-clock values and are resolved as UTC, matching
 * how offset-less ISO values are treated.
 */

type TokenName =
  'day' | 'fraction' | 'hour' | 'minute' | 'month' | 'second' | 'year';

/** Ordered longest-first so that `YYYY` is never mistaken for two `YY`s. */
const TOKENS: readonly (readonly [string, TokenName, string])[] = [
  ['YYYY', 'year', String.raw`\d{4}`],
  ['SSS', 'fraction', String.raw`\d{3}`],
  ['MM', 'month', String.raw`\d{2}`],
  ['DD', 'day', String.raw`\d{2}`],
  ['HH', 'hour', String.raw`\d{2}`],
  ['mm', 'minute', String.raw`\d{2}`],
  ['ss', 'second', String.raw`\d{2}`],
];

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

const escapeLiteral = (character: string): string =>
  character.replace(REGEX_SPECIAL, String.raw`\$&`);

interface CompiledFormat {
  readonly kind: 'date' | 'datetime' | 'time';
  readonly regex: RegExp;
}

/**
 * A malformed layout is a programming error in the host application, not bad
 * user input, so it is reported immediately and loudly rather than degrading to
 * "nothing matches".
 */
export class SiftQLDateFormatError extends SiftQLConfigError {
  public constructor(format: string, reason: string) {
    super(`Invalid dateFormat ${JSON.stringify(format)}: ${reason}`);
    // Extends SiftQLConfigError so it satisfies the documented contract: every
    // error siftql throws is a SiftQLError and answers isSiftQLError(). A bare
    // TypeError escaped both, so a caller catching SiftQLError missed it.
    //
    // The NAME is prefixed for the other half of that contract — `errors.ts`
    // states that every siftql error name is prefixed, and this class was called
    // `InvalidDateFormatError`, which read like a host-application error in a
    // stack trace and was the one subclass missing from the package's exports.
    this.name = 'SiftQLDateFormatError';
  }
}

/**
 * Check a layout without having a value to read through it.
 *
 * Exists so `createEngine` can refuse a malformed `dateFormat` up front.
 * Validating only when a value arrives meant `dateFormat: 'QQQQ'` built an engine
 * happily and then failed on whichever record first held something date-shaped —
 * reported as an OPERAND error with the real cause demoted to `.cause`, so a
 * caller checking for `code === 'CONFIG'` to detect a misconfigured engine never
 * saw it.
 */
export const assertValidFormat = (format: string): void => {
  compileFormat(format);
};

const compileCache = new Map<string, CompiledFormat>();

const compileFormat = (format: string): CompiledFormat => {
  const cached = compileCache.get(format);

  if (cached) {
    return cached;
  }

  const seen = new Set<TokenName>();
  let pattern = '';
  let index = 0;

  while (index < format.length) {
    const token = TOKENS.find(([literal]) => format.startsWith(literal, index));

    if (token) {
      const [literal, name, fragment] = token;

      if (seen.has(name)) {
        throw new SiftQLDateFormatError(
          format,
          `token "${literal}" appears more than once`,
        );
      }

      seen.add(name);
      pattern += `(?<${name}>${fragment})`;
      index += literal.length;
      continue;
    }

    pattern += escapeLiteral(format.charAt(index));
    index += 1;
  }

  const hasDateParts = seen.has('year') || seen.has('month') || seen.has('day');
  const hasAllDateParts =
    seen.has('year') && seen.has('month') && seen.has('day');
  const hasClockParts = seen.has('hour') && seen.has('minute');

  if (hasDateParts && !hasAllDateParts) {
    throw new SiftQLDateFormatError(
      format,
      'a calendar layout must include all of YYYY, MM and DD',
    );
  }

  if (!hasDateParts && !hasClockParts) {
    throw new SiftQLDateFormatError(
      format,
      'expected a calendar layout (YYYY, MM, DD) or a clock layout (HH, mm)',
    );
  }

  const compiled: CompiledFormat = {
    kind: hasAllDateParts ? (hasClockParts ? 'datetime' : 'date') : 'time',
    regex: new RegExp(`^${pattern}$`, 'u'),
  };

  compileCache.set(format, compiled);

  return compiled;
};

/** Parse `value` against a single declared layout. */
/**
 * What reading a value through a declared layout produced.
 *
 * THREE outcomes, not two, and the distinction is the whole point. `null` used
 * to mean both "this value is not shaped like the layout" and "it is shaped like
 * the layout and names a date that does not exist" — so `resolveTemporal` fell
 * through to the built-in ISO parser in both cases.
 *
 * Under `dateFormat: 'YYYY-DD-MM'` that meant `2020-02-11` was read through the
 * layout as 11 February while `2020-02-29` was read as ISO — because day 29 is
 * not a valid MONTH, the layout declined, and ISO happily took it. One column,
 * two calendars, split on whether the second field happened to exceed 12. That
 * is the exact defect a previous commit claimed to have fixed by reordering the
 * chain; reordering moved the split rather than removing it.
 *
 * `impossible` must NOT fall through. A value that fits the declared layout has
 * been claimed by it, and if the fields name no real instant the answer is a
 * refusal — not a second opinion from a parser the caller did not ask for.
 */
export type FormatOutcome =
  | { readonly outcome: 'parsed'; readonly value: ResolvedTemporal }
  | { readonly outcome: 'mismatch' }
  | { readonly outcome: 'impossible'; readonly reason: string };

const MISMATCH: FormatOutcome = Object.freeze({ outcome: 'mismatch' });

export const readWithFormat = (
  value: string,
  format: string,
): FormatOutcome => {
  const { kind, regex } = compileFormat(format);
  const groups = regex.exec(value)?.groups;

  if (!groups) {
    return MISMATCH;
  }

  const hour = groups.hour === undefined ? 0 : Number(groups.hour);
  const minute = groups.minute === undefined ? 0 : Number(groups.minute);
  const second = groups.second === undefined ? 0 : Number(groups.second);
  const millisecond =
    groups.fraction === undefined ? 0 : Number(groups.fraction);

  if (!isValidTimeOfDay(hour, minute, second, millisecond)) {
    return {
      outcome: 'impossible',
      reason: 'names a time that does not exist',
    };
  }

  if (kind === 'time') {
    return {
      outcome: 'parsed',
      value: {
        domain: 'timeOfDay',
        kind: 'time',
        value: millisecondsSinceMidnight(hour, minute, second, millisecond),
      },
    };
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);

  if (!isValidCalendarDate(year, month, day)) {
    return {
      outcome: 'impossible',
      reason: 'names a date that does not exist',
    };
  }

  return {
    outcome: 'parsed',
    value: {
      domain: 'instant',
      kind,
      value: utcTimestamp(year, month, day, hour, minute, second, millisecond),
    },
  };
};

/** The old two-outcome shape, kept for callers that only need a value. */
export const parseWithFormat = (
  value: string,
  format: string,
): ResolvedTemporal | null => {
  const read = readWithFormat(value, format);

  return read.outcome === 'parsed' ? read.value : null;
};

/**
 * How many DIGITS a layout consumes, or `null` if a bare number could never be
 * one.
 *
 * Used to tell a number that was MEANT as this layout from one that was not:
 * under `YYYYMMDD`, the 8-digit 20200631 is an attempt at a date (an impossible
 * one), while the 13-digit 1593000000000 is plainly epoch milliseconds.
 *
 * A layout containing any LITERAL character returns `null`, because a bare
 * number cannot contain one. Counting literals toward the width made
 * `YYYY-MM-DD` a 10-character layout, so every 10-digit number was refused as a
 * malformed date — including 1593000000, which is an ordinary epoch-seconds
 * timestamp and matches no part of that layout.
 */
export const formatWidth = (format: string): number | null => {
  let width = 0;
  let index = 0;

  while (index < format.length) {
    const token = TOKENS.find(([literal]) => format.startsWith(literal, index));

    if (token) {
      const [literal, , fragment] = token;
      const digits = /\{(\d+)\}/u.exec(fragment)?.[1];

      if (digits === undefined) {
        return null;
      }

      width += Number(digits);
      index += literal.length;
      continue;
    }

    // A literal separator. No bare number can contain one, so this layout can
    // never claim a number and must not veto one either.
    return null;
  }

  return width;
};

/** Try each declared layout in order; the first that parses wins. */
export const readWithFormats = (
  value: string,
  formats: string | readonly string[],
): FormatOutcome => {
  const list = typeof formats === 'string' ? [formats] : formats;

  let impossible: FormatOutcome | null = null;

  for (const format of list) {
    const read = readWithFormat(value, format);

    if (read.outcome === 'parsed') {
      return read;
    }

    // Remembered, not returned yet: with several layouts declared, a LATER one
    // may still read the value successfully, and a real reading beats a refusal.
    if (read.outcome === 'impossible') {
      impossible ??= read;
    }
  }

  return impossible ?? MISMATCH;
};
