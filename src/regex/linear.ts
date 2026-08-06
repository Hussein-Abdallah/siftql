/**
 * A regular-expression matcher that cannot backtrack.
 *
 * WHY THIS EXISTS. JavaScript's `RegExp` is a BACKTRACKING engine: for certain
 * patterns the number of ways to match a string grows exponentially with its
 * length, and on a FAILING match it must try all of them before it can answer.
 * `test()` is uninterruptible, so the process is simply gone —
 * `/^(a|a)*$/.test('a'.repeat(27) + 'b')` blocks for four seconds, and a few
 * more characters make it minutes. siftql accepts `field:/regex/` from whoever
 * is typing in the search box, so that is a denial of service with a
 * twelve-character payload.
 *
 * Three attempts were made to SCREEN for dangerous patterns — decide, by looking
 * at the source, whether it might blow up. All three failed, and the third
 * failed worst: it refused `^(a+)+$` while accepting `^(a+){1,99}$`, and refused
 * `^(a|a)*$` while accepting `^((a|a))*$`, which is the same pattern with one
 * redundant parenthesis. Screening is the wrong shape of solution. Deciding
 * whether an arbitrary backtracking regex is safe is a research problem, and a
 * heuristic at a security boundary is bypassed by whoever cares to try.
 *
 * SO THERE IS NOTHING TO BYPASS. This matcher simulates the pattern as a
 * NONDETERMINISTIC FINITE AUTOMATON: instead of trying one path and backing up,
 * it walks the input ONCE, left to right, holding every position the pattern
 * could be in at the same time. Cost is `O(pattern × input)` for every pattern
 * that exists. `^(a|a)*$` still has 2ⁿ ways to match; we never enumerate them,
 * because we track WHICH states are live, not HOW we reached them.
 *
 * This is Thompson's construction with a Pike VM, and it is what `grep`, RE2,
 * Rust's `regex` and Go's `regexp` all do. It is not novel or clever; it is the
 * standard answer, and the only reason to hand-roll it here is the zero-runtime-
 * dependency promise.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED: backreferences and lookaround. Matching a
 * backreference in linear time is impossible — the problem is NP-hard, which is
 * why RE2 and Rust refuse them too. Rather than fall back to `RegExp` and
 * reintroduce the hazard through a side door, a pattern using either is REFUSED,
 * with a message saying so. A refusal a caller can read beats a hang they
 * cannot.
 *
 * The package already made this exact move once: wildcards used to compile to
 * regexes and blew up the same way, and replacing them with a two-pointer
 * matcher is why `name:*a*a*a*b` is now flat at 0.02 ms.
 */

/* ------------------------------------------------------------------------- *
 * Limits
 * ------------------------------------------------------------------------- */

/**
 * Most instructions a compiled pattern may occupy.
 *
 * The VM is `O(program × input)`, so the program has to be bounded for the time
 * bound to mean anything. Counted repetitions are compiled by DUPLICATION —
 * `a{3}` is three copies — so `(a{1,99}){1,99}` is about 9,800 instructions and
 * `a{1000}{1000}` is a million.
 *
 * A pattern that exceeds it is refused, not silently truncated.
 *
 * BOUNDING THE COUNT OF STEPS IS NOT ENOUGH ON ITS OWN, which is a mistake this
 * file made for a whole release cycle: the comment here used to promise "tens of
 * milliseconds on a long value" and `[^\s×490]{900}` with `i` took 45 seconds
 * inside `test()` at stock settings. Every step was counted; no step's COST was.
 * A character class could hold thousands of ranges scanned linearly, and the
 * case-fold closure was recomputed per character per instruction. So a step is
 * now bounded too — see {@link MAX_CLASS_RANGES}, the binary search in
 * {@link inRanges}, and the memo tables under {@link canonicalize} — and the
 * claim above is measured rather than asserted.
 */
const MAX_PROGRAM = 4000;

/** Longest counted repetition, so `a{1000000}` fails fast rather than slowly. */
const MAX_REPEAT = 1000;

/**
 * Most DISJOINT ranges one character class may hold once merged.
 *
 * Overlap is free — `[\s\s\s…]` collapses to the handful of ranges `\s` really
 * covers — so this only bites a class that genuinely names hundreds of separate
 * intervals, and it bounds the per-character cost of {@link inRanges} at
 * `log2(512) = 9` comparisons no matter what the pattern says.
 */
const MAX_CLASS_RANGES = 512;

/* ------------------------------------------------------------------------- *
 * 1. PARSE — regex source to a syntax tree
 * ------------------------------------------------------------------------- */

/** A predicate over one UTF-16 code unit, plus the source it came from. */
interface CharSet {
  readonly negate: boolean;
  readonly ranges: readonly (readonly [number, number])[];
  /**
   * `d`, `w`, `s` and `.`, kept symbolic.
   *
   * `.` is load-bearing — {@link buildPredicate} widens it under the `s` flag.
   * The rest only mark "this came from a shorthand", which is how a class tells
   * `\d` from `\x41` when deciding whether something can be a range endpoint.
   * They are NOT consulted when folding case, though this said they were.
   */
  readonly classes: readonly string[];
}

type Node =
  | { readonly kind: 'empty' }
  | { readonly kind: 'char'; readonly set: CharSet }
  | { readonly kind: 'concat'; readonly parts: readonly Node[] }
  | { readonly kind: 'alt'; readonly options: readonly Node[] }
  | {
      readonly kind: 'repeat';
      readonly body: Node;
      readonly min: number;
      readonly max: number;
      readonly lazy: boolean;
    }
  | {
      readonly kind: 'assert';
      readonly at: 'start' | 'end' | 'word' | 'nonword';
    };

/** Thrown internally; callers see an {@link Unsupported} result instead. */
class ParseFailure extends Error {}

const fail = (reason: string): never => {
  throw new ParseFailure(reason);
};

