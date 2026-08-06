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
export const parseWithFormat = (
  value: string,
  format: string,
): ResolvedTemporal | null => {
  const { kind, regex } = compileFormat(format);
  const groups = regex.exec(value)?.groups;

  if (!groups) {
    return null;
  }

  const hour = groups.hour === undefined ? 0 : Number(groups.hour);
  const minute = groups.minute === undefined ? 0 : Number(groups.minute);
  const second = groups.second === undefined ? 0 : Number(groups.second);
  const millisecond =
    groups.fraction === undefined ? 0 : Number(groups.fraction);

  if (!isValidTimeOfDay(hour, minute, second, millisecond)) {
    return null;
  }

  if (kind === 'time') {
    return {
      domain: 'timeOfDay',
      kind: 'time',
      value: millisecondsSinceMidnight(hour, minute, second, millisecond),
    };
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);

  if (!isValidCalendarDate(year, month, day)) {
    return null;
  }

  return {
    domain: 'instant',
    kind,
    value: utcTimestamp(year, month, day, hour, minute, second, millisecond),
  };
};

/**
 * How many characters a layout consumes, or `null` if it is not fixed-width.
 *
 * Used to tell a number that was MEANT as this layout from one that was not:
 * under `YYYYMMDD`, the 8-digit 20200631 is an attempt at a date (an impossible
 * one), while the 13-digit 1593000000000 is plainly epoch milliseconds.
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

    width += 1;
    index += 1;
  }

  return width;
};

/** Try each declared layout in order; the first that parses wins. */
export const parseWithFormats = (
  value: string,
  formats: string | readonly string[],
): ResolvedTemporal | null => {
  const list = typeof formats === 'string' ? [formats] : formats;

  for (const format of list) {
    const parsed = parseWithFormat(value, format);

    if (parsed) {
      return parsed;
    }
  }

  return null;
};
