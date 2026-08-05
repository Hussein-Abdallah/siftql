import { describe, expect, it } from 'vitest';

import {
  createEngine,
  filter,
  SiftQLOperandError,
  SiftQLValueError,
} from '../src/index.js';

/**
 * The `datetime` value type specifically — its claiming rules and its
 * MISS-versus-INVALID split, which is what makes dirty data a policy decision
 * rather than a silent non-match.
 */

const strict = { onValueError: 'throw' } as const;

describe('what datetime claims from the query side', () => {
  it('claims anything shaped like a date', () => {
    const rows = [{ d: '2020-06-15' }];

    expect(filter('d:>=2020-01-01', rows)).toHaveLength(1);
    expect(filter('d:>=2020-06-15T00:00:00Z', rows)).toHaveLength(1);
  });

  it('DECLINES a bare number, so height:>1000 stays numeric', () => {
    // If datetime claimed numbers, every numeric comparison would silently
    // become a date comparison against an epoch.
    expect(filter('h:>1000', [{ h: 2000 }])).toHaveLength(1);
    expect(filter('h:>1000', [{ h: 500 }])).toHaveLength(0);
  });

  it('DECLINES ordinary text, so it falls through to string', () => {
    expect(filter('name:ada', [{ name: 'ada' }])).toHaveLength(1);
  });

  it('claims a bare time and keeps it in its own domain', () => {
    const rows = [{ at: '14:30' }, { at: '09:00' }];

    expect(filter('at:>=12:00', rows)).toEqual([{ at: '14:30' }]);
  });

  it('refuses a value shaped like a date that is not one', () => {
    // Shaped like a date means the user MEANT a date, so degrading to a string
    // comparison that quietly returns nothing would be the wrong answer.
    expect(() => filter('d:>=2021-02-29', [{ d: '2020-01-01' }])).toThrow(
      SiftQLOperandError,
    );
    expect(() => filter('d:2021-02-29', [{ d: '2020-01-01' }])).toThrow(
      SiftQLOperandError,
    );
  });

  it('explains itself differently for an ordered site than a match site', () => {
    try {
      filter('d:>=2021-02-29', [{ d: 1 }]);
      expect.unreachable('should have thrown');
    } catch (error) {
      // An ordered site gets the full list of accepted layouts.
      expect((error as SiftQLOperandError).hint).toContain('ISO 8601');
    }
  });
});

describe('what datetime accepts from the data side', () => {
  const query = 'd:>=2020-01-01';

  it('reads ISO strings, epoch numbers and Date objects', () => {
    expect(
      filter(query, [
        { d: '2020-06-15T10:00:00Z' },
        { d: 1_593_000_000_000 },
        { d: new Date('2021-03-01T00:00:00Z') },
      ]),
    ).toHaveLength(3);
  });

  it('MISSES the wrong JS shape at a MATCH site, without erroring', () => {
    // `d:2020-01-01` asks whether the field equals a date. A boolean or an
    // object is the wrong SHAPE -- simply not that date -- so it is a
    // non-match, never an error, whatever onValueError says.
    for (const value of [true, false, { nested: 1 }, null, undefined]) {
      expect(() =>
        filter('d:2020-01-01', [{ d: value }], strict),
      ).not.toThrow();
      expect(filter('d:2020-01-01', [{ d: value }])).toHaveLength(0);
    }
  });

  it('treats the RIGHT shape with wrong content as dirty data', () => {
    // A string is the right shape; 'n/a' is impossible content. THAT is what
    // onValueError governs, and it applies even at a match site.
    expect(filter('d:2020-01-01', [{ d: 'n/a' }])).toHaveLength(0);
    expect(() => filter('d:2020-01-01', [{ d: 'n/a' }], strict)).toThrow(
      SiftQLValueError,
    );
  });

  it('holds an ORDERED site to a stricter standard than a match site', () => {
    // `d:>=2020-01-01` is an ASSERTION by the query author that `d` is
    // temporal. A value that is not is dirty data even when it is merely the
    // wrong shape, so `miss` is an error here where it was a non-match above.
    expect(() => filter(query, [{ d: true }], strict)).toThrow(
      SiftQLValueError,
    );
    expect(filter(query, [{ d: true }])).toHaveLength(0);
  });

  it('never errors on an unfielded scan, at any strictness', () => {
    // One dirty column must not be able to destroy a free-text search.
    expect(() =>
      filter('anything', [{ d: 'n/a' }, { d: true }], strict),
    ).not.toThrow();
  });

  it('flattens an array and judges each element', () => {
    expect(filter(query, [{ d: ['2019-01-01', '2021-01-01'] }])).toHaveLength(
      1,
    );
    expect(filter(query, [{ d: [] }])).toHaveLength(0);
  });

  it('treats an Invalid Date as dirty content too', () => {
    expect(() => filter(query, [{ d: new Date('nonsense') }], strict)).toThrow(
      SiftQLValueError,
    );
  });

  it('refuses to compare across domains rather than guessing', () => {
    // A wall-clock time and a calendar date sit on different lines.
    expect(filter('at:>=2020-01-01', [{ at: '14:30' }])).toHaveLength(0);
    expect(() => filter('at:>=2020-01-01', [{ at: '14:30' }], strict)).toThrow(
      SiftQLValueError,
    );
  });
});

describe('the engine binds datetime to ITS options, not a global', () => {
  const rows = [{ d: '01-06-2020' }, { d: '15-06-2020' }];

  it('reads a declared layout', () => {
    const european = createEngine({ dateFormat: 'DD-MM-YYYY' });

    expect(european.filter('d:>=05-06-2020', rows)).toEqual([
      { d: '15-06-2020' },
    ]);
  });

  it('lets two engines disagree without either knowing the other exists', () => {
    const european = createEngine({ dateFormat: 'DD-MM-YYYY' });
    const american = createEngine({ dateFormat: 'MM-DD-YYYY' });

    expect(european.filter('d:>=05-06-2020', rows)).toHaveLength(1);
    // Under MM-DD-YYYY neither value is a real date, so nothing matches.
    expect(american.filter('d:>=05-06-2020', rows)).toHaveLength(0);
  });

  it('does not poison the default engine, which still refuses the layout', () => {
    createEngine({ dateFormat: 'DD-MM-YYYY' });

    // The default engine has no layout declared, so `05-06-2020` is not a date.
    // It falls through to `string`, which has no ordering -- and the comparison
    // THROWS rather than quietly returning nothing. That is the guarantee.
    expect(() => filter('d:>=05-06-2020', rows)).toThrow(SiftQLOperandError);
  });

  it('routes parseDate through, including for numbers', () => {
    const seconds = createEngine({
      parseDate: (value) =>
        typeof value === 'number' ? new Date(value * 1000) : null,
    });

    expect(
      seconds.filter('at:>=2020-01-01', [{ at: 1_593_000_000 }]),
    ).toHaveLength(1);
  });

  it('lets an engine accept a layout the default engine refuses', () => {
    const custom = createEngine({ dateFormat: 'DD-MM-YYYY' });

    expect(custom.filter('d:15-06-2020', rows)).toHaveLength(1);
    // The default engine does not know that layout, so nothing claims it as a
    // date and it compares as an ordinary string.
    expect(filter('d:15-06-2020', rows)).toEqual([{ d: '15-06-2020' }]);
  });
});