/**
 * Sort a set's ranges and fuse everything that touches or overlaps.
 *
 * Two things depend on this. {@link inRanges} binary-searches, which is only
 * correct on sorted, disjoint ranges. And it is what makes a hostile class
 * cheap: `[\s×490]` names 7,350 ranges and covers 15, so merging turns a
 * 7,350-entry linear scan per character per instruction into a 15-entry one.
 */
const mergeRanges = (
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] => {
  if (ranges.length < 2) {
    return ranges;
  }

  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];

  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];

    // `+ 1` fuses adjacency as well as overlap: [97,98] and [99,100] are [97,100].
    if (last && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
      continue;
    }

    merged.push([from, to]);
  }

  return merged;
};

/** This matcher works on UTF-16 code units, so a set spans at most this. */
const MAX_CODE_UNIT = 0xffff;

/**
 * The ranges a set does NOT cover. Input must be sorted and disjoint.
 *
 * This is what lets a negated shorthand appear inside a class. `[\s\S]` — the
 * standard "any character, newlines included" idiom — used to be refused on the
 * grounds that `[\D]` "needs set subtraction to express exactly". It does not:
 * a class is a UNION, and unioning a complement is still a union.
 */
const complement = (
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] => {
  const out: (readonly [number, number])[] = [];
  let next = 0;

  for (const [from, to] of ranges) {
    if (from > next) {
      out.push([next, from - 1]);
    }

    next = Math.max(next, to + 1);
  }

  if (next <= MAX_CODE_UNIT) {
    out.push([next, MAX_CODE_UNIT]);
  }

  return out;
};

const DIGIT: readonly (readonly [number, number])[] = [[48, 57]];
const WORD: readonly (readonly [number, number])[] = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
/** JS `\s`: whitespace plus line terminators plus BOM. */
const SPACE_CODES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000, 0xfeff,
];
// Merged because `inRanges` binary-searches: the literal list below is not in
// ascending order, and an unsorted array silently makes the search miss.
const SPACE: readonly (readonly [number, number])[] = mergeRanges([
  ...SPACE_CODES.map((code) => [code, code] as const),
  [0x2000, 0x200a],
]);

const LINE_TERMINATORS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

const set = (
  ranges: readonly (readonly [number, number])[],
  negate = false,
  classes: readonly string[] = [],
): CharSet => {
  const merged = mergeRanges(ranges);

  if (merged.length > MAX_CLASS_RANGES) {
    fail(
      `a character class covering more than ${String(MAX_CLASS_RANGES)} separate ranges`,
    );
  }

  return { classes, negate, ranges: merged };
};

