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

type CompiledFormat = {
  readonly kind: 'date' | 'datetime' | 'time';
  readonly regex: RegExp;
};

/**
 * A malformed layout is a programming error in the host application, not bad
 * user input, so it is reported immediately and loudly rather than degrading to
 * "nothing matches".
 */
export class InvalidDateFormatError extends TypeError {
  public constructor(format: string, reason: string) {
    super(`Invalid dateFormat ${JSON.stringify(format)}: ${reason}`);
    this.name = 'InvalidDateFormatError';
  }
}

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
        throw new InvalidDateFormatError(
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
    throw new InvalidDateFormatError(
      format,
      'a calendar layout must include all of YYYY, MM and DD',
    );
  }

  if (!hasDateParts && !hasClockParts) {
    throw new InvalidDateFormatError(
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
