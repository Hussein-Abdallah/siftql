import { compileLinear } from '../regex/linear.js';
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
import { fold } from './scalars.js';

/**
 * The two pattern types. Both are token-gated — they claim only their own AST
 * node kind — so neither can ever steal an ordinary term.
 *
 * Both carry a COMPILED matcher as their operand and plain strings as their
 * values, which is exactly why `ValueType` needs two type parameters rather
 * than one.
 */

export interface CompiledWildcard {
  /** Linear-time glob; see {@link matchGlob}. */
  readonly glob: Glob;
  /** The literal segments to underline; see {@link wildcardLiterals}. */
  readonly literals: readonly string[];
  readonly caseSensitive: boolean;
}

/** Anything that can answer "does this value match", statelessly. */
export interface PatternMatcher {
  test(input: string): boolean;
  /**
   * Where the matches are, when the matcher can say.
   *
   * Absent on the `RegExp` fallback used under `regexGuard: false`.
   *
   * There is then NO highlight at all for that clause — not a `RegExp` either.
   * This used to say "the old highlighter is what they get"; that highlighter
   * was deleted in the same change that wrote the sentence, because it was
   * written twice and read nowhere. So a caller who sets `regexGuard: false` to
   * get lookahead silently loses regex highlight positions: the field still
   * reports as matched, with no ranges and no query.
   */
  spans?(
    input: string,
  ): readonly { readonly start: number; readonly end: number }[];
}

export interface CompiledPattern {
  /**
   * Answers "does this value match".
   *
   * Normally the linear-time automaton from `src/regex/linear.ts`, which cannot
   * backtrack whatever the pattern. A `RegExp` only when the caller has set
   * `regexGuard: false` to run a pattern the automaton will not take — a
   * backreference or lookaround — and accepted the risk that comes with it.
   *
   * Either way it NEVER carries `g` or `y`. Those flags make
   * `RegExp.prototype.test` STATEFUL — it advances `lastIndex` between calls —
   * and this matcher is compiled once and reused for every record. With `g` left
   * on, four identical rows return three matches: a silently wrong result, which
   * is the one outcome this package exists to prevent.
   */
  readonly matcher: PatternMatcher;
  readonly caseSensitive: boolean;
}

/*
 * There is deliberately NO `highlighter` here, though there was one until it was
 * found to be written twice and read nowhere.
 *
 * `regexType` reports positions through `highlightSpans`, and spans are data.
 * A compiled `RegExp` over a user's own pattern is the thing that must not
 * escape — running it is the caller's `exec` loop, on the backtracking engine,
 * however fast ours is. Keeping the field cost a `RegExp` compile per operand
 * for nobody, and left a loaded footgun for whoever next added a `highlight`
 * hook to this type.
 */

/** `g`/`y` make `test()` stateful; nothing else about a flag set matters here. */
const forMatching = (flags: string): string =>
  [...new Set(flags)].filter((flag) => flag !== 'g' && flag !== 'y').join('');

/** A wildcard pattern flattened to one token per position. */
type Glob = readonly ('*' | '?' | { readonly ch: string })[];

/**
 * Flatten segments into a token list, folding literals when case-insensitive.
 *
 * Split by code point, not by UTF-16 unit, so `?` matches one CHARACTER and an
 * astral-plane character is never cut in half.
 */
export const compileWildcard = (
  pattern: NonEmptyArray<WildcardSegment>,
  caseSensitive: boolean,
): Glob => {
  const tokens: ('*' | '?' | { ch: string })[] = [];

  for (const segment of pattern) {
    if (segment.type === 'WildcardAny') {
      // Collapse runs: `**` matches exactly what `*` matches, and one star is
      // strictly cheaper to evaluate.
      if (tokens.at(-1) !== '*') {
        tokens.push('*');
      }
    } else if (segment.type === 'WildcardSingle') {
      tokens.push('?');
    } else {
      const literal = caseSensitive ? segment.value : fold(segment.value);

      for (const ch of Array.from(literal)) {
        tokens.push({ ch });
      }
    }
  }

  return tokens;
};