// `\0` is absent deliberately: it is the start of a legacy OCTAL escape, so it
// is decoded alongside `\1`..`\7` rather than as a fixed single character.
const SINGLE_ESCAPES: Readonly<Record<string, number>> = {
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

class Parser {
  private index = 0;

  public constructor(private readonly source: string) {}

  public parse(): Node {
    const node = this.parseAlternation();

    if (this.index < this.source.length) {
      // An unbalanced `)` is the only way to get here.
      fail(`unexpected ${JSON.stringify(this.peek())}`);
    }

    return node;
  }

  private peek(offset = 0): string {
    return this.source.charAt(this.index + offset);
  }

  private parseAlternation(): Node {
    const options: Node[] = [this.parseConcat()];

    while (this.peek() === '|') {
      this.index += 1;
      options.push(this.parseConcat());
    }

    const [only] = options;

    return options.length === 1 && only ? only : { kind: 'alt', options };
  }

  private parseConcat(): Node {
    const parts: Node[] = [];

    while (this.index < this.source.length) {
      const character = this.peek();

      if (character === '|' || character === ')') {
        break;
      }

      parts.push(this.parseRepeat());
    }

    if (parts.length === 0) {
      return { kind: 'empty' };
    }

    const [only] = parts;

    return parts.length === 1 && only ? only : { kind: 'concat', parts };
  }

  private parseRepeat(): Node {
    const atom = this.parseAtom();
    const character = this.peek();

    let min = -1;
    let max = -1;

    if (character === '*') {
      min = 0;
      max = Infinity;
      this.index += 1;
    } else if (character === '+') {
      min = 1;
      max = Infinity;
      this.index += 1;
    } else if (character === '?') {
      min = 0;
      max = 1;
      this.index += 1;
    } else if (character === '{') {
      const bounds = /^\{(\d+)(,(\d*)?)?\}/u.exec(
        this.source.slice(this.index),
      );

      if (!bounds) {
        // `{` that is not a quantifier is an ordinary character in JS.
        return atom;
      }

      min = Number(bounds[1]);
      max =
        bounds[2] === undefined
          ? min
          : bounds[3] === undefined || bounds[3] === ''
            ? Infinity
            : Number(bounds[3]);

      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        fail(`a counted repetition above ${String(MAX_REPEAT)}`);
      }

      if (max < min) {
        fail('a repetition whose maximum is below its minimum');
      }

      this.index += bounds[0].length;
    } else {
      return atom;
    }

    const lazy = this.peek() === '?';

    if (lazy) {
      this.index += 1;
    }

    return { body: atom, kind: 'repeat', lazy, max, min };
  }

  private parseAtom(): Node {
    const character = this.peek();

    if (character === '(') {
      return this.parseGroup();
    }

    if (character === '[') {
      return { kind: 'char', set: this.parseClass() };
    }

    if (character === '.') {
      this.index += 1;

      // Every code unit except a line terminator; the `s` flag widens it later.
      return { kind: 'char', set: set([[0, 0x10_ffff]], false, ['.']) };
    }

    if (character === '^') {
      this.index += 1;

      return { at: 'start', kind: 'assert' };
    }

    if (character === '$') {
      this.index += 1;

      return { at: 'end', kind: 'assert' };
    }

    if (character === '\\') {
      return this.parseEscape();
    }

    if (character === '*' || character === '+' || character === '?') {
      fail(`a quantifier with nothing to repeat: ${JSON.stringify(character)}`);
    }

    this.index += 1;

    return {
      kind: 'char',
      set: set([[character.charCodeAt(0), character.charCodeAt(0)]]),
    };
  }

  private parseGroup(): Node {
    this.index += 1;

    if (this.peek() === '?') {
      const ahead = this.peek(1);

      if (ahead === ':') {
        this.index += 2;
      } else if (
        ahead === '<' &&
        this.peek(2) !== '=' &&
        this.peek(2) !== '!'
      ) {
        // A NAMED group. Captures are not tracked — nothing here needs them — so
        // it behaves as non-capturing.
        const close = this.source.indexOf('>', this.index);

        if (close === -1) {
          fail('an unterminated group name');
        }

        this.index = close + 1;
      } else {
        /*
         * Lookahead or lookbehind. REFUSED rather than approximated: assertions
         * that can inspect arbitrary text are what make linear-time matching
         * impossible, and silently ignoring one would change what the pattern
         * means.
         */
        fail(
          'lookahead and lookbehind, which cannot be matched in guaranteed linear time',
        );
      }
    }

    const body = this.parseAlternation();

    if (this.peek() !== ')') {
      fail('an unclosed group');
    }

    this.index += 1;

    return body;
  }

  private parseEscape(): Node {
    const character = this.peek(1);

    if (character === '') {
      fail('a trailing backslash');
    }

    if (/^[1-9]$/u.test(character)) {
      /*
       * A BACKREFERENCE. Refused, and this is the one exclusion worth spelling
       * out: matching `\1` is NP-hard in the general case, so no engine
       * anywhere matches it in linear time. RE2 and Rust's regex refuse them
       * for exactly this reason.
       */
      fail(
        'a backreference, which cannot be matched in guaranteed linear time',
      );
    }

    if (character === 'b' || character === 'B') {
      this.index += 2;

      return { at: character === 'b' ? 'word' : 'nonword', kind: 'assert' };
    }

    if (character === 'k' && this.peek(2) === '<') {
      /*
       * A NAMED backreference. `\1` was refused and this was not, so it decoded
       * as the literal characters `k<name>` — wrong in both directions:
       * `/^(?<w>a+)\k<w>$/` stopped matching "aaaa", and started matching the
       * text "xk<w>y". Same impossibility as `\1`, same refusal.
       */
      fail(
        'a named backreference, which cannot be matched in guaranteed linear time',
      );
    }

    if (character === 'c') {
      const letter = this.peek(2);

      if (/^[A-Za-z]$/u.test(letter)) {
        this.index += 3;

        const code = letter.toUpperCase().charCodeAt(0) - 64;

        return { kind: 'char', set: set([[code, code]]) };
      }

      /*
       * `\c` with no control letter after it: Annex B makes the BACKSLASH the
       * literal, so `/\c/` matches the two characters `\c` and not `c`. Only
       * the backslash is consumed here; the `c` is then read as an ordinary
       * character by whoever called us.
       */
      this.index += 1;

      return { kind: 'char', set: set([[0x5c, 0x5c]]) };
    }

    this.index += 2;

    return { kind: 'char', set: this.escapeSet(character) };
  }

  /** The character set an escape denotes, outside a class. */
  private escapeSet(character: string): CharSet {
    switch (character) {
      case 'd':
        return set(DIGIT, false, ['d']);
      case 'D':
        return set(DIGIT, true, ['d']);
      case 'w':
        return set(WORD, false, ['w']);
      case 'W':
        return set(WORD, true, ['w']);
      case 's':
        return set(SPACE, false, ['s']);
      case 'S':
        return set(SPACE, true, ['s']);
      case 'u':
      case 'x': {
        const width = character === 'u' ? 4 : 2;
        const digits = this.source.slice(this.index, this.index + width);

        if (!new RegExp(`^[0-9a-fA-F]{${String(width)}}$`, 'u').test(digits)) {
          fail(`a malformed \\${character} escape`);
        }

        this.index += width;

        const code = Number.parseInt(digits, 16);

        return set([[code, code]]);
      }

      case 'p':
      case 'P':
        fail('a unicode property escape');

        return set([]);

      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7': {
        /*
         * A LEGACY OCTAL escape (Annex B), up to three digits and never above
         * 0377. `\0` was previously a fixed NUL and `\1`-`\7` inside a class
         * fell through to the literal digit, so `[\1]` matched "1" and not
         * \x01 — wrong in both directions — and `[\x00-\1f]` built the range
         * \x00 to "1" instead of \x00 to \x1f.
         *
         * OUTSIDE a class only `\0` reaches here: `\1`-`\9` are backreferences
         * there and are refused before this point, which is what JavaScript
         * does too.
         */
        let value = Number(character);
        let digits = 1;

        while (digits < 3) {
          const next = this.peek();

          if (!/^[0-7]$/u.test(next)) {
            break;
          }

          const widened = value * 8 + Number(next);

          if (widened > 255) {
            break;
          }

          value = widened;
          this.index += 1;
          digits += 1;
        }

        return set([[value, value]]);
      }

      default: {
        const single = SINGLE_ESCAPES[character];
        const code = single ?? character.charCodeAt(0);

        return set([[code, code]]);
      }
    }
  }

  /**
   * One item inside `[...]`: a single character, or a shorthand set like `\d`.
   *
   * Separated from range-forming because conflating them was two defects. The
   * old loop pushed an escape's ranges and `continue`d, so it never looked for
   * the `-` that followed: `[\x41-\x43]` became the three literals `A`, `-`,
   * `C` and `[\x00-\x1f]` — the ordinary "control characters" idiom — silently
   * matched almost nothing. And when an escape appeared on the RIGHT of a dash,
   * the endpoint was taken as the first code of its set, so `[1-\d]` compiled to
   * the inverted range [49,48] and `[a-\w]` matched nothing at all.
   */
  private parseClassAtom():
    | { readonly kind: 'char'; readonly code: number }
    | { readonly kind: 'set'; readonly set: CharSet } {
    if (this.peek() !== '\\') {
      const code = this.peek().charCodeAt(0);

      this.index += 1;

      return { code, kind: 'char' };
    }

    const escaped = this.peek(1);

    // Inside a class `\b` is BACKSPACE, not a word boundary. Outside one it is
    // the assertion; the same two characters mean different things by position.
    if (escaped === 'b') {
      this.index += 2;

      return { code: 0x08, kind: 'char' };
    }

    /*
     * `\cJ` is a normal way to spell a newline inside a class, and this used to
     * miss it entirely: `c` fell through to the literal `c`, so `[\cJ]` matched
     * "c" and "J" and did not match "\n" — wrong in both directions.
     */
    if (escaped === 'c') {
      const letter = this.peek(2);

      /*
       * A class accepts a WIDER control letter than the rest of a pattern does:
       * Annex B's `ClassControlLetter` admits a digit or `_` as well, so `[\c0]`
       * is \x10 while `/\c0/` is the literal `\c0`. Reusing the outside-a-class
       * rule here made `[^\c0]` reject "c" and "\", which a generated sweep
       * caught after the hand-written cases all passed.
       */
      if (/^[A-Za-z0-9_]$/u.test(letter)) {
        this.index += 3;

        return { code: letter.charCodeAt(0) % 32, kind: 'char' };
      }

      this.index += 1;

      return { code: 0x5c, kind: 'char' };
    }

    this.index += 2;

    const inner = this.escapeSet(escaped);

    // A shorthand covers many characters, so it cannot be a range endpoint.
    if (inner.classes.length > 0 || inner.negate || inner.ranges.length !== 1) {
      return { kind: 'set', set: inner };
    }

    const [only] = inner.ranges;

    return only && only[0] === only[1]
      ? { code: only[0], kind: 'char' }
      : { kind: 'set', set: inner };
  }

  private parseClass(): CharSet {
    this.index += 1;

    const negate = this.peek() === '^';

    if (negate) {
      this.index += 1;
    }

    const ranges: (readonly [number, number])[] = [];
    const classes: string[] = [];

    const absorb = (item: ReturnType<Parser['parseClassAtom']>): void => {
      if (item.kind === 'char') {
        ranges.push([item.code, item.code]);

        return;
      }

      if (item.set.negate) {
        ranges.push(...complement(item.set.ranges));

        return;
      }

      ranges.push(...item.set.ranges);
      classes.push(...item.set.classes);
    };

    while (this.index < this.source.length && this.peek() !== ']') {
      const left = this.parseClassAtom();

      // A `-` is only a range separator when something other than `]` follows.
      // Otherwise it is a literal dash, which is what makes `[a-]` and `[-a]`
      // read correctly.
      const separates =
        this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== '';

      if (!separates) {
        absorb(left);
        continue;
      }

      this.index += 1;

      const right = this.parseClassAtom();

      if (left.kind === 'char' && right.kind === 'char') {
        if (right.code < left.code) {
          fail('a character class range whose end is below its start');
        }

        ranges.push([left.code, right.code]);
        continue;
      }

      /*
       * A shorthand on EITHER side means no range is formed: JavaScript's
       * `CharacterRangeOrUnion` reads the three items as a union instead, so
       * `[1-\d]` is `1`, `-`, `\d`.
       *
       * The dash has to be consumed here, by this branch. Leaving it for the
       * next pass — which is what happened when only the left side was checked
       * — let it become a fresh range start, so `[\d--z]` compiled to the range
       * \x2D-\x7A and matched every letter. That is an OVER-match: a filter
       * admitted records it was asked to reject.
       */
      absorb(left);
      ranges.push([0x2d, 0x2d]);
      absorb(right);
    }

    if (this.peek() !== ']') {
      fail('an unterminated character class');
    }

    this.index += 1;

    return set(ranges, negate, classes);
  }
}

