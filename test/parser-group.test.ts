import { describe, expect, it } from 'vitest';

import {
  createEngine,
  MAX_CLAUSES,
  MAX_DEPTH,
  parse,
  serialize,
  SiftQLSyntaxError,
  test as matches,
  type SiftQLAst,
} from '../src/index.js';

/**
 * FIELD GROUPS, THE NEGATIVE FOLD, AND TOLERANT RECOVERY.
 *
 * A field group is one clause whose body is a list of VALUES for the field
 * already named — `status:(open OR closed)`. Almost every defect here came from
 * that body being read as if it were an ordinary query instead, so a clause
 * meant one thing written `n:-3` and another written `n:(-3)`.
 *
 * The pattern worth noticing: none of these crashed. Every one returned a
 * confident wrong answer, which is why they survived a full suite and 95%
 * coverage.
 */

const strip = (node: SiftQLAst): string =>
  JSON.stringify(node, (key, value: unknown) =>
    key === 'location' ? undefined : value,
  );

/** The round-trip law, stated over one query. */
const roundTrips = (query: string): boolean => {
  const once = serialize(parse(query));

  return (
    strip(parse(once)) === strip(parse(query)) &&
    serialize(parse(once)) === once
  );
};

const repeat = (term: string, count: number): string =>
  Array.from({ length: count }, () => term).join(' ');

describe('the negative fold inside a field group', () => {
  it('reads an adjacent sign as part of the number', () => {
    // A sign adjacent to a number is part of the number. Read as negation,
    // `n:(-3 OR -5)` would become `n:(NOT 3 OR NOT 5)` and match n === 7.
    expect(matches('n:(-3)', { n: -3 })).toBe(true);
    expect(matches('n:(-3)', { n: 7 })).toBe(false);
    expect(matches('n:(-3 OR -5)', { n: 7 })).toBe(false);
  });

  it('keeps a wildcard in the folded value', () => {
    // The fold built a plain text literal by hand, so the WildcardAny segment
    // was destroyed and the two spellings disagreed — silently, and only the
    // unparenthesised one matched.
    expect(matches('n:-3*', { n: '-3xyz' })).toBe(true);
    expect(matches('n:(-3*)', { n: '-3xyz' })).toBe(true);
    expect(matches('n:-3?', { n: '-3x' })).toBe(true);
    expect(matches('n:(-3?)', { n: '-3x' })).toBe(true);
  });

  it('decodes escapes in the folded value', () => {
    expect(matches(String.raw`n:-3\ 4`, { n: '-3 4' })).toBe(true);
    expect(matches(String.raw`n:(-3\ 4)`, { n: '-3 4' })).toBe(true);
  });

  it('counts a folded term against the clause budget', () => {
    // The fold advanced past two tokens without counting a clause, so a folded
    // query sailed past MAX_CLAUSES and emitted a tree deeper than the rest of
    // the package would accept — the parser and serializer disagreed about what
    // was representable.
    const plain = `n:(${repeat('1', MAX_CLAUSES + 1)})`;
    const folded = `n:(${repeat('-1', MAX_CLAUSES + 1)})`;

    expect(() => parse(plain)).toThrow(SiftQLSyntaxError);
    expect(() => parse(folded)).toThrow(SiftQLSyntaxError);
    expect(() => parse(folded)).toThrowError(/more than 2000 clauses/u);
  });

  it('leaves a separated sign as a negation', () => {
    const ast = parse('n:(- 3)');

    expect(strip(ast)).toContain('"operator":"-"');
    expect(roundTrips('n:(- 3)')).toBe(true);
  });

  it('does not let serialize turn a negation into a number', () => {
    // `n:(- 3)` serialized to `n:(-3)`, which re-parsed as the literal -3. A
    // round-trip violation, and a different query.
    expect(serialize(parse('n:(- 3)'))).toBe('n:(- 3)');
    expect(roundTrips('- 3')).toBe(true);
    expect(roundTrips('-3')).toBe(true);
  });

  it('leaves a top-level prohibition alone', () => {
    expect(strip(parse('-foo'))).toContain('"type":"UnaryOperator"');
  });
});

