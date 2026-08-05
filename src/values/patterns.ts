import { assessPattern } from '../engine/redos.js';
import {
  claimed,
  DECLINED,
  defineValueType,
  malformedOperand,
  MISS,
  resolved,
  type ValueType,
} from '../registry.js';
import type { NonEmptyArray, WildcardSegment } from '../types.js';
import { escapeRegExp } from './scalars.js';

/**
 * The two pattern types. Both are token-gated — they claim only their own AST
 * node kind — so neither can ever steal an ordinary term.
 *
 * Both carry a COMPILED matcher as their operand and plain strings as their
 * values, which is exactly why `ValueType` needs two type parameters rather
 * than one.
 */

export interface CompiledPattern {
  /**
   * Answers "does this value match". NEVER carries `g` or `y`.
   *
   * Those flags make `RegExp.prototype.test` STATEFUL — it advances
   * `lastIndex` between calls — and this matcher is compiled once and reused
   * for every record. With `g` left on, four identical rows return three
   * matches: a silently wrong result, which is the one outcome this package
   * exists to prevent.
   */
  readonly matcher: RegExp;
  /**
   * Answers "which part of the value to underline", or `null` when there is
   * nothing meaningful to point at. Unanchored and global, because a UI wants
   * every occurrence of the term, not the whole field.
   */
  readonly highlighter: RegExp | null;
  readonly caseSensitive: boolean;
}

/** `g`/`y` make `test()` stateful; nothing else about a flag set matters here. */
const forMatching = (flags: string): string =>
  [...new Set(flags)].filter((flag) => flag !== 'g' && flag !== 'y').join('');

/** A highlight wants every occurrence, so it always gets `g`. */
const forHighlighting = (flags: string): string =>
  [...new Set(`${forMatching(flags)}g`)].join('');

/**
 * Translate pre-segmented wildcard segments into an anchored RegExp.
 *
 * Anchored because a wildcard pattern describes the WHOLE value: `name:foo*`
 * means "starts with foo", not "contains foo followed by something". Getting
 * this wrong is how `foo*` ends up matching `xx foo xx`.
 *
 * Literal segments arrive with escapes already resolved, so an escaped `\*` is
 * an ordinary character here and is regex-escaped like any other. The generated
 * source contains only `.*`, `.` and escaped literals — no nested quantifiers —
 * so it cannot backtrack catastrophically no matter what the user typed.
 */
export const compileWildcard = (
  pattern: NonEmptyArray<WildcardSegment>,
  caseSensitive: boolean,
): RegExp => {
  const source = pattern
    .map((segment) => {
      switch (segment.type) {
        case 'WildcardAny':
          return '[\\s\\S]*';
        case 'WildcardSingle':
          return '[\\s\\S]';
        default:
          return escapeRegExp(segment.value);
      }
    })
    .join('');

  return new RegExp(`^${source}$`, caseSensitive ? 'u' : 'iu');
};

/**
 * A pattern that finds the parts the user actually typed.
 *
 * The whole-value matcher is the wrong thing to underline: `*smith*` against
 * "Smithers" would light up the entire cell, telling the reader nothing about
 * WHY it matched. The literal segments are what they searched for, so those are
 * what gets highlighted.
 *
 * Returns `null` for a pattern with no literal segments at all (`*`, `??`):
 * everything matched, so there is no particular part to point at.
 */
export const compileWildcardHighlighter = (
  pattern: NonEmptyArray<WildcardSegment>,
  caseSensitive: boolean,
): RegExp | null => {
  const literals = pattern
    .filter((segment) => segment.type === 'WildcardLiteral')
    .map((segment) => segment.value)
    .filter((value) => value.length > 0);

  if (literals.length === 0) {
    return null;
  }

  // Longest first, so `ab|a` cannot match the short alternative and stop early.
  const alternatives = [...literals]
    .sort((left, right) => right.length - left.length)
    .map((value) => escapeRegExp(value))
    .join('|');

  return new RegExp(`(?:${alternatives})`, caseSensitive ? 'gu' : 'giu');
};

export const wildcardType: ValueType<CompiledPattern, string> = defineValueType<
  CompiledPattern,
  string
>({
  coerceValue: (value) => (typeof value === 'string' ? resolved(value) : MISS),

  equals: (value, operand) => operand.matcher.test(value),

  highlight: (_value, operand) => operand.highlighter,

  name: 'wildcard',

  parseOperand: (operand, ctx) => {
    if (operand.kind !== 'wildcard') {
      return DECLINED;
    }

    return claimed({
      caseSensitive: ctx.caseSensitive,
      highlighter: compileWildcardHighlighter(
        operand.pattern,
        ctx.caseSensitive,
      ),
      matcher: compileWildcard(operand.pattern, ctx.caseSensitive),
    });
  },
});

/**
 * User-supplied regular expressions.
 *
 * Unlike every other type, the pattern here is arbitrary and can be
 * catastrophically slow: `/^(a+)+$/` against 31 characters hangs the process.
 *
 * The screen itself lives in `../engine/redos.ts` and is driven by engine
 * OPTIONS rather than by this type, because whether to accept a risky pattern
 * is a deployment policy — a trusted internal tool and a public search box want
 * different answers — and not a rule about how a regex matches.
 */
export const regexType: ValueType<CompiledPattern, string> = defineValueType<
  CompiledPattern,
  string
>({
  coerceValue: (value) => (typeof value === 'string' ? resolved(value) : MISS),

  // Unanchored on purpose: `/foo/` means "contains foo", matching every other
  // regex engine. Anchoring is the author's job with ^ and $.
  equals: (value, operand) => operand.matcher.test(value),

  highlight: (_value, operand) => operand.highlighter,

  name: 'regex',

  parseOperand: (operand, ctx) => {
    if (operand.kind !== 'regex') {
      return DECLINED;
    }

    if (ctx.options.regexGuard) {
      const risk = assessPattern(operand.source, ctx.options.maxPatternLength);

      if (risk) {
        // A refused pattern stops resolution and is reported. Falling through
        // to `string` would silently turn a regex query into a literal one.
        return malformedOperand(risk.reason, risk.hint);
      }
    }

    // A regular expression carries its OWN case semantics in its `i` flag, and
    // that is left strictly alone: neither `:` nor `::` adds or removes it.
    // Inferring `i` from the clause would make `name:/^A/` match "ada", which
    // is not what anyone who reached for a regex asked for.
    const flags = operand.flags.join('');

    try {
      return claimed({
        caseSensitive: !operand.flags.includes('i'),
        // The user's own pattern is already the thing to underline.
        highlighter: new RegExp(operand.source, forHighlighting(flags)),
        matcher: new RegExp(operand.source, forMatching(flags)),
      });
    } catch (error) {
      // A pattern the engine cannot compile is a broken QUERY, so it stops
      // resolution and is reported, never silently skipped.
      return malformedOperand(
        error instanceof Error ? error.message : 'invalid regular expression',
        'check the pattern syntax',
      );
    }
  },
});