/**
 * Match a value against a glob in LINEAR time.
 *
 * Deliberately NOT a regular expression. Compiling `*a*a*a*b` to
 * `^[\s\S]*a[\s\S]*a[\s\S]*a[\s\S]*b$` contains no nested quantifier and
 * still backtracks catastrophically: when the match FAILS, every star must try
 * every split before the engine can conclude there is none. Measured at 40-50x per
 * added star, and it did not return within five minutes on an ordinary
 * multi-star query against a 200-character value — a denial-of-service surface
 * reachable from any search box.
 *
 * This is the classic two-pointer glob algorithm instead: on a mismatch it
 * rewinds to the LAST star and advances that star by one, which is O(n*m) worst
 * case and O(n) in practice, with no exponential path at all.
 */
export const matchGlob = (value: string, glob: Glob): boolean => {
  const chars = Array.from(value);

  let s = 0;
  let p = 0;
  let starAt = -1;
  let sAtStar = 0;

  while (s < chars.length) {
    const token = glob[p];

    if (
      token !== undefined &&
      (token === '?' || (token !== '*' && token.ch === chars[s]))
    ) {
      s += 1;
      p += 1;
      continue;
    }

    if (token === '*') {
      starAt = p;
      sAtStar = s;
      p += 1;
      continue;
    }

    if (starAt >= 0) {
      // Rewind: let the last star swallow one more character.
      p = starAt + 1;
      sAtStar += 1;
      s = sAtStar;
      continue;
    }

    return false;
  }

  while (glob[p] === '*') {
    p += 1;
  }

  return p === glob.length;
};

/**
 * The parts the user actually typed, longest first.
 *
 * The whole-value matcher is the wrong thing to underline: `*smith*` against
 * "Smithers" would light up the entire cell, telling the reader nothing about
 * WHY it matched. The literal segments are what they searched for, so those are
 * what gets highlighted.
 *
 * Empty for a pattern with no literal segments at all (`*`, `??`): everything
 * matched, so there is no particular part to point at.
 *
 * Folded when the clause is case-insensitive, because these are searched
 * against the folded value — the same string {@link matchGlob} is given.
 */
export const wildcardLiterals = (
  pattern: NonEmptyArray<WildcardSegment>,
  caseSensitive: boolean,
): readonly string[] =>
  pattern
    .filter((segment) => segment.type === 'WildcardLiteral')
    .map((segment) => (caseSensitive ? segment.value : fold(segment.value)))
    .filter((value) => value.length > 0)
    // Longest first, so a short literal cannot claim a position a longer one
    // covers — the same reason the alternation this replaced was sorted.
    .sort((left, right) => right.length - left.length);

export const wildcardType: ValueType<CompiledWildcard, string> =
  defineValueType<CompiledWildcard, string>({
    coerceValue: (value) =>
      typeof value === 'string' ? resolved(value) : MISS,

    equals: (value, operand) =>
      matchGlob(operand.caseSensitive ? value : fold(value), operand.glob),

    /*
     * SPANS, for the reason `stringType` gives at length: a `RegExp` applied by
     * the caller folds differently from `toLowerCase` in both directions, so it
     * underlines characters this type does not match and misses ones it does.
     * Searching the folded value directly makes the two agree by construction.
     *
     * The length guard is what makes the indices addressable at all — `name:*i*`
     * matched "İstanbul" and then pointed at positions that do not exist in it.
     */
    highlightSpans: (value, operand) => {
      const haystack = operand.caseSensitive ? value : fold(value);

      if (haystack.length !== value.length || operand.literals.length === 0) {
        return null;
      }

      const found: { end: number; start: number }[] = [];

      // Longest-literal-first at each position, then skip past it: exactly the
      // non-overlapping, longest-alternative-wins walk the old `(?:ab|a)g`
      // pattern performed.
      for (let at = 0; at < haystack.length; ) {
        const hit = operand.literals.find((literal) =>
          haystack.startsWith(literal, at),
        );

        if (hit === undefined) {
          at += 1;
          continue;
        }

        found.push({ end: at + hit.length, start: at });
        at += hit.length;
      }

      return found.length > 0 ? found : null;
    },

    name: 'wildcard',

    parseOperand: (operand, ctx) => {
      if (operand.kind !== 'wildcard') {
        return DECLINED;
      }

      return claimed({
        caseSensitive: ctx.caseSensitive,
        glob: compileWildcard(operand.pattern, ctx.caseSensitive),
        literals: wildcardLiterals(operand.pattern, ctx.caseSensitive),
      });
    },
  });

