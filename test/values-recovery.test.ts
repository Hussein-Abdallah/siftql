import { describe, expect, it } from 'vitest';

import {
  createEngine,
  filter,
  highlight,
  parse,
  resolveTemporal,
  serialize,
  SiftQLConfigError,
  SiftQLDateFormatError,
  SiftQLSyntaxError,
  SiftQLValueError,
  test as matches,
} from '../src/index.js';

/**
 * THE VALUE LAYER (G3) AND RECOVERY (G4).
 *
 * Two themes run through these.
 *
 * The first is that an EXPLICIT INSTRUCTION must beat a built-in guess. A
 * declared `dateFormat` was silently overridden by the ISO parser for exactly
 * the values both could read, so one column meant two things depending on the
 * day of the month.
 *
 * The second is that a SAFETY SWITCH must fail closed. `onRecovered: 'throw'`
 * exists for callers who must never act on a guess, and it was walking past the
 * recovered nodes that mattered.
 */

const JUNE_1_2020 = Date.UTC(2020, 5, 1);

describe('numeric spellings', () => {
  it('matches an integer written with leading zeros', () => {
    // The guard's comment said it refused "only integers the double ACTUALLY
    // collapses"; it compared SPELLINGS, so every non-canonical form fell
    // through to `string`. Zero-padded ids arrive from forms, URLs and CSVs
    // constantly.
    expect(matches('n:007', { n: 7 })).toBe(true);
    expect(matches('n:-0', { n: 0 })).toBe(true);
    expect(matches('n:+7', { n: 7 })).toBe(true);
  });

  it('orders an integer written with leading zeros instead of throwing', () => {
    // Worse than a non-match: falling through to `string` meant `n:>007` threw
    // "Type string has no ordering", so a zero-padded value could not be
    // compared at all.
    expect(matches('n:>007', { n: 8 })).toBe(true);
    expect(matches('n:>007', { n: 6 })).toBe(false);
    expect(matches('n:>-0', { n: 1 })).toBe(true);
  });

  it('still declines an integer the double really does collapse', () => {
    // The point of the guard, and it must survive the fix: two visibly different
    // ids must not compare equal.
    expect(matches('n:9007199254740993', { n: 9_007_199_254_740_992 })).toBe(
      false,
    );
    // Built via Number() rather than written as a literal: the whole point is
    // that this value cannot be spelled exactly as a double, which is what the
    // no-loss-of-precision lint rule exists to warn about.
    expect(
      matches('n:1234567890123456789', {
        n: Number('1234567890123456780'),
      }),
    ).toBe(false);
  });

  it('still compares such an id exactly, as text', () => {
    expect(matches('n:1234567890123456789', { n: '1234567890123456789' })).toBe(
      true,
    );
  });
});

describe('a declared dateFormat outranks the built-in ISO parser', () => {
  it('reads every value through the declared layout', () => {
    // Under YYYY-DD-MM, `2020-11-06` was read as ISO (6 November) while
    // `2020-20-07` was read through the layout (20 July), because a day of 20
    // fails the ISO month group. One column, two meanings, split on whether the
    // day happened to be 12 or less.
    const options = { dateFormat: 'YYYY-DD-MM' } as const;

    expect(resolveTemporal('2020-11-06', options)?.value).toBe(
      Date.UTC(2020, 5, 11),
    );
    expect(resolveTemporal('2020-20-07', options)?.value).toBe(
      Date.UTC(2020, 6, 20),
    );
  });

  it('still resolves ISO for values the layout cannot read', () => {
    // Declaring a layout for one column must not break an ISO timestamp in
    // another.
    expect(
      resolveTemporal('2020-06-01T00:00:00Z', { dateFormat: 'YYYYMMDD' })
        ?.value,
    ).toBe(JUNE_1_2020);
  });

  it('lets parseDate override the layout, and null defer to it', () => {
    expect(
      resolveTemporal('01-06-2020', {
        dateFormat: 'DD-MM-YYYY',
        parseDate: () => new Date(0),
      })?.value,
    ).toBe(0);

    expect(
      resolveTemporal('01-06-2020', {
        dateFormat: 'DD-MM-YYYY',
        parseDate: () => null,
      })?.value,
    ).toBe(JUNE_1_2020);
  });
});

describe('a malformed dateFormat is refused when the engine is built', () => {
  it('refuses a layout with no recognisable token', () => {
    // Building happily and failing on whichever record first holds
    // something date-shaped, reported as an OPERAND error with the real cause
    // demoted to `.cause` — so a caller checking for CONFIG never saw it.
    expect(() => createEngine({ dateFormat: 'QQQQ' })).toThrow(
      SiftQLDateFormatError,
    );
    expect(() => createEngine({ dateFormat: ['YYYY-MM-DD', 'QQQQ'] })).toThrow(
      SiftQLDateFormatError,
    );
  });

  it('refuses an empty array, which declares nothing', () => {
    expect(() => createEngine({ dateFormat: [] })).toThrow(SiftQLConfigError);
  });

  it('accepts a real layout', () => {
    expect(() => createEngine({ dateFormat: 'YYYY-MM-DD' })).not.toThrow();
  });

  it('reports it under a prefixed name', () => {
    // errors.ts states that every siftql error name is prefixed. This class was
    // `InvalidDateFormatError`, which reads like a host-application error in a
    // stack trace, and was the one subclass missing from the package exports.
    try {
      createEngine({ dateFormat: 'QQQQ' });
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('SiftQLDateFormatError');
      expect((error as { code: string }).code).toBe('CONFIG');
    }
  });
});