describe('values inside a field group', () => {
  it('accepts an unquoted time and date-time', () => {
    // The body was lexed in default mode, where the first colon starts a field,
    // so `d:(14:30)` was refused as "a field group may not contain another
    // field" while `d:14:30` and `d:[14:30 TO 15:00]` both worked. Needing no
    // quotes around a date-time is the reason the tokenizer has modes at all.
    expect(() => parse('d:(14:30)')).not.toThrow();
    expect(() => parse('d:(14:30 OR 15:00)')).not.toThrow();
    expect(() => parse('d:(2020-06-01T12:00:00Z OR 2021-01-01)')).not.toThrow();

    expect(matches('d:(14:30)', { d: '14:30' })).toBe(true);
    expect(matches('d:(14:30 OR 15:00)', { d: '15:00' })).toBe(true);
    expect(matches('d:(14:30)', { d: '09:00' })).toBe(false);
  });

  it('round-trips a colon in a group body', () => {
    for (const query of [
      'd:(14:30)',
      'd:(14:30 OR 15:00)',
      'd:(2020-06-01T12:00:00Z OR 2021-01-01)',
      'n:([1 TO 9] OR 20)',
      'status:(open OR closed)',
    ]) {
      expect(roundTrips(query), query).toBe(true);
    }
  });

  it('reads a colon in a body as a value, with no exceptions', () => {
    /*
     * The rule is the grammar's: a group body is a list of VALUES, so a colon
     * in one is text. `name:(first:ada)` searches `name` for the literal
     * `first:ada`, which is what `name:"first:ada"` already means.
     *
     * A shape heuristic cannot do better — `14:30` and `first:ada` are the same
     * shape — and refusing by one would make catching a mistake depend on the
     * punctuation in the field name.
     */
    expect(matches('name:(first:ada)', { name: 'first:ada' })).toBe(true);
    expect(matches('name:(first:ada)', { name: 'ada' })).toBe(false);

    // The same answer for every value, which is what a heuristic could not give.
    for (const value of ['14:30', 'http://example.com', 'a:b', '2020-06-01']) {
      expect(matches(`v:(${value})`, { v: value }), value).toBe(true);
    }

    // A backslash is still an escape inside a group, as everywhere else, so a
    // Windows path needs one doubled — that is escaping, not the colon rule.
    expect(
      matches(String.raw`v:(C:\\Users)`, { v: String.raw`C:\Users` }),
    ).toBe(true);
  });

  it('lets quoting make a field-shaped value into a value', () => {
    expect(() => parse('d:("14:30")')).not.toThrow();
    expect(() => parse('d:("http://example.com")')).not.toThrow();
  });
});

describe('field paths', () => {
  it('folds a LEADING quoted segment into the path', () => {
    // types.ts documents this spelling and it did not work: the scan stopped at
    // the closing quote, so it became two clauses joined by an implicit AND,
    // which matched nothing and reported nothing wrong. A quoted segment AFTER
    // a dot always worked, so only the leading one was unreachable.
    const ast = parse("'full name'.first:x") as unknown as {
      field: { segments: { name: string }[] };
    };

    expect(ast.field.segments.map((segment) => segment.name)).toEqual([
      'full name',
      'first',
    ]);

    expect(
      matches("'full name'.first:x", { 'full name': { first: 'x' } }),
    ).toBe(true);
  });

  it('keeps a dot inside a quoted segment out of the path', () => {
    // `a.'b\.c':x` produced ["a", "b\\", "c"] — three segments, one of them a
    // literal backslash — because the segment's dots were escaped over the top
    // of escapes that had not been decoded yet.
    const path = (query: string): string[] =>
      (
        parse(query) as unknown as { field: { segments: { name: string }[] } }
      ).field.segments.map((segment) => segment.name);

    expect(path("a.'b.c':x")).toEqual(['a', 'b.c']);
    expect(path(String.raw`a.'b\.c':x`)).toEqual(['a', 'b.c']);
    expect(path(String.raw`a.'b\*c':x`)).toEqual(['a', 'b*c']);
  });
});

