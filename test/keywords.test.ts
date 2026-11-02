import { describe, expect, it } from 'vitest';

import {
  createEngine,
  filter,
  parse,
  serialize,
  SiftQLConfigError,
  SiftQLSyntaxError,
} from '../src/index.js';

/**
 * LOCALIZED KEYWORDS.
 *
 * The option is additive and changes spelling only: a query written with
 * aliases must produce the AST the English spelling produces, and locations
 * must keep pointing at the text as typed.
 */

const keywords = {
  and: ['ET'],
  not: ['NON', 'SAUF'],
  or: ['OU'],
  to: ['À'],
};

const strip = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, inner: unknown) =>
      key === 'location' ? undefined : inner,
    ),
  );

const sameAst = (french: string, english: string): void => {
  expect(strip(parse(french, { keywords }))).toEqual(strip(parse(english)));
};

describe('localized keywords', () => {
  it('reads each alias as its English operator', () => {
    sameAst('a:x ET b:y', 'a:x AND b:y');
    sameAst('a:x OU b:y', 'a:x OR b:y');
    sameAst('NON a:x', 'NOT a:x');
    sameAst('SAUF a:x', 'NOT a:x');
    sameAst('n:[1 À 5]', 'n:[1 TO 5]');
    sameAst('a:x ET (b:y OU NON c:z)', 'a:x AND (b:y OR NOT c:z)');
  });

  it('keeps the English keywords working', () => {
    sameAst('a:x AND b:y OR NOT c:z', 'a:x AND b:y OR NOT c:z');
    sameAst('n:[1 TO 5]', 'n:[1 TO 5]');
  });

  it('serializes to the English spelling', () => {
    expect(serialize(parse('a:x ET NON b:y', { keywords }))).toBe(
      'a:x AND NOT b:y',
    );
  });

  it('treats an alias as an ordinary term when no keywords are given', () => {
    expect(serialize(parse('a ET b'))).toBe('a ET b');
  });

  it('is case-sensitive, like the English keywords', () => {
    expect(strip(parse('a et b', { keywords }))).toEqual(
      strip(parse('a et b')),
    );
    expect(strip(parse('a and b', { keywords }))).toEqual(
      strip(parse('a and b')),
    );
  });

  it('does not treat quoted, escaped or valued text as an operator', () => {
    expect(strip(parse('name:"Dupont ET fils"', { keywords }))).toEqual(
      strip(parse('name:"Dupont ET fils"')),
    );
    expect(strip(parse('name:ET', { keywords }))).toEqual(
      strip(parse('name:ET')),
    );
    expect(strip(parse('\\ET', { keywords }))).toEqual(strip(parse('\\ET')));
    expect(strip(parse('"OU"', { keywords }))).toEqual(strip(parse('"OU"')));
  });

  it('does not read an alias followed by a colon as an operator', () => {
    expect(strip(parse('ET:x', { keywords }))).toEqual(strip(parse('ET:x')));
  });

  it('keeps locations on the text as typed', () => {
    const ast = parse('a:x ET b:y', { keywords });

    expect(ast.type).toBe('LogicalExpression');
    expect(ast.location).toEqual({ end: 10, start: 0 });
  });

  it('points an error at the original text', () => {
    let error: unknown;

    try {
      parse('a:x ET b:', { keywords });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SiftQLSyntaxError);
    expect((error as SiftQLSyntaxError).message).toContain('b:');
  });

  it('suggests a quoted value up to the next localized operator', () => {
    expect(() => parse('a: un deux ET b:y', { keywords })).toThrow(
      /Did you mean a:"un deux"\?/u,
    );
  });

  it('filters rows with a localized query', () => {
    const rows = [
      { city: 'Ottawa', n: 3 },
      { city: 'Ottawa', n: 9 },
      { city: 'Lyon', n: 3 },
    ];

    expect(
      filter(parse('city:Ottawa ET n:[1 À 5]', { keywords }), rows),
    ).toEqual([{ city: 'Ottawa', n: 3 }]);
    expect(
      filter(parse('city:Ottawa ET NON n:[1 À 5]', { keywords }), rows),
    ).toEqual([{ city: 'Ottawa', n: 9 }]);
    expect(filter(parse('city:Lyon OU n:9', { keywords }), rows)).toEqual([
      { city: 'Ottawa', n: 9 },
      { city: 'Lyon', n: 3 },
    ]);
  });

  it('works in tolerant mode', () => {
    expect(() => parse('a:x ET ', { keywords, tolerant: true })).not.toThrow();
  });

  it('is honoured by the string-query methods of an engine', () => {
    const rows = [{ alert: true }, { alert: false }];
    const engine = createEngine({ keywords: { not: ['SAUF'], or: ['OU'] } });

    expect(engine.filter('SAUF alert:true', rows)).toEqual([{ alert: false }]);
    expect(engine.test('SAUF alert:true', { alert: false })).toBe(true);
    expect(
      engine.highlight('alert:false OU alert:true', rows[0]!),
    ).toHaveLength(1);
  });

  it('uses the engine-wide keywords, and lets extend() carry them', () => {
    const engine = createEngine({ keywords: { and: ['ET'] } });
    const child = engine.extend({ matchKeys: false });

    expect(strip(engine.parse('a ET b'))).toEqual(strip(parse('a AND b')));
    expect(strip(child.parse('a ET b'))).toEqual(strip(parse('a AND b')));
    expect(engine.filter('a:1 ET b:2', [{ a: 1, b: 2 }])).toHaveLength(1);
  });

  it('is honoured by engine.parse', () => {
    const engine = createEngine();

    expect(strip(engine.parse('a:x ET b:y', { keywords }))).toEqual(
      strip(parse('a:x AND b:y')),
    );
  });
});

