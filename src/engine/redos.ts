/**
 * Structural screening of user-supplied regular expressions.
 *
 * BE CLEAR ABOUT WHAT THIS IS. It is a HEURISTIC, not a guarantee. Deciding
 * whether an arbitrary backtracking regex is safe is not something you can do
 * reliably in synchronous JavaScript — there is no timeout, no interruption, and
 * no way to bound the engine's work once `test()` is called. A pattern that gets
 * past this screen can still be slow. The README says so in those words.
 *
 * THE ONE THING THAT MAKES BACKTRACKING EXPONENTIAL is an UNBOUNDED repetition
 * over something that can match the same input more than one way. Everything
 * below follows from that sentence, and the previous version of this file got
 * both halves of it wrong:
 *
 *  - It ignored whether a quantifier was bounded, so `^([A-Z]{3}-){1,4}[0-9]{2}$`
 *    was refused. Every quantifier there is bounded, the match tree is finite and
 *    tiny, and it runs in 0.01 ms — while being the ordinary way to write a SKU,
 *    a number plate or any fixed-width id. A false positive rejects a query the
 *    user legitimately wants, which this file already said was the thing to
 *    avoid.
 *  - It looked only for a quantifier inside a quantified group, so it passed
 *    `(a|a)*` — which is not a nested quantifier at all, and blocks the event
 *    loop for four seconds on a 26-character subject. `(a|a?)*` and `(\s|\s)*`
 *    are the same shape. The old comment claimed `?` "cannot drive exponential
 *    backtracking on its own"; `(a|a?)*` falsifies that.
 *
 * So an unbounded repetition is refused when its body offers the engine a
 * choice, in any of three ways:
 *
 *   1. NESTED UNBOUNDED QUANTIFIER — `(a+)+`, `(a*)*`, `(\d+){2,}`. The classic.
 *   2. A BODY THAT CAN MATCH EMPTY — `(a?)*`, `(a|a?)*`, `(|x)*`. The engine can
 *      iterate without consuming, so every position multiplies the search.
 *   3. IDENTICAL ALTERNATION BRANCHES — `(a|a)*`, `(\s|\s)*`. Two ways to match
 *      the same text, at every position.
 *
 * A BOUNDED outer quantifier is not screened at all, because bounded repetition
 * of a finite body is finite work. `(a+){1,4}` can still be polynomial, which is
 * a real cost and not an exponential one; screening it out would cost far more
 * legitimate patterns than it saved.
 *
 * It deliberately still does NOT flag `(a|b)*`, `(cat|car)*` or `(abc)*`.
 * Alternation between branches that are genuinely different is fine.
 */

export interface PatternRisk {
  readonly reason: string;
  readonly hint: string;
}

/**
 * A repetition, above a repetition count large enough to behave like one.
 *
 * `{1,5000}` is bounded in principle and unbounded in practice, so it is treated
 * as unbounded rather than leaving an obvious way around the screen.
 */
const EFFECTIVELY_UNBOUNDED = 1000;

interface Quantifier {
  /** Characters consumed, so the scanner can step over it. */
  readonly length: number;
  /** `*`, `+`, `{n,}` — or a bounded one with an absurd ceiling. */
  readonly unbounded: boolean;
  /** `?`, `*`, `{0,n}` — the repetition may match nothing at all. */
  readonly optional: boolean;
}

/**
 * Read the quantifier at `source[index]`, if there is one.
 *
 * `?` is INCLUDED, unlike the previous version. It cannot drive exponential
 * backtracking as an outer quantifier, but it very much can as an inner one:
 * `(a|a?)*` is catastrophic precisely because the `?` branch can match nothing.
 * Excluding it here made that pattern invisible.
 */
const readQuantifier = (source: string, index: number): Quantifier | null => {
  const character = source.charAt(index);

  if (character === '*') {
    return { length: 1, optional: true, unbounded: true };
  }

  if (character === '+') {
    return { length: 1, optional: false, unbounded: true };
  }

  if (character === '?') {
    return { length: 1, optional: true, unbounded: false };
  }

  if (character !== '{') {
    return null;
  }

  const close = source.indexOf('}', index);
  const body = close > index ? source.slice(index, close + 1) : '';
  const bounds = /^\{(\d*)(?:,(\d*))?\}$/u.exec(body);

  if (!bounds) {
    return null;
  }

  const [, rawMin = '', rawMax] = bounds;
  const min = rawMin === '' ? 0 : Number(rawMin);
  // `{n}` has no comma and means exactly n; `{n,}` has a comma and no ceiling.
  const open = body.includes(',') && (rawMax === undefined || rawMax === '');
  const max = open ? Infinity : rawMax === undefined ? min : Number(rawMax);

  return {
    length: close - index + 1,
    optional: min === 0,
    unbounded: max >= EFFECTIVELY_UNBOUNDED,
  };
};