describe(':= can state equality against every literal it compares', () => {
  it('accepts a boolean and null', () => {
    // The README calls `:=` "equality (same as ':' for a fielded clause)", and
    // it was not: `b:true` worked while `b:=true` was a syntax error, so the one
    // operator whose whole job is strict equality could not express it against
    // the two values that have nothing but equality.
    expect(matches('b:=true', { b: true })).toBe(true);
    expect(matches('b:=false', { b: false })).toBe(true);
    expect(matches('b:=null', { b: null })).toBe(true);
    expect(matches('b:=true', { b: false })).toBe(false);
  });

  it('round-trips those forms', () => {
    for (const query of ['b:=true', 'b:=false', 'b:=null', 'b:=5']) {
      expect(serialize(parse(query)), query).toBe(query);
    }
  });

  it('still refuses an ordered comparison against them', () => {
    // There is no ordering to appeal to, so this stays a syntax error.
    expect(() => parse('b:>true')).toThrow(SiftQLSyntaxError);
    expect(() => parse('b:>=null')).toThrow(SiftQLSyntaxError);
  });
});

describe("onRecovered: 'throw' fails closed", () => {
  const strict = createEngine({ onRecovered: 'throw', tolerant: true });

  // Each of these marks the BOUNDARY rather than the range node, and the walk
  // stopped at the RangeExpression — so the switch saw nothing to refuse and the
  // engine evaluated an unbounded end the user never typed. `a:[` and `a:` were
  // refused correctly the whole time, which is what made this look fixed.
  const guesses = ['a:[1}', 'a:{}', 'a:[ TO 9]', 'a:[1 TO }', 'a:[', 'a:'];

  for (const query of guesses) {
    it(`refuses ${JSON.stringify(query)}`, () => {
      expect(() => strict.test(query, { a: 5 })).toThrow();
    });
  }

  it('still prunes rather than refuses under the default policy', () => {
    const lenient = createEngine({ onRecovered: 'prune', tolerant: true });

    expect(() => lenient.test('a:[1}', { a: 5 })).not.toThrow();
  });
});

describe('a highlight can always be iterated', () => {
  it('reports no pattern when the match is zero-width', () => {
    // Global `a*` matches "a" at 0, then the empty string at 1, and lastIndex
    // never advances again — so the documented loop spins forever. Checking only
    // the FIRST match was not enough, because that first match is well-behaved.
    for (const pattern of [
      '/a*/',
      '/(?:)/',
      '/^/',
      String.raw`/\b/`,
      '/[0-9]*/',
    ]) {
      const [hit] = highlight(`v:${pattern}`, { v: 'abcdef' });

      expect(hit, pattern).toBeDefined();
      expect(hit?.query ?? null, pattern).toBeNull();
    }
  });

  it('reports a user regex as RANGES, never as a RegExp', () => {
    /*
     * Handing out a `RegExp` puts the consumer on the backtracking engine, in
     * the `exec` loop the contract tells them to write — so a pattern this
     * matcher runs in milliseconds can take them seconds. Spans are data;
     * there is nothing in them to run.
     */
    const [hit] = highlight('v:/a+/', { v: 'aabca' });

    expect(hit?.query ?? null).toBeNull();
    expect(hit?.ranges).toEqual([
      { end: 2, start: 0 },
      { end: 5, start: 4 },
    ]);
  });

  it('reports a wildcard hit as spans, so there is nothing to run', () => {
    // No RegExp is handed out for a wildcard either: spans are data, and they
    // say exactly what matching said, which an `iu` pattern cannot.
    const [hit] = highlight('v:*ab*', { v: 'aabca' });

    expect(hit?.query).toBeUndefined();
    expect(hit?.ranges).toEqual([{ end: 3, start: 1 }]);
  });

  it('reports the whole value as the match when there is no pattern', () => {
    const [hit] = highlight('v:/a*/', { v: 'abcdef' });

    expect(hit?.path).toBe('v');
  });
});

describe("AND does not short-circuit under onValueError: 'throw'", () => {
  const strict = createEngine({ onValueError: 'throw' });
  const rows = [{ a: 'nope', b: 'n/a' }];

  it('reports a dirty value whichever side of the AND it is on', () => {
    // `a:zzz AND b:>2020-01-01` quietly returned no rows while
    // `b:>2020-01-01 AND a:zzz` threw, for the same data. Whether you are told a
    // column is unusable should not depend on the order you wrote your clauses.
    expect(() => strict.filter('a:zzz AND b:>2020-01-01', rows)).toThrow(
      SiftQLValueError,
    );
    expect(() => strict.filter('b:>2020-01-01 AND a:zzz', rows)).toThrow(
      SiftQLValueError,
    );
  });

  it('still short-circuits under the default policy', () => {
    // Under 'skip' a dirty value is just a non-match, so skipping the right
    // operand cannot change the answer — and the saving is worth keeping.
    expect(filter('a:zzz AND b:>2020-01-01', rows)).toHaveLength(0);
  });

  it('gives the same answer either way', () => {
    const both = [{ a: 'yes', b: '2021-01-01' }, ...rows];

    expect(filter('a:yes AND b:>2020-01-01', both)).toHaveLength(1);
    expect(filter('b:>2020-01-01 AND a:yes', both)).toHaveLength(1);
  });
});