/* ------------------------------------------------------------------------- *
 * 2. COMPILE — syntax tree to a program
 * ------------------------------------------------------------------------- */

type Inst =
  | { readonly op: 'char'; readonly test: (code: number) => boolean }
  | { readonly op: 'split'; x: number; y: number }
  | { readonly op: 'jmp'; to: number }
  | { readonly op: 'assert'; readonly at: 'start' | 'end' | 'word' | 'nonword' }
  /**
   * Remember where this iteration of a loop began, and refuse to leave it
   * having consumed nothing.
   *
   * JavaScript's RepeatMatcher fails an iteration that matches the empty string
   * once `min` is satisfied, and without that rule a nullable body can take the
   * loop for free. That does not change the accepted LANGUAGE — `test()` agreed
   * throughout — but it changes match EXTENTS, because the empty path wins on
   * priority: `/(?:.*?)?\w+/` over "a,b,,c" reported [0,1] [1,3] [3,6] where
   * RegExp reports [0,3] [3,6].
   *
   * Emitted ONLY around a nullable loop body, so a pattern without one carries
   * no slots and the VM below runs exactly as it did before.
   */
  | { readonly op: 'mark'; readonly slot: number }
  | { readonly op: 'progress'; readonly slot: number }
  | { readonly op: 'match' };

/**
 * Can this match without consuming anything?
 *
 * Assertions count as nullable — they are width-zero — which is why `(?:^)*`
 * needs the check as much as `(?:a?)*` does.
 */
const nullable = (node: Node): boolean => {
  switch (node.kind) {
    case 'empty':
    case 'assert':
      return true;
    case 'char':
      return false;
    case 'concat':
      return node.parts.every((part) => nullable(part));
    case 'alt':
      return node.options.some((option) => nullable(option));
    default:
      return node.min === 0 || nullable(node.body);
  }
};

interface Options {
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
}

