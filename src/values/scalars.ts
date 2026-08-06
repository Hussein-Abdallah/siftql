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

  /*
   * SPANS, not a pattern, because no `RegExp` expresses what this type matches.
   *
   * Matching folds with `toLowerCase`. A highlight `RegExp` is applied by the
   * CALLER to the raw value under RegExp's own case rules, and those two fold
   * differently in BOTH directions:
   *
   *   - `/s/iu` matches `ſ`, which `toLowerCase` leaves alone, so the caller
   *     underlined a character this type does not match.
   *   - `toLowerCase` maps the Kelvin sign to `k`, which `/k/i` refuses — so
   *     dropping `u` would just trade over-marking for under-marking.
   *
   * Computing the positions here settles it: the search runs on exactly the
   * folded string `matches` compares, so a span is reported if and only if this
   * type says the value matched there.
   *
   * The length guard remains, and is why the indices are meaningful at all:
   * `'İ'.toLowerCase()` is TWO code points, so positions in the folded string
   * would not address the original. There is then no span that is both correct
   * and expressible, so none is offered — the path is still reported, the field
   * DID match, exactly as for a range or a boolean.
   */
  highlightSpans: (value, operand, ctx) => {
    const haystack = operand.caseSensitive ? value : fold(value);

    if (haystack.length !== value.length) {
      return null;
    }

    // Not a scan: `:` on a fielded clause and `:=` are both whole-value equality,
    // so the span is the whole value or there is none.
    if (ctx.site.kind !== 'scan') {
      return haystack === operand.needle
        ? [{ end: value.length, start: 0 }]
        : null;
    }

    if (operand.needle.length === 0) {
      return null;
    }

    const found: { end: number; start: number }[] = [];

    for (
      let at = haystack.indexOf(operand.needle);
      at !== -1;
      at = haystack.indexOf(operand.needle, at + operand.needle.length)
    ) {
      found.push({ end: at + operand.needle.length, start: at });
    }

    return found.length > 0 ? found : null;
  },

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
/**
 * Decimal forms only.
 *
 * `Number()` also accepts `0x10`, `0b10`, `0o10`, `Infinity` and `NaN`, so a
 * FIELD holding the string `'0x10'` was being read as the number 16 and matched
 * by the query `code:16`. Data is not JavaScript source; a stored string is
 * digits, not a literal.
 */
/*
 * WRITTEN UNAMBIGUOUSLY, and that is not a style preference.
 *
 * The previous spelling was `(?:\d+\.?\d*|\.\d+)`, whose first alternative can
 * split a run of digits two ways — `\d+` then an optional `\.` then `\d*`. On a
 * long digit run followed by a non-digit, the engine has to try every split
 * before it can report no match, which is quadratic: 60,000 digits took 2.8
 * seconds, and a `filter` over 200 such rows took ten.
 *
 * That is a ReDoS with the guard switched on, because the guard screens QUERY
 * patterns and this one runs against DATA. `regexGuard` and `maxPatternLength`
 * cannot help; only not writing the pattern that way can.
 *
 * `\d+(?:\.\d*)?` forces the decimal point to be consumed by exactly one branch,
 * so there is nothing to backtrack over. Byte-identical acceptance on every
 * spelling tested; 60,000 digits went from 2,802 ms to 0.12 ms.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

const parseNumeric = (text: string): number | null => {
  if (text.trim() !== text || text.length === 0 || !DECIMAL.test(text)) {
    return null;
  }

  const parsed = Number(text);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  /*
   * Refuse only integers the double ACTUALLY collapses.
   *
   * `Number('1234567890123456789')` and `Number('1234567890123456780')` are the
   * same double, so an id search would return two visibly different records and
   * call them equal. Snowflake ids, database bigints and account numbers all
   * live here and all arrive as JSON strings.
   *
   * The test is exactness, not `Number.isSafeInteger`. Plenty of integers above
   * 2^53 are still exactly representable -- 2^53 itself, and every power of two
   * above it -- and refusing those made them unmatchable against a field
   * genuinely holding that number, with no diagnostic at any setting.
   *
   * Compared as BIGINTS rather than as strings. `String(parsed) !== text` looks
   * like a round trip and is really a test for CANONICAL SPELLING, so it refused
   * every integer written any other way: `n:007` did not match 7, `n:-0` did not
   * match 0, and because the token then fell through to `string`, `n:>007` did
   * not merely fail to match — it THREW, since `string` has no ordering. Leading
   * zeros arrive from forms, URLs, zero-padded ids and CSV columns constantly.
   * `007` is exactly representable as a double, so the only honest question is
   * whether the value survives the conversion, which is what comparing the
   * integers rather than their spellings asks.
   *
   * Declining rather than erroring is what makes the refusal safe: the token
   * falls through to `string`, which compares the digits exactly. Only ordering
   * is lost, and no order is better than a wrong one.
   */
  if (/^[+-]?\d+$/u.test(text)) {
    if (!Number.isFinite(parsed)) {
      return null;
    }

    // BigInt(parsed), not BigInt(String(parsed)): above 1e21 the string form is
    // exponential and BigInt refuses to parse it.
    if (BigInt(text.replace(/^\+/u, '')) !== BigInt(parsed)) {
      return null;
    }
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

/**
 * The ONE case-folding rule, used by every built-in.
 *
 * `toLowerCase()` and a RegExp `i` flag do not agree on every code point:
 * `'İ'.toLowerCase()` is two code points (i + combining dot above) while `/i/iu`
 * folds it to a single `i`. Exact matching used the former and pattern matching
 * the latter, so `test()` and `highlight()` could disagree about the same text
 * -- a highlight was emitted whose pattern then matched nothing.
 */
export const fold = (value: string): string => value.toLowerCase();
