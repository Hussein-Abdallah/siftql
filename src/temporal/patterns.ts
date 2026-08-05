/**
 * Canonical temporal shapes recognised by the built-in parser.
 *
 * These regexes validate *shape and component range only* — month 01-12, day
 * 01-31, hour 00-23, minute/second 00-59. They deliberately do not know that
 * February has fewer than 31 days; full calendar validation happens during
 * resolution (see `./calendar.ts`). Keeping the two separate is what lets
 * `date:>=2021-02-29` be recognised as *intended* as a date and therefore fail
 * loudly, rather than falling through to string comparison.
 *
 * Named capture groups are used throughout so the parser reads by name instead
 * of by fragile positional index.
 */

const YEAR = String.raw`(?<year>\d{4})`;
const MONTH = String.raw`(?<month>0[1-9]|1[0-2])`;
const DAY = String.raw`(?<day>0[1-9]|[12]\d|3[01])`;

const HOUR = String.raw`(?<hour>[01]\d|2[0-3])`;
const MINUTE = String.raw`(?<minute>[0-5]\d)`;
/**
 * Seconds, and the fractional part that may follow THEM.
 *
 * The fraction is nested inside the seconds group on purpose. In ISO 8601 a
 * fraction attaches to the lowest-order component present, so `12:30.5` means
 * thirty and a half MINUTES — 12:30:30 — not 12:30:00.500. Accepting it at the
 * minute position and reading it as milliseconds is a silent 29.5-second error,
 * so the shape is simply not recognised: a fraction requires seconds.
 *
 * Any number of digits is accepted; resolution truncates to millisecond
 * precision, which is all a JS time value can represent. A comma is accepted as
 * the decimal mark because ISO 8601 permits it.
 */
const SECOND = String.raw`(?::(?<second>[0-5]\d)(?:[.,](?<fraction>\d+))?)?`;

/**
 * `Z`/`z`, or a numeric offset as `+HH:mm`, `+HHmm`, or `+HH`.
 * Absent means the value is naive — see `./iso.ts` for how that is treated.
 */
const OFFSET = String.raw`(?<offset>[Zz]|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?`;

/**
 * `YYYY-MM-DD`, or `YYYY/MM/DD`. The back-reference on the separator means a
 * mixed form such as `2020-06/01` is rejected rather than quietly accepted.
 */
export const ISO_DATE = new RegExp(
  `^${YEAR}(?<sep>[-/])${MONTH}\\k<sep>${DAY}$`,
  'u',
);

/**
 * `YYYY-MM-DDTHH:mm[:ss][.sss][Z|±HH:mm]`.
 *
 * A space is accepted in place of `T` because SQL-flavoured datetimes
 * (`2020-06-01 12:00:00`) are pervasive in real field values. Note that a bare
 * space form must still be quoted when written in a query, since the tokenizer
 * splits on whitespace.
 */
export const ISO_DATE_TIME = new RegExp(
  `^${YEAR}(?<sep>[-/])${MONTH}\\k<sep>${DAY}[Tt ]${HOUR}:${MINUTE}${SECOND}${OFFSET}$`,
  'u',
);

/** 24-hour wall-clock time, `HH:mm[:ss][.sss]`, with no date and no offset. */
export const ISO_TIME = new RegExp(`^${HOUR}:${MINUTE}${SECOND}$`, 'u');
