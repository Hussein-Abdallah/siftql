import { describe, expect, it } from 'vitest';

import { assessPattern } from '../src/engine/redos.js';
import { createEngine, filter, SiftQLOperandError } from '../src/index.js';

/** Input that makes a nested-quantifier pattern hang. */
const ADVERSARIAL = 'a'.repeat(30) + '!';
const ROWS = [{ v: ADVERSARIAL }];

const refuses = (pattern: string): boolean =>
  assessPattern(pattern, 1000) !== null;

describe('refuses nested quantifiers', () => {
  // The shape behind essentially every real ReDoS report: a repeated group
  // that itself repeats, letting the engine partition input exponentially.
  const DANGEROUS = [
    '^(a+)+$',
    '(a*)*',
    '(\\d+){2,}',
    '(a+|b)+',
    '((a|b)*)*',
    '(x(y+))+',
  ];

  for (const pattern of DANGEROUS) {
    it(`refuses /${pattern}/`, () => {
      expect(refuses(pattern)).toBe(true);
    });
  }

  it('sees through an extra layer of grouping', () => {
    // The inner group closes WITHOUT a quantifier of its own, so the fact that
    // its body was quantified has to bubble up or the outer group looks clean.
    // This case took 104 seconds to run before it was caught.
    expect(refuses('((a+))+')).toBe(true);
    expect(refuses('(((a+)))+')).toBe(true);
  });
});

describe('allows legitimate patterns', () => {
  // Precision matters more than recall: a false positive rejects a query the
  // user legitimately wants, to guard against a case the screen cannot see.
  const SAFE = [
    '^a+$',
    'a+b+',
    '(a|b)*',
    '(abc)*',
    '(foo|bar)+',
    '(ab)?c',
    '(a+)b*',
    '(a)(b+)',
    String.raw`^\d{4}-\d{2}$`,
  ];

  for (const pattern of SAFE) {
    it(`allows /${pattern}/`, () => {
      expect(refuses(pattern)).toBe(false);
    });
  }

  it('does not read a quantifier inside a character class as an operator', () => {
    expect(refuses('[a+]+')).toBe(false);
    expect(refuses('[*+]{2,}')).toBe(false);
  });

  it('does not read an ESCAPED parenthesis as a group', () => {
    expect(refuses(String.raw`\(a+\)+`)).toBe(false);
  });
});

describe('length cap', () => {
  it('accepts a pattern under the limit', () => {
    expect(assessPattern('a'.repeat(900), 1000)).toBeNull();
  });

  it('refuses one over it, and says the limit', () => {
    const risk = assessPattern('a'.repeat(1200), 1000);

    expect(risk?.reason).toContain('1200');
    expect(risk?.hint).toContain('1000');
  });
});

describe('through the engine', () => {
  it('refuses a dangerous pattern instead of hanging', () => {
    // Without the guard this call does not return.
    expect(() => filter('v:/^(a+)+$/', ROWS)).toThrow(SiftQLOperandError);
  });

  it('reports it as an operand failure with a usable hint', () => {
    try {
      filter('v:/^(a+)+$/', ROWS);
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as SiftQLOperandError;

      expect(failure.code).toBe('OPERAND');
      expect(failure.message).toContain('nested quantifier');
      expect(failure.hint).toContain('a+');
    }
  });

  it('stops resolution rather than falling through to string', () => {
    // Falling through would silently turn a regex query into a literal one,
    // which is a wrong answer rather than a refused one.
    expect(() => filter('v:/(a*)*/', ROWS)).toThrow(SiftQLOperandError);
  });

  it('still runs ordinary regex queries', () => {
    expect(filter('v:/^a+!$/', ROWS)).toHaveLength(1);
    expect(filter('v:/(a|b)+/', ROWS)).toHaveLength(1);
  });

  it('runs siftql-generated wildcards unscreened, since they cannot nest', () => {
    // The compiler emits only [\s\S]* and [\s\S]; there is nothing to guard.
    expect(filter('v:*a*a*a*a*a*a*a*a*', ROWS)).toHaveLength(1);
    expect(filter(`v:${'*'.repeat(20)}`, ROWS)).toHaveLength(1);
  });
});

describe('policy is configurable', () => {
  it('can be turned off for trusted query authors', () => {
    const unguarded = createEngine({ regexGuard: false });

    // The pattern is accepted -- deliberately not executed here, because
    // without the guard it does not terminate.
    expect(() => unguarded.parse('v:/^(a+)+$/')).not.toThrow();
    expect(unguarded.options.regexGuard).toBe(false);
  });

  it('honours a custom length limit', () => {
    const strict = createEngine({ maxPatternLength: 10 });

    expect(() => strict.filter(`v:/${'a'.repeat(20)}/`, ROWS)).toThrow(
      SiftQLOperandError,
    );
    expect(strict.filter('v:/^a+!$/', ROWS)).toHaveLength(1);
  });

  it('can be overridden per call', () => {
    expect(() =>
      filter(`v:/${'a'.repeat(20)}/`, ROWS, { maxPatternLength: 10 }),
    ).toThrow(SiftQLOperandError);
  });
});

describe('a global flag must not make matching stateful', () => {
  // RegExp.prototype.test advances lastIndex when the pattern carries `g`, and
  // the matcher is compiled once and reused for every record. Left unhandled,
  // four identical rows return three matches -- a silently wrong result.
  const identical = [
    { id: 1, v: 'aa' },
    { id: 2, v: 'aa' },
    { id: 3, v: 'aa' },
    { id: 4, v: 'aa' },
  ];

  it('matches every row regardless of the g flag', () => {
    expect(filter('v:/a/', identical).map((row) => row.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(filter('v:/a/g', identical).map((row) => row.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('is unaffected by the sticky flag either', () => {
    expect(filter('v:/a/y', identical).map((row) => row.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(filter('v:/a/gy', identical).map((row) => row.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('keeps flags that genuinely change matching', () => {
    const mixed = [{ v: 'AA' }, { v: 'aa' }];

    expect(filter('v:/a/', mixed)).toHaveLength(1);
    expect(filter('v:/a/i', mixed)).toHaveLength(2);
    expect(filter('v:/a/gi', mixed)).toHaveLength(2);
  });
});
