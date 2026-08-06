import { describe, expect, it } from 'vitest';

import { createEngine, filter, test as matches } from '../src/index.js';
import { compileLinear } from '../src/regex/linear.js';

/**
 * ENGINE ISOLATION AND PATTERN SCREENING (G6).
 *
 * Both halves here were promises the package made and did not keep: that two
 * engines in one process cannot see each other, and that a user-supplied regex is
 * screened for catastrophic backtracking.
 *
 * The regex tests are written as a CORPUS rather than as a list of shapes,
 * because the screen they replaced was wrong in both directions at once —
 * refusing `^([A-Z]{3}-){1,4}[0-9]{2}$`, which runs in 0.01 ms, while passing
 * `(a|a)*`, which blocks the event loop for four seconds. A test naming only the
 * shapes the implementation already knew about would have passed throughout.
 */

/** Does the linear matcher accept this pattern? */
const screened = (pattern: string): boolean => compileLinear(pattern, '').ok;

describe('a regex the matcher must ACCEPT', () => {
  // Every one of these is a pattern somebody would reasonably type into a search
  // box, and each must survive: a false positive rejects a query the user
  // legitimately wants. Under the old screen, eight of them were refused.
  const legitimate = [
    // Bounded groups. All were refused by the screen.
    '^([A-Z]{3}-){1,4}[0-9]{2}$',
    String.raw`^(\d{4}){2}$`,
    String.raw`(\d{2,4}){1,2}`,
    '(a{2}){3}',
    '^(ab{1,2}){1,3}$',
    // Alternation between branches that really differ.
    '(a|b)*',
    '(cat|car|dog)*',
    '(abc)*',
    '^(GET|POST|PUT|DELETE) /.*$',
    // Ordinary anchored patterns.
    String.raw`^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$`,
    String.raw`^\d{3}-\d{2}-\d{4}$`,
    String.raw`^(?:\d{1,3}\.){3}\d{1,3}$`,
    '^#?([a-f0-9]{6}|[a-f0-9]{3})$',
    String.raw`^v?\d+\.\d+\.\d+(-[\w.]+)?$`,
    String.raw`^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$`,
    String.raw`^(?<year>\d{4})-(?<month>\d{2})$`,
    '(?:ab)+',
    String.raw`\b\w+\b`,
    '[^"]*',
  ];

  for (const pattern of legitimate) {
    it(`allows ${pattern}`, () => {
      expect(screened(pattern)).toBe(true);
    });
  }
});

describe('a regex that used to be refused now runs, safely', () => {
  /*
   * These are the classic catastrophic shapes. Under `RegExp` each one takes
   * seconds to minutes on a subject under 40 characters, which is why three
   * successive versions of this package tried to SCREEN for them — and why all
   * three were bypassable, the last accepting `^(a+){1,99}$` while refusing
   * `^(a+)+$`.
   *
   * They are no longer refused, because they are no longer dangerous: the
   * matcher is an automaton, so every one of them is linear. Refusing a
   * legitimate pattern was always a cost; now there is nothing bought with it.
   */
  const formerlyCatastrophic = [
    '(a+)+',
    '(a*)*',
    '((a+))+',
    String.raw`(\d+){2,}`,
    '([a-z]+)*',
    '(a+)*b',
    '(.*)*',
    '^(([a-z])+.)+[A-Z]([a-z])+$',
    '(a?)*',
    '^(a|a?)*$',
    '(x|)*',
    String.raw`(\w+\s?)*`,
    '^(a|a)*$',
    String.raw`^(\s|\s)*$`,
    '^(a+){1,99}$',
    '^((a|a))*$',
    '^([a-z]|[a-c])*$',
  ];

  for (const pattern of formerlyCatastrophic) {
    it(`runs ${pattern} in linear time`, () => {
      const subject = `${'a'.repeat(40)}!`;
      const compiled = compileLinear(pattern, '');

      expect(compiled.ok, pattern).toBe(true);

      const started = Date.now();

      if (compiled.ok) {
        compiled.matcher.test(subject);
      }

      expect(Date.now() - started).toBeLessThan(50);
    });
  }

  it('stays linear as the subject grows', () => {
    const compiled = compileLinear('^(a|a)*$', '');

    expect(compiled.ok).toBe(true);

    if (!compiled.ok) {
      return;
    }

    const time = (length: number): number => {
      const started = Date.now();

      compiled.matcher.test(`${'a'.repeat(length)}!`);

      return Date.now() - started;
    };

    time(1000);

    // Exponential would be astronomically worse across a 4x step; linear is 4x.
    const small = Math.max(time(10_000), 1);

    expect(time(40_000) / small).toBeLessThan(12);
  });
});