/**
 * User-supplied regular expressions.
 *
 * Unlike every other type, the pattern here is arbitrary and can be
 * catastrophically slow: `/^(a+)+$/` against 31 characters hangs the process.
 *
 * The matcher itself lives in `../regex/linear.ts` and is driven by engine
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

  /*
   * No `highlight` hook: a user's own regex is never handed back as a `RegExp`.
   *
   * That was a real hole. Once the automaton accepted patterns the old screen
   * had refused, their highlighters were built and published — and
   * `bio:/^.|(.+)+;/`, nine characters, filtered in 3 ms while taking the
   * consumer's `exec` loop 8.8 seconds on a 30-character value. Spans are data;
   * there is nothing in them to run.
   */
  highlightSpans: (value, operand) => operand.matcher.spans?.(value) ?? null,

  name: 'regex',

  parseOperand: (operand, ctx) => {
    if (operand.kind !== 'regex') {
      return DECLINED;
    }

    if (operand.source.length > ctx.options.maxPatternLength) {
      return malformedOperand(
        `pattern is ${String(operand.source.length)} characters, over the ${String(ctx.options.maxPatternLength)}-character limit`,
        `Shorten the pattern, or raise maxPatternLength (currently ${String(ctx.options.maxPatternLength)}).`,
        'UNSAFE_PATTERN',
      );
    }

    // A regular expression carries its OWN case semantics in its `i` flag, and
    // that is left strictly alone: neither `:` nor `::` adds or removes it.
    // Inferring `i` from the clause would make `name:/^A/` match "ada", which
    // is not what anyone who reached for a regex asked for.
    const flags = operand.flags.join('');

    /*
     * COMPILED TO AN AUTOMATON, not handed to `RegExp`.
     *
     * This is the whole ReDoS answer. `RegExp` backtracks, so a pattern like
     * `^(a|a)*$` takes four seconds on 27 characters and minutes on a few more,
     * with no way to interrupt it — and the pattern comes from whoever is typing
     * in the search box. Three attempts to SCREEN for such patterns were made and
     * all three were bypassable; the last accepted `^(a+){1,99}$` while refusing
     * `^(a+)+$`, and accepted `^((a|a))*$` while refusing `^(a|a)*$`.
     *
     * A linear-time matcher has nothing to bypass. See `src/regex/linear.ts`.
     */
    const linear = compileLinear(operand.source, flags);

    if (linear.ok) {
      return claimed({
        caseSensitive: !operand.flags.includes('i'),
        matcher: linear.matcher,
      });
    }

    /*
     * The automaton could not take it — a backreference, lookaround, or an
     * expansion too large to bound.
     *
     * With the guard ON, that is a refusal. Falling back to `RegExp` by default
     * would mean the one pattern we could not make safe is the one that runs on
     * the unsafe engine, which is exactly backwards.
     *
     * With `regexGuard: false` the caller has said they trust whoever writes the
     * queries, so `RegExp` is used and the risk is theirs — which is what makes
     * lookahead available at all rather than simply unsupported.
     */
    if (ctx.options.regexGuard) {
      return malformedOperand(
        `this pattern uses ${linear.reason}`,
        'Rewrite it without that feature, or set regexGuard: false to run it on the backtracking engine and accept the risk.',
        'UNSAFE_PATTERN',
      );
    }

    try {
      return claimed({
        caseSensitive: !operand.flags.includes('i'),
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