/**
 * Can this alternation branch match the empty string?
 *
 * Walks it element by element — an escape, a character class, a group, or a
 * single character, each optionally quantified — and answers yes when every
 * element is optional, or there are no elements at all. Nested groups are
 * skipped rather than descended into: a group that must match something makes
 * the branch non-empty regardless of what is inside it, and one that need not is
 * already marked optional by its own quantifier.
 */
const canMatchEmpty = (branch: string): boolean => {
  let index = 0;

  while (index < branch.length) {
    if (branch.charAt(index) === '\\') {
      index += 2;
    } else if (branch.charAt(index) === '[') {
      const close = branch.indexOf(']', index + 1);

      index = close === -1 ? branch.length : close + 1;
    } else if (branch.charAt(index) === '(') {
      let depth = 1;

      index += 1;

      while (index < branch.length && depth > 0) {
        const character = branch.charAt(index);

        if (character === '\\') {
          index += 1;
        } else if (character === '(') {
          depth += 1;
        } else if (character === ')') {
          depth -= 1;
        }

        index += 1;
      }
    } else if ('^$'.includes(branch.charAt(index))) {
      // An anchor consumes nothing, so it never makes a branch non-empty.
      index += 1;
      continue;
    } else {
      index += 1;
    }

    const quantifier = readQuantifier(branch, index);

    if (!quantifier?.optional) {
      return false;
    }

    index += quantifier.length;
  }

  return true;
};

/** Split on `|` at depth zero, ignoring escapes and character classes. */
const topLevelBranches = (body: string): string[] => {
  const branches: string[] = [];

  let depth = 0;
  let inClass = false;
  let start = 0;
  let index = 0;

  while (index < body.length) {
    const character = body.charAt(index);

    if (character === '\\') {
      index += 2;
      continue;
    }

    if (inClass) {
      inClass = character !== ']';
    } else if (character === '[') {
      inClass = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === '|' && depth === 0) {
      branches.push(body.slice(start, index));
      start = index + 1;
    }

    index += 1;
  }

  branches.push(body.slice(start));

  return branches;
};

/** Two branches offering the engine the same match at the same position. */
const hasDuplicateBranch = (branches: readonly string[]): boolean => {
  const seen = new Set<string>();

  for (const branch of branches) {
    const normalised = branch.trim();

    if (seen.has(normalised)) {
      return true;
    }

    seen.add(normalised);
  }

  return false;
};

interface GroupFrame {
  /** True once an UNBOUNDED quantifier is seen at this nesting level. */
  unbounded: boolean;
  /** Index just after the `(`, so the body can be sliced when it closes. */
  bodyStart: number;
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
      index += 1;

      // Skip a group prefix — `?:`, `?<name>`, `?=`, `?!`, `?<=`, `?<!` — so the
      // `?` in it is never read as a quantifier.
      if (source.startsWith('?', index)) {
        const prefix = /^\?(?::|<[A-Za-z_$][\w$]*>|<?[=!])/u.exec(
          source.slice(index),
        );

        index += prefix?.[0].length ?? 1;
      }

      stack.push({ bodyStart: index, unbounded: false });
      continue;
    }

    if (character === ')') {
      const closed = stack.pop();
      const body = closed ? source.slice(closed.bodyStart, index) : '';

      index += 1;

      const quantifier = readQuantifier(source, index);
      const repeated = quantifier !== null;

      // Only an UNBOUNDED repetition can turn a choice into exponential work.
      // Bounded repetition of a finite body is finite, however deeply nested.
      if (quantifier?.unbounded === true) {
        if (closed?.unbounded === true) {
          return {
            hint: 'Rewrite so no unbounded group contains another unbounded quantifier, e.g. `(a+)+` as `a+`.',
            reason:
              'nested quantifier: an unbounded group that itself repeats without bound can backtrack exponentially',
          };
        }

        const branches = topLevelBranches(body);

        if (branches.some((branch) => canMatchEmpty(branch))) {
          return {
            hint: 'Make the repeated part consume at least one character, e.g. `(a?)*` as `a*`.',
            reason:
              'a repeated group that can match nothing lets the engine iterate without consuming input',
          };
        }

        if (hasDuplicateBranch(branches)) {
          return {
            hint: 'Remove the duplicate alternative, e.g. `(a|a)*` as `a*`.',
            reason:
              'a repeated group with two identical alternatives can match the same text two ways at every position',
          };
        }
      }

      // Propagate upward, even when this group carries no quantifier of its own —
      // otherwise `((a+))+` slips through, because the inner group closes
      // unquantified and the outer one looks clean.
      if (
        stack.length > 0 &&
        (closed?.unbounded === true || quantifier?.unbounded === true)
      ) {
        const parent = stack[stack.length - 1];

        if (parent) {
          parent.unbounded = true;
        }
      }

      index += repeated ? quantifier.length : 0;
      continue;
    }

    const quantifier = readQuantifier(source, index);

    if (quantifier) {
      const frame = stack.at(-1);

      if (frame && quantifier.unbounded) {
        frame.unbounded = true;
      }

      index += quantifier.length;
      continue;
    }

    index += 1;
  }

  return null;
};