describe('a regex the matcher cannot take is refused, not run', () => {
  // Backreferences and lookaround are what make linear matching impossible, so
  // they are the only refusals left — and they are refusals rather than a quiet
  // fallback to the backtracking engine.
  const unsupported = [
    String.raw`(a+)\1`,
    '(?=abc)x',
    '(?!abc)x',
    '(?<=a)b',
    '(?<!a)b',
  ];

  for (const pattern of unsupported) {
    it(`refuses ${pattern}`, () => {
      const compiled = compileLinear(pattern, '');

      expect(compiled.ok, pattern).toBe(false);
    });
  }

  it('says why, and offers the escape hatch', () => {
    try {
      filter(String.raw`v:/(a+)\1/`, [{ v: 'aa' }]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('UNSAFE_PATTERN');
      expect((error as Error).message).toContain('backreference');
      expect((error as { hint: string }).hint).toContain('regexGuard: false');
    }
  });

  it('runs it on the backtracking engine when the caller opts in', () => {
    // `regexGuard: false` means "I trust whoever writes these queries". The risk
    // is then theirs, explicitly, rather than ours by default.
    const engine = createEngine({ regexGuard: false });

    expect(engine.test(String.raw`v:/(a)\1/`, { v: 'aa' })).toBe(true);
  });

  it('refuses an expansion too large to bound', () => {
    // Counted repetitions compile by duplication, so the program has to be
    // capped for the time bound to mean anything.
    expect(compileLinear('(a{100}){100}', '').ok).toBe(false);
  });
});

describe('wildcards are not regexes and cannot backtrack', () => {
  it('is flat in the number of stars', () => {
    // The README warned that unbounded stars were a denial-of-service surface,
    // quoting 2.5ms / 36ms / 852ms and "~6x per star". That was true of the
    // regex-based matcher, which was replaced by a two-pointer glob half an hour
    // after the warning was written. The warning outlived the hazard.
    const rows = [{ name: 'a'.repeat(40) }];
    const time = (query: string): number => {
      const started = Date.now();

      for (let run = 0; run < 200; run += 1) {
        filter(query, rows);
      }

      return Date.now() - started;
    };

    const few = time('name:*a*a*a*b');
    const many = time('name:*a*a*a*a*a*a*a*b');

    // Exponential would be ~6x per star, i.e. ~1000x across those four stars.
    expect(many).toBeLessThan(Math.max(few * 5, 200));
  });

  it('handles a pathological glob against a long value', () => {
    const started = Date.now();

    expect(
      filter(`name:${'*a'.repeat(200)}*b`, [{ name: 'a'.repeat(5000) }]),
    ).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('two engines in one process cannot see each other', () => {
  it('refuses to let a built-in type be mutated', () => {
    /*
     * `engine/registry.ts` promises that a module-level registration "would let
     * one library's custom type silently change how an unrelated library in the
     * same process reads a query" — which is exactly what the stateless built-ins
     * were, since they are module-level singletons and `types.get` is public.
     *
     *     (a.types.get('number') as any).equals = () => true;
     *     b.test('age:999', { age: 1 });   // was true
     */
    const first = createEngine();
    const second = createEngine();

    try {
      (first.types.get('number') as unknown as { equals: unknown }).equals =
        () => true;
    } catch {
      // Strict-mode caller; either way nothing may change.
    }

    expect(second.test('age:999', { age: 1 })).toBe(false);
    expect(matches('age:999', { age: 1 })).toBe(false);
  });

  it('freezes the ordering object too', () => {
    // Otherwise `type.ordering.compare` stays writable and nothing is gained.
    const engine = createEngine();
    const other = createEngine();

    try {
      (
        engine.types.get('number') as unknown as {
          ordering: { compare: unknown };
        }
      ).ordering.compare = () => 0;
    } catch {
      // As above.
    }

    expect(other.test('age:>5', { age: 1 })).toBe(false);
  });

  it('gives each engine its own datetime type', () => {
    // It is a factory, because it must close over THIS engine's dateFormat.
    const first = createEngine({ dateFormat: 'DD-MM-YYYY' });
    const second = createEngine();

    expect(first.types.get('datetime')).not.toBe(second.types.get('datetime'));
    expect(matches('d:01-06-2020', { d: '2020-06-01' })).toBe(false);
    expect(first.test('d:01-06-2020', { d: '2020-06-01' })).toBe(true);
  });

  it('leaves a consumer’s own type object alone', () => {
    // Freezing it would be a side effect on their data. A type that lazily
    // caches on itself is unusual but legitimate, and it is theirs.
    const mine = {
      coerceValue: () => ({ kind: 'miss' as const, ok: false as const }),
      equals: () => true,
      name: 'mine',
      parseOperand: () => ({ ok: true as const, value: 1 }),
    };

    createEngine({ types: [mine as never] });

    expect(Object.isFrozen(mine)).toBe(false);
  });
});