describe('reserved modifiers', () => {
  it('reports the documented code, not a generic syntax error', () => {
    // types.ts and errors.ts both name UNSUPPORTED_SYNTAX for ^boost and
    // ~fuzzy, and only +required delivered it — the other two reached the
    // bare-term reader and came back as "unexpected character", so a consumer
    // branching on the code got it right for one of three documented forms.
    for (const query of ['foo^2', 'foo~2', '"a b"~5', '+foo']) {
      try {
        parse(query);
        expect.fail(`${query} should not parse`);
      } catch (error) {
        expect((error as { code: string }).code, query).toBe(
          'UNSUPPORTED_SYNTAX',
        );
      }
    }
  });

  it('does not silently drop the modifier argument', () => {
    // `foo^2` must not become `foo AND 2`.
    expect(() => parse('foo^2')).toThrow(SiftQLSyntaxError);
  });
});

describe('tolerant mode survives a half-typed query', () => {
  // Each of these is one keystroke away from something valid, and each used to
  // throw in the mode whose documented promise is that the result is always
  // usable.
  const keystrokes = [
    '~',
    '^',
    'foo~',
    'foo^2',
    'a:^',
    'a:)',
    '(a:)',
    'a:foo)',
    '(a:b))',
    'a:[1 TO 2]]',
  ];

  for (const query of keystrokes) {
    it(`recovers from ${JSON.stringify(query)}`, () => {
      expect(() => parse(query, { tolerant: true })).not.toThrow();
    });
  }

  it('marks a dropped modifier so onRecovered can see it', () => {
    const strict = createEngine({ onRecovered: 'throw', tolerant: true });

    expect(() => strict.test('foo^2', {})).toThrow();
  });

  it('marks ignored trailing input', () => {
    const strict = createEngine({ onRecovered: 'throw', tolerant: true });

    expect(() => strict.test('a:foo)', {})).toThrow();
  });

  it('marks a quote invented inside a field path', () => {
    // `name.'first:ada` silently became a full-text scan for the literal
    // `name.first:ada`: the recovery flag was dropped while folding the
    // segment, so onRecovered could not see that anything had been invented.
    const ast = parse("name.'first:ada", { tolerant: true });

    expect(ast.recovered).toMatchObject({ reason: 'unterminated-quote' });
    expect(() =>
      createEngine({ onRecovered: 'throw', tolerant: true }).test(
        "name.'first:ada",
        {},
      ),
    ).toThrow();
  });
});

describe('source locations stay inside the source', () => {
  it('does not run past the end on a trailing lone backslash', () => {
    // `/a\` reported a span of four over a three-character source, so a caret
    // excerpt printed four markers and any consumer slicing the source got a
    // range that did not exist.
    const query = '/a\\';
    const ast = parse(query, { tolerant: true });

    expect(ast.location.end).toBeLessThanOrEqual(query.length);
  });
});

describe('nesting limits match the exported constants', () => {
  it(`accepts exactly MAX_DEPTH (${String(MAX_DEPTH)}) levels`, () => {
    // The counter included the query root, so 200 accepted only 199 while the
    // message said "more than 200" — and the constant is exported, so the
    // discrepancy was part of the published contract.
    const nest = (levels: number): string =>
      `${'('.repeat(levels)}a${')'.repeat(levels)}`;

    expect(() => parse(nest(MAX_DEPTH))).not.toThrow();
    expect(() => parse(nest(MAX_DEPTH + 1))).toThrow(SiftQLSyntaxError);
    expect(() => parse(`f:${nest(MAX_DEPTH)}`)).not.toThrow();
  });

  it(`accepts exactly MAX_CLAUSES (${String(MAX_CLAUSES)}) clauses`, () => {
    expect(() => parse(repeat('a', MAX_CLAUSES))).not.toThrow();
    expect(() => parse(repeat('a', MAX_CLAUSES + 1))).toThrow(
      SiftQLSyntaxError,
    );
  });

  it('never emits a tree the rest of the package refuses', () => {
    // The whole point of deriving MAX_AST_DEPTH from the parser's own caps.
    const maximal = `${'('.repeat(MAX_DEPTH - 1)}${Array.from(
      { length: 1800 },
      () => 'a',
    ).join(' OR ')}${')'.repeat(MAX_DEPTH - 1)}`;

    expect(() => serialize(parse(maximal))).not.toThrow();
    expect(() => matches(maximal, {})).not.toThrow();
  });
});