describe('keywords validation', () => {
  const bad = (value: unknown): void => {
    expect(() => parse('a', { keywords: value } as never)).toThrow(
      SiftQLConfigError,
    );
  };

  it('rejects a non-object', () => {
    bad('ET');
    bad(['ET']);
    bad(null);
  });

  it('rejects a non-array or non-string alias list', () => {
    bad({ and: 'ET' });
    bad({ and: [1] });
    bad({ and: [''] });
  });

  it('rejects an alias the tokenizer could not read as one word', () => {
    bad({ and: ['E T'] });
    bad({ and: ['E:T'] });
    bad({ and: ['"ET"'] });
    bad({ and: ['-ET'] });
    bad({ and: ['true'] });
  });

  it('rejects an alias that is another operator in English', () => {
    bad({ and: ['OR'] });
    bad({ or: ['AND'] });
    bad({ not: ['TO'] });
  });

  it('accepts restating the English keyword under its own operator', () => {
    expect(() =>
      parse('a AND b', { keywords: { and: ['AND'] } }),
    ).not.toThrow();
  });

  it('rejects unknown keys, oversized lists and over-long aliases', () => {
    bad({ AND: ['ET'] });
    bad({ bogus: ['ET'] });
    bad({ and: Array.from({ length: 33 }, (_, i) => `W${String(i)}`) });
    bad({ and: ['A'.repeat(65)] });
  });

  it('turns a hostile accessor or proxy into a config error', () => {
    bad({
      get and(): string[] {
        throw new Error('x');
      },
    });
    bad({
      and: new Proxy(['ET'], {
        get: () => {
          throw new Error('p');
        },
      }),
    });
    bad(
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('k');
          },
        },
      ),
    );

    const indexed = ['ET'];

    Object.defineProperty(indexed, 0, {
      get: () => {
        throw new Error('i');
      },
    });
    bad({ and: indexed });
  });

  it('matches an alias in either Unicode form', () => {
    const nfc = '\u00C0';
    const nfd = 'A\u0300';

    expect(strip(parse(`n:[1 ${nfd} 5]`, { keywords: { to: [nfc] } }))).toEqual(
      strip(parse('n:[1 TO 5]')),
    );
    expect(strip(parse(`n:[1 ${nfc} 5]`, { keywords: { to: [nfd] } }))).toEqual(
      strip(parse('n:[1 TO 5]')),
    );
  });

  it('rejects one word under two operators', () => {
    bad({ and: ['X'], or: ['X'] });
  });

  it('copies the option so later mutation cannot change it', () => {
    const aliases = { and: ['ET'] };
    const ast = parse('a ET b', { keywords: aliases });

    aliases.and.push('PLUS');

    expect(strip(ast)).toEqual(strip(parse('a AND b')));
    expect(strip(parse('a PLUS b', { keywords: aliases }))).toEqual(
      strip(parse('a AND b')),
    );
  });
});
