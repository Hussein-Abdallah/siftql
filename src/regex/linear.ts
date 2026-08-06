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
 * `a{1000}{1000}` is a million. Refusing past this point keeps the worst case at
 * roughly 4,000 × input steps, which is tens of milliseconds on a long value.
 *
 * A pattern that exceeds it is refused, not silently truncated.
 */
const MAX_PROGRAM = 4000;

/** Longest counted repetition, so `a{1000000}` fails fast rather than slowly. */
const MAX_REPEAT = 1000;

/* ------------------------------------------------------------------------- *
 * 1. PARSE — regex source to a syntax tree
 * ------------------------------------------------------------------------- */

/** A predicate over one UTF-16 code unit, plus the source it came from. */
interface CharSet {
  readonly negate: boolean;
  readonly ranges: readonly (readonly [number, number])[];
  /** `d`, `w`, `s` and their negations, kept symbolic so `i` folding is right. */
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
const SPACE: readonly (readonly [number, number])[] = [
  ...SPACE_CODES.map((code) => [code, code] as const),
  [0x2000, 0x200a],
];

const LINE_TERMINATORS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

const set = (
  ranges: readonly (readonly [number, number])[],
  negate = false,
  classes: readonly string[] = [],
): CharSet => ({ classes, negate, ranges });

const SINGLE_ESCAPES: Readonly<Record<string, number>> = {
  '0': 0,
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

      default: {
        const single = SINGLE_ESCAPES[character];
        const code = single ?? character.charCodeAt(0);

        return set([[code, code]]);
      }
    }
  }

  private parseClass(): CharSet {
    this.index += 1;

    const negate = this.peek() === '^';

    if (negate) {
      this.index += 1;
    }

    const ranges: (readonly [number, number])[] = [];
    const classes: string[] = [];

    while (this.index < this.source.length && this.peek() !== ']') {
      if (this.peek() === '\\') {
        const escaped = this.peek(1);

        this.index += 2;

        if ('dDwWsS'.includes(escaped)) {
          const inner = this.escapeSet(escaped);

          if (inner.negate) {
            // `[\D]` inside a class needs set subtraction to express exactly;
            // refusing is honest and this is rare.
            fail(`\\${escaped} inside a character class`);
          }

          ranges.push(...inner.ranges);
          classes.push(...inner.classes);
          continue;
        }

        // Step back so escapeSet sees the same position an outside escape would.
        this.index -= 2;
        this.index += 2;

        const inner = this.escapeSet(escaped);

        ranges.push(...inner.ranges);
        continue;
      }

      const from = this.peek().charCodeAt(0);

      this.index += 1;

      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== '') {
        this.index += 1;

        const to =
          this.peek() === '\\'
            ? (() => {
                const escaped = this.peek(1);

                this.index += 2;

                const inner = this.escapeSet(escaped);

                return inner.ranges[0]?.[0] ?? 0;
              })()
            : (() => {
                const code = this.peek().charCodeAt(0);

                this.index += 1;

                return code;
              })();

        ranges.push([from, to]);
        continue;
      }

      ranges.push([from, from]);
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
  | { readonly op: 'match' };

interface Options {
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
}

const inRanges = (
  code: number,
  ranges: readonly (readonly [number, number])[],
): boolean => {
  for (const [from, to] of ranges) {
    if (code >= from && code <= to) {
      return true;
    }
  }

  return false;
};

/** Turn a set into a predicate, folding case and widening `.` under `s`. */
const predicate = (
  source: CharSet,
  options: Options,
): ((code: number) => boolean) => {
  const isDot = source.classes.includes('.');

  return (code: number): boolean => {
    if (isDot) {
      return options.dotAll || !LINE_TERMINATORS.has(code);
    }

    let hit = inRanges(code, source.ranges);

    if (!hit && options.ignoreCase) {
      // Simple case folding, which covers the alphabets a search box sees.
      const character = String.fromCharCode(code);
      const upper = character.toUpperCase().charCodeAt(0);
      const lower = character.toLowerCase().charCodeAt(0);

      hit = inRanges(upper, source.ranges) || inRanges(lower, source.ranges);
    }

    return source.negate ? !hit : hit;
  };
};

class Program {
  public readonly code: Inst[] = [];

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

      if (node.max === Infinity) {
        const split = program.emit({ op: 'split', x: 0, y: 0 });
        const body = program.code.length;

        compileNode(node.body, program, options);
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

        compileNode(node.body, program, options);

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
 * Does `program` match anywhere in `input`?
 *
 * ONE pass. `clist` holds every instruction the pattern could be at right now;
 * `seen` keeps each instruction in it at most once, which is the entire reason
 * this cannot blow up — a pattern with exponentially many ways to match still
 * has only as many STATES as it has instructions.
 */
const run = (
  code: readonly Inst[],
  input: string,
  options: Options,
): boolean => {
  let clist: number[] = [];
  let nlist: number[] = [];
  let seen = new Uint8Array(code.length);
  let nextSeen = new Uint8Array(code.length);

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

  const add = (
    list: number[],
    marks: Uint8Array,
    pc: number,
    position: number,
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
        list.push(at);
      }
    }
  };

  for (let position = 0; position <= input.length; position += 1) {
    // Unanchored: a fresh attempt may start at any position. Deduplication keeps
    // this from multiplying the work.
    add(clist, seen, 0, position);

    for (const pc of clist) {
      const instruction = code[pc];

      if (!instruction) {
        continue;
      }

      if (instruction.op === 'match') {
        return true;
      }

      if (
        instruction.op === 'char' &&
        position < input.length &&
        instruction.test(input.charCodeAt(position))
      ) {
        add(nlist, nextSeen, pc + 1, position + 1);
      }
    }

    clist = nlist;
    seen = nextSeen;
    nlist = [];
    nextSeen = new Uint8Array(code.length);
  }

  return clist.some((pc) => code[pc]?.op === 'match');
};

/* ------------------------------------------------------------------------- *
 * 4. PUBLIC SURFACE
 * ------------------------------------------------------------------------- */

export interface LinearMatcher {
  /** Does the pattern match anywhere in `input`? Always O(pattern × input). */
  test(input: string): boolean;
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
    const tree = new Parser(source).parse();
    const program = new Program();

    compileNode(tree, program, options);
    program.emit({ op: 'match' });

    const code = program.code;

    return {
      matcher: {
        flags,
        source,
        test: (input: string): boolean => run(code, input, options),
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
