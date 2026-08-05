/**
 * Structural screening of user-supplied regular expressions.
 *
 * BE CLEAR ABOUT WHAT THIS IS. It is a HEURISTIC, not a guarantee. Deciding
 * whether an arbitrary backtracking regex is safe is not something you can do
 * reliably in synchronous JavaScript — there is no timeout, no interruption, and
 * no way to bound the engine's work once `test()` is called. A pattern that gets
 * past this screen can still be slow. The README says so in those words.
 *
 * What it does catch is the shape behind essentially every real ReDoS report: a
 * QUANTIFIED GROUP THAT ITSELF CONTAINS A QUANTIFIER — `(a+)+`, `(a*)*`,
 * `(\d+){2,}` — where the engine can partition the same input exponentially many
 * ways. `/^(a+)+$/` against 31 characters hangs a process indefinitely.
 *
 * It deliberately does NOT flag `(a|b)*` or `(abc)*`. Alternation of disjoint
 * branches is fine, and refusing it would break ordinary queries to guard
 * against a case this screen cannot see anyway. Precision matters more than
 * recall here: a false positive rejects a query the user legitimately wants.
 *
 * WILDCARDS ARE NOT EXEMPT, despite emitting no nested quantifier. Several
 * `[\s\S]*` separated by literals partition the input exponentially when the
 * match FAILS, because every star must try every split before the engine can
 * conclude there is none:
 *
 *     value: 40 "a"s          *a*a*a*b        2.5ms
 *                             *a*a*a*a*a*b     36ms
 *                             *a*a*a*a*a*a*b  190ms
 *                             *a*a*a*a*a*a*a*b 852ms      ~6x per star
 *
 * A benchmark that only measures MATCHING patterns misses this entirely —
 * `*a*a*a*a*` succeeds greedily on the first attempt and never backtracks,
 * which is exactly how the exemption came to be believed in the first place.
 */

export interface PatternRisk {
  readonly reason: string;
  readonly hint: string;
}

/**
 * Is `source[index]` the start of a quantifier? Returns its length, or 0.
 *
 * `?` is excluded: it cannot drive exponential backtracking on its own, and
 * treating it as one would flag the common and harmless `(ab)?`.
 */
const quantifierLength = (source: string, index: number): number => {
  const character = source.charAt(index);

  if (character === '*' || character === '+') {
    return 1;
  }

  if (character === '{') {
    const close = source.indexOf('}', index);

    if (
      close > index &&
      /^\{\d*(?:,\d*)?\}$/u.test(source.slice(index, close + 1))
    ) {
      return close - index + 1;
    }
  }

  return 0;
};

interface GroupFrame {
  /** True once an unescaped quantifier is seen at this nesting level. */
  quantified: boolean;
}

/**
 * Screen a pattern, returning why it was refused or `null` if it passed.
 */
export const assessPattern = (
  source: string,
  maxLength: number,
): PatternRisk | null => {
  if (source.length > maxLength) {
    return {
      hint: `Shorten the pattern, or raise maxPatternLength (currently ${String(maxLength)}).`,
      reason: `pattern is ${String(source.length)} characters, over the ${String(maxLength)}-character limit`,
    };
  }

  const stack: GroupFrame[] = [];

  let inCharacterClass = false;
  let index = 0;

  while (index < source.length) {
    const character = source.charAt(index);

    // A backslash protects the next character, so neither can be structural.
    if (character === '\\') {
      index += 2;
      continue;
    }

    // Inside [...] a quantifier is a literal character, not an operator.
    if (inCharacterClass) {
      if (character === ']') {
        inCharacterClass = false;
      }

      index += 1;
      continue;
    }

    if (character === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }

    if (character === '(') {
      stack.push({ quantified: false });
      index += 1;
      continue;
    }

    if (character === ')') {
      const closed = stack.pop();
      const bodyQuantified = closed?.quantified ?? false;

      index += 1;

      const length = quantifierLength(source, index);
      const selfQuantified = length > 0;

      // A quantified group whose body was itself quantified is the shape.
      if (selfQuantified && bodyQuantified) {
        return {
          hint: 'Rewrite so no quantified group contains another quantifier, e.g. `(a+)+` as `a+`.',
          reason:
            'nested quantifier: a repeated group that itself repeats can backtrack exponentially',
        };
      }

      // The enclosing group's body now contains a quantifier if this group held
      // one OR is itself repeated — and it must propagate even when this group
      // carries no quantifier of its own, or `((a+))+` slips through: the inner
      // group closes unquantified and the outer one looks clean.
      if (stack.length > 0 && (bodyQuantified || selfQuantified)) {
        stack[stack.length - 1] = { quantified: true };
      }

      index += length;
      continue;
    }

    const length = quantifierLength(source, index);

    if (length > 0) {
      const frame = stack.at(-1);

      if (frame) {
        stack[stack.length - 1] = { quantified: true };
      }

      index += length;
      continue;
    }

    index += 1;
  }

  return null;
};
