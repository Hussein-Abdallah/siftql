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
  readonly matcher: RegExp;
  readonly caseSensitive: boolean;
}

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

export const wildcardType: ValueType<CompiledPattern, string> = defineValueType<
  CompiledPattern,
  string
>({
  coerceValue: (value) => (typeof value === 'string' ? resolved(value) : MISS),

  equals: (value, operand) => operand.matcher.test(value),

  highlight: (_value, operand) => operand.matcher,

  name: 'wildcard',

  parseOperand: (operand, ctx) => {
    if (operand.kind !== 'wildcard') {
      return DECLINED;
    }

    return claimed({
      caseSensitive: ctx.caseSensitive,
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

  highlight: (_value, operand) => operand.matcher,

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
    try {
      return claimed({
        caseSensitive: !operand.flags.includes('i'),
        matcher: new RegExp(operand.source, operand.flags.join('')),
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
