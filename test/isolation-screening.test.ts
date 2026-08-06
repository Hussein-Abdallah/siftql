import { describe, expect, it } from 'vitest';

import { createEngine, filter, test as matches } from '../src/index.js';
import { assessPattern } from '../src/engine/redos.js';

/**
 * ENGINE ISOLATION AND PATTERN SCREENING (G6).
 *
 * Both halves here were promises the package made and did not keep: that two
 * engines in one process cannot see each other, and that a user-supplied regex is
 * screened for catastrophic backtracking.
 *
 * The screening tests are written as a CORPUS rather than as a list of shapes,
 * because the previous screen was wrong in both directions at once — refusing
 * `^([A-Z]{3}-){1,4}[0-9]{2}$`, which runs in 0.01 ms, while passing `(a|a)*`,
 * which blocks the event loop for four seconds. A test naming only the shapes
 * the implementation already knew about would have passed throughout.
 */

const screened = (pattern: string): boolean =>
  assessPattern(pattern, 1000) === null;

describe('a regex the screen must ALLOW', () => {
  // Every one of these is a pattern somebody would reasonably type into a search
  // box, and each must survive: a false positive rejects a query the user
  // legitimately wants, which the module's own doc calls the thing to avoid.
  const legitimate = [
    // Bounded groups: finite match tree, however nested. All were refused.
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
    '^(?!x)y+$',
    String.raw`\b\w+\b`,
    '[^"]*',
  ];

  for (const pattern of legitimate) {
    it(`allows ${pattern}`, () => {
      expect(screened(pattern)).toBe(true);
    });
  }
});

describe('a regex the screen must REFUSE', () => {
  const catastrophic = [
    // Nested unbounded quantifier — the classic, always caught.
    '(a+)+',
    '(a*)*',
    '((a+))+',
    String.raw`(\d+){2,}`,
    '([a-z]+)*',
    '(a+)*b',
    '(.*)*',
    '^(([a-z])+.)+[A-Z]([a-z])+$',
    // A repeated group that can match nothing. The old screen excluded `?`
    // outright, on the stated grounds that it "cannot drive exponential
    // backtracking on its own" — which `(a|a?)*` falsifies.
    '(a?)*',
    '^(a|a?)*$',
    '(x|)*',
    String.raw`(\w+\s?)*`,
    // Two identical alternatives: two ways to match the same text at every
    // position. Not a nested quantifier at all, so the old screen never saw it.
    '^(a|a)*$',
    String.raw`^(\s|\s)*$`,
  ];

  for (const pattern of catastrophic) {
    it(`refuses ${pattern}`, () => {
      expect(screened(pattern)).toBe(false);
    });
  }

  it('explains which of the three shapes it found', () => {
    expect(assessPattern('(a+)+', 1000)?.reason).toContain('nested quantifier');
    expect(assessPattern('(a?)*', 1000)?.reason).toContain('match nothing');
    expect(assessPattern('(a|a)*', 1000)?.reason).toContain(
      'identical alternatives',
    );
  });

  it('treats an absurd bound as unbounded', () => {
    // Otherwise `{1,999999}` is an obvious way around the screen.
    expect(screened('(a+){1,999999}')).toBe(false);
  });

  it('still enforces the length cap', () => {
    expect(assessPattern('a'.repeat(1200), 1000)?.reason).toContain(
      'over the 1000-character limit',
    );
  });
});

describe('a refused pattern reports the documented code', () => {
  it('uses UNSAFE_PATTERN, not the generic OPERAND', () => {
    // `UNSAFE_PATTERN` was declared in errors.ts, described, and unreachable:
    // both rejection paths reported OPERAND, so a consumer could not tell "that
    // pattern was refused as unsafe" from "that is not a valid operand".
    for (const query of ['v:/^(a+)+$/', `v:/${'a'.repeat(1200)}/`]) {
      try {
        filter(query, [{ v: 'x' }]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as { code: string }).code, query).toBe('UNSAFE_PATTERN');
      }
    }
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
