import {
  claimed,
  DECLINED,
  defineValueType,
  MISS,
  malformedValue,
  resolved,
  type ValueType,
} from '../registry.js';

/**
 * The token-gated and text-claiming scalar built-ins.
 *
 * Every one is an ordinary registration. The engine has no branch for any of
 * them, which is the whole point of the registry: a consumer's `semver` or `ip`
 * type is a first-class citizen registered exactly the same way.
 *
 * COERCION CONVENTION, obeyed here and documented for authors:
 *   MISS    — wrong JS shape (a boolean reaching `datetime`). Never an error.
 *   INVALID — right shape, wrong content (the string 'n/a' reaching `datetime`).
 *             Governed by `onValueError`, so dirty data is a policy decision.
 */

/* ------------------------------------------------------------------------- *
 * string — the total claimer, deliberately UNORDERED
 * ------------------------------------------------------------------------- */

export interface StringOperand {
  /** Folded for comparison: lower-cased unless the clause used `::`. */
  readonly needle: string;
  readonly caseSensitive: boolean;
}

/**
 * `string` claims every text operand, so it must be last in the resolution
 * order — anything after it would be unreachable.
 *
 * It has NO `ordering`, and that absence is load-bearing: it is the single fact
 * that makes `name:>="m"` throw. Free text has no defensible ordering (is "10"
 * before "9"?), so rather than inventing one, the type simply does not support
 * the operators, and the engine reports that structurally.
 *
 * `matches` is omitted too, so `:` and `:=` agree. That is the whole-value
 * equality decision expressed in one place for FIELDED clauses: containment is
 * spelled with wildcards (`name:*foo*`), never implied by `:`.
 *
 * An UNFIELDED term is the deliberate exception, and `matches` is where that
 * lives. The two forms express different intents:
 *
 *   name:ada   you named a field, so you are being precise  -> exact
 *   ada        you named nothing, so you are browsing       -> contains
 *
 * Without that split, a person typing one word into a search box gets an empty
 * screen, because no stored value is ever exactly "ada". With it, `status:active`
 * still refuses to match "inactive" -- looseness is confined to the case where
 * the user gave no field to be precise about.
 */
export const stringType: ValueType<StringOperand, string> = defineValueType<
  StringOperand,
  string
>({
  coerceValue: (value) => (typeof value === 'string' ? resolved(value) : MISS),

  // Always exact. Reached by `:=`, by range boundaries, and by `:` on a fielded
  // clause. An unfielded term cannot ask for exact equality -- the grammar has
  // no unfielded relational operator -- so a regex is the escape hatch there.
  equals: (value, operand) =>
    (operand.caseSensitive ? value : value.toLowerCase()) === operand.needle,

  highlight: (_value, operand, ctx) =>
    new RegExp(
      ctx.site.kind === 'scan'
        ? escapeRegExp(operand.needle)
        : `^${escapeRegExp(operand.needle)}$`,
      operand.caseSensitive ? 'gu' : 'giu',
    ),

  /**
   * `:` — exact when a field was named, containment when one was not.
   * A scan is always case-insensitive, since an unfielded term has no operator
   * to double.
   */
  matches: (value, operand, ctx) => {
    const folded = operand.caseSensitive ? value : value.toLowerCase();

    return ctx.site.kind === 'scan'
      ? folded.includes(operand.needle)
      : folded === operand.needle;
  },

  name: 'string',

  parseOperand: (operand, ctx) => {
    if (operand.kind !== 'text') {
      return DECLINED;
    }

    return claimed({
      caseSensitive: ctx.caseSensitive,
      needle: ctx.caseSensitive ? operand.text : operand.text.toLowerCase(),
    });
  },
});

/* ------------------------------------------------------------------------- *
 * number
 * ------------------------------------------------------------------------- */

/**
 * Accepts a bare numeric operand only. A QUOTED `"100"` is a string by
 * construction — that is what quoting is for — so `code:"007"` compares as text
 * and keeps its leading zeros.
 */
const parseNumeric = (text: string): number | null => {
  if (text.trim() !== text || text.length === 0) {
    return null;
  }

  const parsed = Number(text);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  /*
   * Refuse anything a double cannot hold exactly.
   *
   * `Number('1234567890123456789')` and `Number('1234567890123456780')` are the
   * SAME double, so an id search would return two visibly different records and
   * report both as equal. Snowflake ids, database bigints and account numbers
   * all live here and all arrive as JSON strings.
   *
   * Declining rather than erroring is what makes this safe: the token falls
   * through to `string`, which compares the digits exactly and gets the right
   * answer. Only ordering is lost, and a wrong order is worse than none.
   */
  if (!Number.isSafeInteger(parsed) && /^[+-]?\d+$/u.test(text)) {
    return null;
  }

  return parsed;
};

export const numberType: ValueType<number, number> = defineValueType<
  number,
  number
>({
  coerceValue: (value) => {
    if (typeof value === 'number') {
      // NaN and Infinity are the right SHAPE with impossible content.
      return Number.isFinite(value)
        ? resolved(value)
        : malformedValue('not a finite number');
    }

    if (typeof value === 'string') {
      const parsed = parseNumeric(value);

      // Numeric strings are common in JSON and CSV-derived data, so they are
      // accepted; text that is not numeric is simply the wrong domain.
      return parsed === null ? MISS : resolved(parsed);
    }

    return MISS;
  },

  equals: (value, operand) => value === operand,

  name: 'number',

  ordering: {
    compare: (value, operand) => value - operand,
  },

  parseOperand: (operand) => {
    if (operand.kind !== 'text' || operand.quoted) {
      return DECLINED;
    }

    const parsed = parseNumeric(operand.text);

    return parsed === null ? DECLINED : claimed(parsed);
  },
});

/* ------------------------------------------------------------------------- *
 * boolean and null — token-gated, so they can never swallow a quoted keyword
 * ------------------------------------------------------------------------- */

export const booleanType: ValueType<boolean, boolean> = defineValueType<
  boolean,
  boolean
>({
  coerceValue: (value) => (typeof value === 'boolean' ? resolved(value) : MISS),

  equals: (value, operand) => value === operand,

  highlight: () => null,

  name: 'boolean',

  parseOperand: (operand) =>
    operand.kind === 'boolean' ? claimed(operand.value) : DECLINED,
});

export const nullType: ValueType<null, null> = defineValueType<null, null>({
  // `undefined` counts: a key that is absent and a key explicitly set to null
  // are the same answer to "is this field empty?".
  coerceValue: (value) =>
    value === null || value === undefined ? resolved(null) : MISS,

  equals: () => true,

  highlight: () => null,

  name: 'null',

  parseOperand: (operand) =>
    operand.kind === 'null' ? claimed(null) : DECLINED,
});

/** Shared by the pattern types below. */
export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