/**
 * Is `code` covered? `ranges` must be sorted and disjoint — {@link mergeRanges}.
 *
 * Linear below a handful of ranges because that is nearly every real class and
 * the loop beats the branching; binary above it, so a class naming hundreds of
 * intervals costs nine comparisons instead of hundreds. This is called once per
 * live instruction per input character, so its constant is the VM's constant.
 */
const inRanges = (
  code: number,
  ranges: readonly (readonly [number, number])[],
): boolean => {
  if (ranges.length <= 8) {
    for (const [from, to] of ranges) {
      if (code >= from && code <= to) {
        return true;
      }
    }

    return false;
  }

  let low = 0;
  let high = ranges.length - 1;

  while (low <= high) {
    const middle = (low + high) >>> 1;
    const span = ranges[middle];

    if (!span) {
      break;
    }

    if (code < span[0]) {
      high = middle - 1;
    } else if (code > span[1]) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
};

/**
 * JavaScript's `Canonicalize`, which is not `toUpperCase`.
 *
 * Two rules matter and the first version had neither:
 *
 *  - A character whose uppercase is MULTIPLE characters does not fold. `ß`
 *    uppercases to `SS`, so `/S/i` must not match it.
 *  - A NON-ASCII character whose uppercase is ASCII does not fold. Otherwise
 *    `/k/i` matches the Kelvin sign `K`, `/S/i` matches `ſ`, and `/I/i` matches
 *    the dotless `ı` — all of which `RegExp` refuses.
 *
 * Folding with a bare `toUpperCase` produced exactly those over-matches.
 */
const computeCanonical = (code: number): number => {
  const upper = String.fromCharCode(code).toUpperCase();
  const upperCode = upper.charCodeAt(0);

  return upper.length !== 1 || (code >= 128 && upperCode < 128)
    ? code
    : upperCode;
};

const CANONICAL = new Map<number, number>();

const canonicalize = (code: number): number => {
  const cached = CANONICAL.get(code);

  if (cached !== undefined) {
    return cached;
  }

  const folded = computeCanonical(code);

  // Bounded by the code-unit space, so this cannot grow without limit.
  CANONICAL.set(code, folded);

  return folded;
};

let ORBITS: Map<number, readonly number[]> | null = null;

/**
 * Every character sharing a canonical form, grouped by that form.
 *
 * This is the REVERSE of {@link canonicalize}, and it has to be tabulated rather
 * than derived, because case conversion is not invertible by applying more case
 * conversion. `ς` uppercases to `Σ`, but `Σ` lowercases to `σ` and never to `ς`,
 * so a closure over `toLowerCase`/`toUpperCase` — which is what this used to be
 * — cannot get from one to the other. `/[α-ς]/i` therefore failed to match `Σ`,
 * and `/[^α-ς]/i` MATCHED it: an over-match straight through a negated class.
 * The same hole covered `µ` MICRO SIGN, `ϕ/Φ`, `ϰ/Κ`, `ẚ/Ṡ` and Cyrillic U+1C80+.
 *
 * Built once, lazily, and only when an `i` pattern is first compiled — a pattern
 * without `i` never pays for it. Only orbits with more than one member are kept,
 * which is a few thousand entries out of the 65,536 scanned.
 */
const orbits = (): Map<number, readonly number[]> => {
  if (ORBITS) {
    return ORBITS;
  }

  const byCanonical = new Map<number, number[]>();

  for (let code = 0; code <= MAX_CODE_UNIT; code += 1) {
    // Deliberately NOT the memoised `canonicalize`: filling that cache with
    // every code unit would cost megabytes to answer questions nobody asked.
    const canonical = computeCanonical(code);
    const bucket = byCanonical.get(canonical);

    if (bucket) {
      bucket.push(code);
      continue;
    }

    byCanonical.set(canonical, [code]);
  }

  const kept = new Map<number, readonly number[]>();

  for (const [canonical, members] of byCanonical) {
    if (members.length > 1) {
      kept.set(canonical, members);
    }
  }

  ORBITS = kept;

  return kept;
};

/** Every character that canonicalizes the same way this one does. */
const foldCandidates = (code: number): readonly number[] =>
  orbits().get(canonicalize(code)) ?? [code];

/** Turn a set into a predicate, folding case and widening `.` under `s`. */

const buildPredicate = (
  source: CharSet,
  options: Options,
): ((code: number) => boolean) => {
  const isDot = source.classes.includes('.');

  const { ranges } = source;

  if (options.ignoreCase) {
    // Warm the table now, at compile time, so no single character of a scan
    // pays for a 65,536-entry build partway through.
    orbits();
  }

  return (code: number): boolean => {
    if (isDot) {
      return options.dotAll || !LINE_TERMINATORS.has(code);
    }

    let hit = inRanges(code, ranges);

    if (!hit && options.ignoreCase) {
      /*
       * The rule is `∃a ∈ set : Canonicalize(a) === Canonicalize(input)`, so
       * testing the input's whole ORBIT against the set decides it exactly, in
       * both directions and for ranges of any width.
       *
       * The set used to be widened instead, by adding the canonical form of each
       * SINGLE-character range. That could not work for a multi-character range,
       * which is how `/[α-ς]/i` came to miss `Σ`.
       */
      for (const candidate of foldCandidates(code)) {
        if (inRanges(candidate, ranges)) {
          hit = true;
          break;
        }
      }
    }

    return source.negate ? !hit : hit;
  };
};

const PREDICATES = new WeakMap<
  CharSet,
  Map<string, (code: number) => boolean>
>();

/**
 * {@link buildPredicate}, but built once per distinct set.
 *
 * Counted repetitions compile by duplicating the body, and every copy shares the
 * SAME `CharSet` object — so `[…]{1000}` used to rebuild and re-merge the same
 * range list a thousand times before the program-size limit refused the pattern.
 * That is why a rejected pattern could still burn 2.7 seconds of uninterruptible
 * CPU: the work happened on the way to the refusal.
 */
const predicate = (
  source: CharSet,
  options: Options,
): ((code: number) => boolean) => {
  const key = `${options.ignoreCase ? 'i' : ''}${options.dotAll ? 's' : ''}`;
  let byOptions = PREDICATES.get(source);

  if (!byOptions) {
    byOptions = new Map();
    PREDICATES.set(source, byOptions);
  }

  const cached = byOptions.get(key);

  if (cached) {
    return cached;
  }

  const built = buildPredicate(source, options);

  byOptions.set(key, built);

  return built;
};

class Program {
  public readonly code: Inst[] = [];

  /**
   * Compilation steps taken, which is NOT the same as instructions emitted.
   *
   * The budget used to live only in `emit`, so a body that compiles to ZERO
   * instructions — `()`, `(?:)` — could be repeated for free: `{1000}` spun the
   * duplication loop a thousand times without emitting anything, and nesting
   * multiplied it. `((((){1000}){1000}){1000}){1000}` is 32 characters and took
   * over 75 seconds, which moved the uninterruptible hang this engine exists to
   * remove from match time to COMPILE time.
   */
  public steps = 0;

  /** One per nullable loop body; zero for every pattern without one. */
  public slots = 0;

  public claimSlot(): number {
    const slot = this.slots;

    this.slots += 1;

    return slot;
  }

  public step(): void {
    this.steps += 1;

    if (this.steps > MAX_PROGRAM) {
      fail(
        `more than ${String(MAX_PROGRAM)} compilation steps once counted repetitions are expanded`,
      );
    }
  }

  public emit(instruction: Inst): number {
    if (this.code.length >= MAX_PROGRAM) {
      fail(
        `more than ${String(MAX_PROGRAM)} instructions once counted repetitions are expanded`,
      );
    }

    this.code.push(instruction);

    return this.code.length - 1;
  }
}

const compileNode = (node: Node, program: Program, options: Options): void => {
  // Counted before the switch, so a node that emits NOTHING still costs budget.
  program.step();

  switch (node.kind) {
    case 'empty':
      return;

    case 'assert':
      program.emit({ at: node.at, op: 'assert' });

      return;

    case 'char':
      program.emit({ op: 'char', test: predicate(node.set, options) });

      return;

    case 'concat':
      for (const part of node.parts) {
        compileNode(part, program, options);
      }

      return;

    case 'alt': {
      const jumps: number[] = [];

      for (const [index, option] of node.options.entries()) {
        const last = index === node.options.length - 1;

        if (last) {
          compileNode(option, program, options);
          break;
        }

        const split = program.emit({ op: 'split', x: 0, y: 0 });

        (program.code[split] as { x: number }).x = program.code.length;
        compileNode(option, program, options);
        jumps.push(program.emit({ op: 'jmp', to: 0 }));
        (program.code[split] as { y: number }).y = program.code.length;
      }

      for (const jump of jumps) {
        (program.code[jump] as { to: number }).to = program.code.length;
      }

      return;
    }

    case 'repeat': {
      /*
       * Counted repetitions are compiled by DUPLICATION — `a{2,4}` becomes
       * `aa(a(a)?)?` — which is why MAX_PROGRAM exists. Anything else would need
       * counters in the VM, and a counter is state that multiplies the thread
       * set, which is exactly the property this engine is built to avoid.
       */
      for (let index = 0; index < node.min; index += 1) {
        compileNode(node.body, program, options);
      }

      // Only a nullable body can take an iteration for free, so only that case
      // pays for a slot and the two extra epsilon steps.
      const guard = nullable(node.body) ? program.claimSlot() : null;

      if (node.max === Infinity) {
        const split = program.emit({ op: 'split', x: 0, y: 0 });
        const body = program.code.length;

        if (guard !== null) {
          program.emit({ op: 'mark', slot: guard });
        }

        compileNode(node.body, program, options);

        if (guard !== null) {
          program.emit({ op: 'progress', slot: guard });
        }

        program.emit({ op: 'jmp', to: split });

        const after = program.code.length;
        const frame = program.code[split] as { x: number; y: number };

        // Lazy prefers leaving the loop; greedy prefers re-entering it.
        frame.x = node.lazy ? after : body;
        frame.y = node.lazy ? body : after;

        return;
      }

      const optional = node.max - node.min;
      const splits: number[] = [];

      for (let index = 0; index < optional; index += 1) {
        const split = program.emit({ op: 'split', x: 0, y: 0 });

        splits.push(split);

        const body = program.code.length;
        const frame = program.code[split] as { x: number; y: number };

        if (guard !== null) {
          program.emit({ op: 'mark', slot: guard });
        }

        compileNode(node.body, program, options);

        if (guard !== null) {
          program.emit({ op: 'progress', slot: guard });
        }

        if (node.lazy) {
          frame.y = body;
        } else {
          frame.x = body;
        }
      }

      for (const split of splits) {
        const frame = program.code[split] as { x: number; y: number };

        if (node.lazy) {
          frame.x = program.code.length;
        } else {
          frame.y = program.code.length;
        }
      }
    }
  }
};

/* ------------------------------------------------------------------------- *
 * 3. RUN — the Pike VM
 * ------------------------------------------------------------------------- */

const isWordCode = (code: number | undefined): boolean =>
  code !== undefined && inRanges(code, WORD);

/**
 * Does `program` match anywhere in `input` at or after `begin`?
 *
 * ONE pass. `clist` holds every instruction the pattern could be at right now;
 * `seen` keeps each instruction in it at most once, which is the entire reason
 * this cannot blow up — a pattern with exponentially many ways to match still
 * has only as many STATES as it has instructions.
 *
 * `begin` is an OFFSET, never a slice. Resuming a scan by passing
 * `input.slice(at)` looks equivalent and is not: every assertion is positional,
 * so a fresh string gives `^` a new start and `\b` an empty left context. That
 * made `spans()` disagree with `RegExp` in both directions — `/^a/` over "aa"
 * reported two matches where there is one, and `/\Ba/` over "aaa" dropped one —
 * so the whole input is always passed and only the starting position moves.
 */
const run = (
  code: readonly Inst[],
  input: string,
  options: Options,
  wantSpan: boolean,
  begin = 0,
  slotCount = 0,
): { readonly start: number; readonly end: number } | boolean | null => {
  let clist: number[] = [];
  let nlist: number[] = [];
  let seen = new Uint8Array(code.length);
  let nextSeen = new Uint8Array(code.length);
  // Where the thread at each pc began. Threads are added in priority order and
  // the first to claim a pc keeps it, so this holds the LEFTMOST start.
  let from = new Int32Array(code.length);
  let nextFrom = new Int32Array(code.length);
  /*
   * Where the current iteration of each nullable loop began, indexed by pc — the
   * same shape as `from`, and dedup'd the same way, so a thread still carries no
   * state of its own and the linear-time bound is untouched. `slotCount` is 0
   * for every pattern without a nullable loop, and then these are empty and no
   * branch below ever runs.
   */
  const NO_SLOTS: Int32Array[] = [];
  const board = (): Int32Array[] =>
    slotCount === 0
      ? NO_SLOTS
      : Array.from({ length: slotCount }, () =>
          new Int32Array(code.length).fill(-1),
        );
  let slotAt = board();
  let nextSlotAt = board();

  const holds = (at: Inst & { op: 'assert' }, position: number): boolean => {
    const before = position > 0 ? input.charCodeAt(position - 1) : undefined;
    const after =
      position < input.length ? input.charCodeAt(position) : undefined;

    switch (at.at) {
      case 'start':
        return (
          position === 0 ||
          (options.multiline &&
            before !== undefined &&
            LINE_TERMINATORS.has(before))
        );
      case 'end':
        return (
          position === input.length ||
          (options.multiline &&
            after !== undefined &&
            LINE_TERMINATORS.has(after))
        );
      case 'word':
        return isWordCode(before) !== isWordCode(after);
      default:
        return isWordCode(before) === isWordCode(after);
    }
  };

  /**
   * The epsilon closure, in the form used by every pattern WITHOUT a nullable
   * loop — which is nearly all of them.
   *
   * Kept as a separate, untouched function from the slot-aware version below.
   * Threading the loop-progress state through this one instead cost 1.7x on
   * ordinary regex filtering (46ms -> 81ms over 20,000 rows) even when the
   * pattern had no nullable loop and the state was never used: extra parameters,
   * a branch per pending pop, and a per-step call. Paying that on every query to
   * fix match extents for a rare pattern shape is the same bad trade as building
   * a path eagerly for every candidate, and it is refused for the same reason.
   */
  const add = (
    list: number[],
    marks: Uint8Array,
    starts: Int32Array,
    pc: number,
    position: number,
    origin: number,
  ): void => {
    // An explicit stack: the epsilon closure can be deep, and recursion here
    // would reintroduce a stack overflow on exactly the patterns this exists to
    // survive.
    const pending = [pc];

    while (pending.length > 0) {
      const at = pending.pop();

      if (at === undefined || marks[at] === 1) {
        continue;
      }

      marks[at] = 1;
      starts[at] = origin;

      const instruction = code[at];

      if (!instruction) {
        continue;
      }

      if (instruction.op === 'jmp') {
        pending.push(instruction.to);
      } else if (instruction.op === 'split') {
        // y first, so x is popped and explored first — that is thread priority.
        pending.push(instruction.y, instruction.x);
      } else if (instruction.op === 'assert') {
        if (holds(instruction, position)) {
          pending.push(at + 1);
        }
      } else {
        // `char` and `match`. `mark`/`progress` cannot reach here: they are only
        // emitted when a slot was claimed, and a claimed slot selects
        // `addTracking` instead. Testing for them anyway cost two string
        // comparisons per instruction per character in the hottest loop there is.
        list.push(at);
      }
    }
  };

  /**
   * The same closure, carrying where each nullable loop's current iteration
   * began — used only when the pattern actually contains one.
   *
   * The value rides `pending` per entry rather than living per thread, because
   * two epsilon paths reaching the same instruction can disagree about it. Dedup
   * is still by pc, so the linear-time bound is untouched.
   */
  const addTracking = (
    list: number[],
    marks: Uint8Array,
    starts: Int32Array,
    slots: Int32Array[],
    pc: number,
    position: number,
    origin: number,
    carried: readonly number[],
  ): void => {
    const pending: number[] = [pc];
    const values: (readonly number[])[] = [carried];

    while (pending.length > 0) {
      const at = pending.pop();
      const here = values.pop() ?? carried;

      if (at === undefined || marks[at] === 1) {
        continue;
      }

      marks[at] = 1;
      starts[at] = origin;

      for (let slot = 0; slot < slotCount; slot += 1) {
        const lane = slots[slot];

        if (lane) {
          lane[at] = here[slot] ?? -1;
        }
      }

      const instruction = code[at];

      if (!instruction) {
        continue;
      }

      if (instruction.op === 'jmp') {
        pending.push(instruction.to);
        values.push(here);
      } else if (instruction.op === 'split') {
        pending.push(instruction.y, instruction.x);
        values.push(here, here);
      } else if (instruction.op === 'assert') {
        if (holds(instruction, position)) {
          pending.push(at + 1);
          values.push(here);
        }
      } else if (instruction.op === 'mark') {
        const updated = [...here];

        updated[instruction.slot] = position;
        pending.push(at + 1);
        values.push(updated);
      } else if (instruction.op === 'progress') {
        // The iteration consumed nothing, so JavaScript fails it rather than
        // letting the loop turn for free. Dropping the thread IS that failure.
        if (here[instruction.slot] !== position) {
          pending.push(at + 1);
          values.push(here);
        }
      } else {
        list.push(at);
      }
    }
  };

  const EMPTY: readonly number[] = [];
  const tracking = slotCount > 0;

  let matched: { readonly start: number; readonly end: number } | null = null;

  for (let position = begin; position <= input.length; position += 1) {
    /*
     * Unanchored: a fresh attempt may start at any position — but only until
     * something matches, or a later start could win over an earlier one and the
     * result would not be leftmost. Deduplication keeps this from multiplying
     * the work.
     */
    if (matched === null) {
      if (tracking) {
        addTracking(clist, seen, from, slotAt, 0, position, position, EMPTY);
      } else {
        add(clist, seen, from, 0, position, position);
      }
    }

    for (const pc of clist) {
      const instruction = code[pc];

      if (!instruction) {
        continue;
      }

      if (instruction.op === 'match') {
        if (!wantSpan) {
          return true;
        }

        /*
         * Record it and CUT every lower-priority thread — that is what makes
         * this leftmost-FIRST, the same answer a backtracking engine gives.
         *
         * Higher-priority threads were already advanced earlier in this loop, so
         * they survive and may match again further right; a greedy `a+` reaches
         * `match` only after the threads that keep consuming, so breaking here
         * lets it extend. Returning immediately instead reported the SHORTEST
         * match: `a+` over "baaanaa" gave 1-2, 2-3, 3-4 where `RegExp` gives 1-4.
         */
        matched = { end: position, start: from[pc] ?? position };
        break;
      }

      if (
        instruction.op === 'char' &&
        position < input.length &&
        instruction.test(input.charCodeAt(position))
      ) {
        if (tracking) {
          addTracking(
            nlist,
            nextSeen,
            nextFrom,
            nextSlotAt,
            pc + 1,
            position + 1,
            from[pc] ?? position,
            slotAt.map((values) => values[pc] ?? -1),
          );
        } else {
          add(
            nlist,
            nextSeen,
            nextFrom,
            pc + 1,
            position + 1,
            from[pc] ?? position,
          );
        }
      }
    }

    clist = nlist;
    seen = nextSeen;
    from = nextFrom;
    slotAt = nextSlotAt;
    nlist = [];
    nextSeen = new Uint8Array(code.length);
    nextFrom = new Int32Array(code.length);
    nextSlotAt = tracking ? board() : NO_SLOTS;

    // Nothing left that could extend the match, and nothing new may start.
    if (clist.length === 0 && matched !== null) {
      break;
    }
  }

  return wantSpan ? matched : false;
};

/* ------------------------------------------------------------------------- *
 * 4. PUBLIC SURFACE
 * ------------------------------------------------------------------------- */

export interface LinearMatcher {
  /** Does the pattern match anywhere in `input`? Always O(pattern × input). */
  test(input: string): boolean;
  /**
   * Every non-overlapping match, as half-open spans.
   *
   * This is what lets `highlight()` report WHERE a regex matched without handing
   * a `RegExp` to the caller. Doing that was a real hole: a pattern this matcher
   * runs in 3 ms — `^.|(.+)+;` — took a consumer's `exec` loop 8.8 seconds on a
   * 30-character value, because their loop runs on the backtracking engine even
   * though ours does not.
   *
   * A zero-length match advances by one, so the walk always terminates.
   */
  spans(
    input: string,
  ): readonly { readonly start: number; readonly end: number }[];
  readonly source: string;
  readonly flags: string;
}

export type LinearResult =
  | { readonly ok: true; readonly matcher: LinearMatcher }
  | { readonly ok: false; readonly reason: string };

/**
 * Compile a pattern into something that cannot backtrack, or explain why not.
 *
 * A refusal is never a fallback to `RegExp`. Falling back would mean the one
 * pattern we could not make safe is the one that runs on the unsafe engine,
 * which is precisely backwards.
 */
export const compileLinear = (source: string, flags: string): LinearResult => {
  const options: Options = {
    dotAll: flags.includes('s'),
    ignoreCase: flags.includes('i'),
    multiline: flags.includes('m'),
  };

  try {
    /*
     * `u` and `v` are REFUSED, not ignored.
     *
     * This matcher works on UTF-16 code units. Under `u`, `.` matches a whole
     * code POINT and a class may span astral characters, so accepting the flag
     * and carrying on gave silently different answers: `/^.$/u` matched an emoji
     * in `RegExp` and not here. That is the exact "trade a hang for wrong
     * results" outcome this engine exists to avoid, so it is refused with a
     * message rather than honoured in name only.
     *
     * `v` is the same story with more syntax on top.
     */
    if (flags.includes('u') || flags.includes('v')) {
      fail(
        'the u or v flag, which needs code-point semantics this matcher does not implement',
      );
    }

    const tree = new Parser(source).parse();
    const program = new Program();

    compileNode(tree, program, options);
    program.emit({ op: 'match' });

    const code = program.code;
    const { slots } = program;

    return {
      matcher: {
        flags,
        source,
        spans: (input: string) => {
          const found: { start: number; end: number }[] = [];

          let at = 0;

          while (at <= input.length) {
            const hit = run(code, input, options, true, at, slots);

            if (hit === null || typeof hit === 'boolean') {
              break;
            }

            const { end, start } = hit;

            found.push({ end, start });

            /*
             * A zero-length match would otherwise pin the cursor forever — the
             * same trap `matchesEmpty` exists to keep out of a caller's loop.
             *
             * `at` therefore rises by at least one every time round, so the walk
             * runs at most `input.length + 1` times and needs no other cap. It
             * used to stop after 10,001 spans, which silently returned a partial
             * answer that a caller could not distinguish from a complete one.
             */
            at = end > start ? end : start + 1;
          }

          return found;
        },
        test: (input: string): boolean =>
          run(code, input, options, false, 0, slots) === true,
      },
      ok: true,
    };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { ok: false, reason: error.message };
    }

    throw error;
  }
};
