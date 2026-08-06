import { describe, expect, it } from 'vitest';

import {
  claimed,
  createEngine,
  DECLINED,
  defineValueType,
  filter,
  highlight,
  isSiftQLError,
  MISS,
  parse,
  resolved,
  resolveTemporal,
  serialize,
  SiftQLConfigError,
  SiftQLRecoveredQueryError,
  SiftQLSyntaxError,
  SiftQLValueError,
  test as matches,
  type SiftQLAst,
} from '../src/index.js';

/**
 * One test per defect found by the pre-publish audit.
 *
 * Every one of these passed the 444-test suite and 95% coverage while being
 * wrong, so each is pinned by the exact input that exposed it. The pattern
 * across almost all of them is the same: a silently wrong answer, not a crash
 * — which is precisely the failure this package exists to prevent.
 */

const stripLocations = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripLocations);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'location')
        .map(([key, nested]) => [key, stripLocations(nested)]),
    );
  }

  return value;
};

const roundTrips = (query: string): void => {
  const once = parse(query);

  expect(stripLocations(parse(serialize(once))), query).toEqual(
    stripLocations(once),
  );
};

describe('field groups carry the whole clause', () => {
  const names = [{ name: 'Ada' }, { name: 'ada' }, { name: 'ADA' }];

  it('applies `::` inside a group, since a group is ONE clause', () => {
    expect(filter('name::(Ada)', names)).toEqual([{ name: 'Ada' }]);
    expect(filter('name::Ada', names)).toEqual(filter('name::(Ada)', names));
  });

  it('applies it to every term in the group', () => {
    expect(filter('name::(Ada OR ADA)', names)).toEqual([
      { name: 'Ada' },
      { name: 'ADA' },
    ]);
    expect(filter('name::(*d*)', names)).toEqual([
      { name: 'Ada' },
      { name: 'ada' },
    ]);
  });

  it('still defaults to case-insensitive without the doubled colon', () => {
    expect(filter('name:(Ada)', names)).toHaveLength(3);
  });

  it('evaluates a RANGE inside a group', () => {
    // A range has no operand token, so a token-driven compile yields constant false --
    // silently dropping its rows, and matching everything under NOT.
    const nums = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];

    expect(filter('n:([2 TO 3])', nums)).toEqual([{ n: 2 }, { n: 3 }]);
    expect(filter('n:(1 OR [2 TO 3])', nums)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
    expect(filter('n:(NOT [2 TO 3])', nums)).toEqual([{ n: 1 }, { n: 4 }]);
  });
});

describe('tolerant mode prunes its holes', () => {
  const engine = createEngine({ tolerant: true });
  const rows = [{ name: 'ada' }, { name: 'bob' }];

  it('drops a trailing operator instead of matching nothing', () => {
    // The exact keystroke sequence tolerant mode exists for: the result list
    // must not blank out the moment a space is typed after AND.
    expect(engine.filter('name:ada AND ', rows)).toEqual([{ name: 'ada' }]);
    expect(engine.filter('name:ada OR ', rows)).toEqual([{ name: 'ada' }]);
  });

  it('drops a field whose value is still being typed', () => {
    // `name:` constrains nothing, so it prunes to the empty query.
    expect(engine.filter('name:', rows)).toEqual(rows);
  });

  it('handles a hole inside an unclosed group', () => {
    expect(engine.filter('(name:ada AND ', rows)).toEqual([{ name: 'ada' }]);
  });

  it('leaves a complete query untouched', () => {
    expect(engine.filter('name:ada AND name:bob', rows)).toEqual([]);
    expect(engine.filter('name:ada', rows)).toEqual([{ name: 'ada' }]);
  });

  it('refuses the query under onRecovered: "throw"', () => {
    const strict = createEngine({ onRecovered: 'throw', tolerant: true });

    expect(() => strict.filter('name:ada AND ', rows)).toThrow(
      SiftQLRecoveredQueryError,
    );
    // A complete query is unaffected by the policy.
    expect(strict.filter('name:ada', rows)).toEqual([{ name: 'ada' }]);
  });
});

describe('reading values out of hostile data', () => {
  it('indexes an array with a numeric path segment', () => {
    const rows = [
      { id: 1, tags: ['red', 'blue'] },
      { id: 2, tags: ['blue', 'red'] },
    ];

    expect(filter('tags.0:red', rows).map((row) => row.id)).toEqual([1]);
    expect(filter('tags.1:red', rows).map((row) => row.id)).toEqual([2]);
    expect(filter('tags.9:red', rows)).toEqual([]);
    // Flattening still works without an index.
    expect(filter('tags:red', rows)).toHaveLength(2);
  });

  it('reads own properties only, never the prototype chain', () => {
    // `key in holder` made every object appear to carry constructor/toString,
    // so `constructor:null` reported the wrong rows.
    expect(filter('constructor:null', [{ a: 1 }])).toHaveLength(1);
    expect(filter('toString:null', [{ a: 1 }])).toHaveLength(1);

    class Row {
      public constructor(public name: string) {}
      public greet(): string {
        return 'hi';
      }
    }

    expect(filter('greet:null', [new Row('x')])).toHaveLength(1);
    expect(filter('name:x', [new Row('x')])).toHaveLength(1);
  });

  it('survives a sparse array at any depth', () => {
    const sparse: unknown[] = [];

    sparse[2] = { v: 'here' };

    expect(filter('items.v:here', [{ items: sparse }])).toHaveLength(1);
    // eslint-disable-next-line no-sparse-arrays
    expect(filter('items:*', [{ items: ['a', , 'c'] }])).toHaveLength(1);
  });

  it('survives a circular reference instead of blowing the stack', () => {
    // A parent pointer or a graph node is ordinary application data, and one
    // cyclic row must not abort the entire filter.
    const cyclic: Record<string, unknown> = { name: 'ada' };

    cyclic.self = cyclic;

    expect(filter('ada', [cyclic])).toHaveLength(1);
    expect(filter('name:ada', [cyclic])).toHaveLength(1);

    const left: Record<string, unknown> = { n: 1 };
    const right: Record<string, unknown> = { n: 2 };

    left.peer = right;
    right.peer = left;

    expect(filter('1', [left])).toHaveLength(1);
  });
});

describe('serialize round-trips everything the parser accepts', () => {
  it('escapes structural characters in VALUE position', () => {
    // Leaving these bare turned a match clause into a relational one, or into
    // something that no longer parsed at all.
    for (const query of [
      String.raw`v:\:X`,
      String.raw`v:\=X`,
      String.raw`v:\<X`,
      String.raw`v:\>X`,
      String.raw`v:\[X`,
      String.raw`v:\{X`,
      String.raw`v:\/X`,
    ]) {
      roundTrips(query);
    }
  });

  it('escapes a literal whose text is a typed keyword', () => {
    // Otherwise the text "true" comes back as the boolean.
    for (const query of [
      String.raw`v:\true`,
      String.raw`v:\false`,
      String.raw`v:\null`,
      String.raw`\true`,
    ]) {
      roundTrips(query);
    }

    const node = parse(String.raw`v:\true`);

    expect(
      node.type === 'Tag' &&
        node.expression.type === 'LiteralExpression' &&
        node.expression.literal,
    ).toBe('text');
  });

  it('escapes a literal whose text is a grammar keyword', () => {
    // `a \AND b` is three terms; emitting AND bare restructures the query.
    for (const query of [
      String.raw`a \AND b`,
      String.raw`\OR`,
      String.raw`v:\NOT`,
      String.raw`v:[\TO TO z]`,
    ]) {
      roundTrips(query);
    }
  });

  it('prints any query the parser accepts', () => {
    // parse() builds the left spine with a loop; serialize() recursed, so a
    // query the parser had just accepted could not be printed. Both stages now
    // agree, and the agreement is enforced by a clause limit rather than by
    // hoping the stack holds.
    const query = Array.from({ length: 1500 }, (_, i) => `a${String(i)}`).join(
      ' AND ',
    );

    expect(() => serialize(parse(query))).not.toThrow();
    expect(() => filter(query, [{ a0: 'x' }])).not.toThrow();
  });

  it('refuses an oversized query at PARSE time, not with a stack overflow', () => {
    // Every stage must agree on what is representable. Parse accepting morek
    // 50,000 terms, serialize died at 5,000 on unary chains, filter died at
    // 10,000 — and the failure was a raw RangeError escaping the error
    // contract. Now it is a located SiftQLSyntaxError from the first stage.
    const wide = Array.from({ length: 5000 }, (_, i) => `a${String(i)}`).join(
      ' AND ',
    );
    const deep = 'NOT '.repeat(5000) + 'a';

    for (const query of [wide, deep]) {
      expect(() => parse(query)).toThrow(SiftQLSyntaxError);
    }
  });

  it('still leaves colons alone in value position', () => {
    expect(serialize(parse('d:>=2020-06-01T12:00:00+02:00'))).toBe(
      'd:>=2020-06-01T12:00:00+02:00',
    );
  });
});

describe('ranges and unbounded ends', () => {
  const rows = [
    { created: '2020-06-01', id: 'realDate' },
    { created: 'n/a', id: 'garbage' },
    { id: 'noField', other: 1 },
  ];

  it('does not treat [* TO *] as "match everything"', () => {
    // A record with no such field at all cannot be inside a range over it.
    expect(filter('created:[* TO *]', rows).map((row) => row.id)).toEqual([
      'realDate',
      'garbage',
    ]);
    expect(matches('height:[* TO *]', { name: 'ada' })).toBe(false);
  });

  it('agrees with its half-open sibling about the missing field', () => {
    expect(filter('created:[* TO 9999-12-31]', rows).map((r) => r.id)).toEqual([
      'realDate',
    ]);
  });
});

describe('numbers', () => {
  it('does not collapse integers a double cannot hold', () => {
    // Two visibly different snowflake ids must not compare equal.
    const messages = [
      { body: 'first', id: '1234567890123456789' },
      { body: 'second', id: '1234567890123456780' },
    ];

    expect(filter('id:1234567890123456789', messages)).toEqual([
      { body: 'first', id: '1234567890123456789' },
    ]);
    expect(filter('id:1234567890123456780', messages)).toEqual([
      { body: 'second', id: '1234567890123456780' },
    ]);
  });

  it('still treats ordinary numbers numerically', () => {
    expect(filter('h:>100', [{ h: 50 }, { h: 150 }])).toEqual([{ h: 150 }]);
    expect(filter('h:100', [{ h: '100' }])).toHaveLength(1);
    expect(
      filter('h:9007199254740991', [{ h: 9_007_199_254_740_991 }]),
    ).toHaveLength(1);
  });
});

describe('dates', () => {
  it('applies a declared layout to BOTH sides of the comparison', () => {
    // The operand went through dateFormat while a numeric field value went
    // through epoch-ms, putting the two sides fifty years apart.
    const engine = createEngine({ dateFormat: 'YYYYMMDD' });
    const rows = [
      { day: '20200601', id: 'str' },
      { day: 20_200_601, id: 'num' },
    ];

    expect(engine.filter('day:20200601', rows).map((row) => row.id)).toEqual([
      'str',
      'num',
    ]);
  });

  it('leaves a genuine epoch-millisecond value alone', () => {
    const resolved_ = resolveTemporal(1_593_000_000_000, {
      dateFormat: 'YYYYMMDD',
    });

    expect(new Date(resolved_?.value ?? 0).getUTCFullYear()).toBe(2020);
  });

  it('refuses a fraction attached to the minutes', () => {
    // ISO 8601 attaches a fraction to the lowest component PRESENT, so
    // `12:30.5` is 12:30:30 -- reading it as milliseconds is a 29.5s error.
    expect(resolveTemporal('2020-06-01T12:30.5Z')).toBeNull();
    expect(resolveTemporal('12:30.5')).toBeNull();
    // Fractional SECONDS are unaffected.
    expect(resolveTemporal('2020-06-01T12:30:15.5Z')).not.toBeNull();
  });
});

describe('highlight', () => {
  it('gives every entry its own spans, with no shared state to advance', () => {
    /*
     * This began as a `g`-flag bug: the type compiled ONE highlighter and handed
     * back the same object, so a caller iterating the results got alternating
     * answers from shared `lastIndex`. Spans cannot have that failure — they
     * carry no cursor — but they must still not be a shared array, or a consumer
     * mutating one entry would corrupt every later hit from the same operand.
     */
    const entries = highlight('a:*foo* AND b:*foo*', {
      a: 'foofoo',
      b: 'foofoo',
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.query === undefined)).toBe(true);
    expect(entries[0]?.ranges).toEqual([
      { end: 3, start: 0 },
      { end: 6, start: 3 },
    ]);
    expect(entries[0]?.ranges).toEqual(entries[1]?.ranges);
    expect(entries[0]?.ranges).not.toBe(entries[1]?.ranges);
  });

  it('reports a matchKeys hit without a pattern that cannot match the value', () => {
    const [entry] = highlight(
      'email',
      { nested: { email: 'x' } },
      {
        matchKeys: true,
      },
    );

    expect(entry?.path).toBe('nested.email');
    // The KEY matched, not the contents, so there is nothing in the value to
    // underline and no pattern is offered.
    expect(entry?.query).toBeUndefined();
  });
});

describe('policies are order-independent and consistent', () => {
  const strict = { onValueError: 'throw' } as const;

  it('does not let array order decide whether a value error fires', () => {
    const clean = { tags: ['2020-01-01', 'n/a'] };
    const reversed = { tags: ['n/a', '2020-01-01'] };

    expect(() => filter('tags:2020-01-01', [clean], strict)).toThrow(
      SiftQLValueError,
    );
    expect(() => filter('tags:2020-01-01', [reversed], strict)).toThrow(
      SiftQLValueError,
    );
  });

  it('makes filter, test and highlight agree', () => {
    const item = { tags: ['2020-01-01', 'n/a'] };

    expect(() => filter('tags:2020-01-01', [item], strict)).toThrow();
    expect(() => matches('tags:2020-01-01', item, strict)).toThrow();
    expect(() => highlight('tags:2020-01-01', item, strict)).toThrow();
  });

  it('tells a value type when a candidate is a KEY', () => {
    const seen: { isKey: boolean; value: unknown }[] = [];
    const probe = defineValueType<string, string>({
      coerceValue: (value, ctx) => {
        seen.push({ isKey: ctx.isKey, value });

        return typeof value === 'string' ? resolved(value) : MISS;
      },
      equals: () => false,
      name: 'probe',
      parseOperand: (operand) =>
        operand.kind === 'text' && operand.text === 'PROBE'
          ? claimed('PROBE')
          : DECLINED,
    });

    createEngine({ matchKeys: true, types: [probe] }).filter('PROBE', [
      { colour: 'red' },
    ]);

    expect(seen).toEqual([
      { isKey: true, value: 'colour' },
      { isKey: false, value: 'red' },
    ]);
  });
});

describe('the registry', () => {
  const stub = defineValueType<string, string>({
    coerceValue: (value) =>
      typeof value === 'string' ? resolved(value) : MISS,
    equals: (value, operand) => value === operand,
    name: 'probe',
    parseOperand: (operand) =>
      operand.kind === 'text' ? claimed(operand.text) : DECLINED,
  });

  it('does not throw a TDZ error when a factory looks a peer up', () => {
    // Factories run BEFORE the new registry exists; the lookup must return
    // undefined per the contract, not escape a raw ReferenceError.
    expect(() =>
      createEngine().types.with([
        (env) => {
          env.lookup('number');

          return stub;
        },
      ]),
    ).not.toThrow();
  });

  it('does not call a user type built-in just because it shares a name', () => {
    const shadow = defineValueType<string, string>({ ...stub, name: 'number' });
    const engine = createEngine({
      types: [shadow],
      typeStrategy: 'replace',
    });

    expect(engine.types.describe()).toEqual([
      { builtin: false, name: 'number', ordered: false },
    ]);
  });
});

describe('regular expressions', () => {
  it('is unaffected by a global or sticky flag', () => {
    const identical = [{ v: 'aa' }, { v: 'aa' }, { v: 'aa' }, { v: 'aa' }];

    expect(filter('v:/a/g', identical)).toHaveLength(4);
    expect(filter('v:/a/y', identical)).toHaveLength(4);
  });

  it('runs a nested quantifier in linear time rather than hanging', () => {
    /*
     * This pinned a REFUSAL: the matcher was `RegExp`, so `((a+))+` took 104
     * seconds and the only defence was a screen that guessed. The matcher is now
     * an automaton, so the pattern is linear and refusing it would cost a
     * legitimate query for nothing.
     */
    const started = Date.now();

    expect(matches('v:/((a+))+$/', { v: `${'a'.repeat(40)}!` })).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('second audit', () => {
  it('parses a quoted segment in the middle of a path', () => {
    // `a.'b':c` stopped at the quote and silently became two clauses, so it
    // matched a record that merely contained the text.
    const node = parse("a.'b':c");

    expect(node.type).toBe('Tag');
    expect(
      node.type === 'Tag' && node.field.segments.map((s) => s.name),
    ).toEqual(['a', 'b']);
    expect(
      filter("a.'b':c", [{ a: { b: 'c' } }, { b: 'c', note: 'xa.x' }]),
    ).toEqual([{ a: { b: 'c' } }]);
  });

  it('keeps a dot INSIDE a quoted segment as one step', () => {
    const node = parse("a.'b.c':x");

    expect(
      node.type === 'Tag' && node.field.segments.map((s) => s.name),
    ).toEqual(['a', 'b.c']);
  });

  it('reads a negative number in a field group as a value, not a negation', () => {
    // `n:(-3)` was parsed as NOT 3, so it matched a row whose n was 7.
    expect(matches('n:(-3)', { n: 7 })).toBe(false);
    expect(matches('n:(-3)', { n: -3 })).toBe(true);
    expect(matches('n:(-3 OR -5)', { n: -5 })).toBe(true);
    // Only an ADJACENT sign folds, and only inside a group.
    expect(matches('n:(- 3)', { n: 7 })).toBe(true);
    expect(filter('-a:x', [{ a: 'x' }, { a: 'y' }])).toEqual([{ a: 'y' }]);
  });

  it('recovers an incomplete range in tolerant mode', () => {
    // The documented promise is that a tolerant parse ALWAYS returns a usable
    // AST; every incomplete range threw instead.
    for (const query of ['a:[', '[', 'a:[1', 'a:[1 TO']) {
      expect(() => parse(query, { tolerant: true }), query).not.toThrow();
    }

    expect(() => parse('a:[')).toThrow(SiftQLSyntaxError);
  });

  it('marks an unterminated quote or regex as recovered', () => {
    // Without the marker a half-typed `"` became a real clause matching every
    // row, and onRecovered could not see that anything had been invented.
    expect(parse('"', { tolerant: true }).recovered?.reason).toBe(
      'unterminated-quote',
    );
    expect(parse('/a', { tolerant: true }).recovered?.reason).toBe(
      'unterminated-regex',
    );
    expect(parse('"a"', { tolerant: true }).recovered).toBeUndefined();
  });

  it('prints the reserved v0.2 modifiers instead of dropping them', () => {
    const location = { end: 0, start: 0 };
    const term = (extra: object): SiftQLAst => ({
      literal: 'text',
      location,
      quoted: false,
      type: 'LiteralExpression',
      value: 'foo',
      ...extra,
    });

    expect(
      serialize(
        term({ boost: { factor: '2', location, type: 'BoostModifier' } }),
      ),
    ).toBe('foo^2');
    expect(
      serialize(
        term({ fuzzy: { distance: '2', location, type: 'FuzzyModifier' } }),
      ),
    ).toBe('foo~2');
    expect(
      serialize(term({ required: { location, type: 'RequiredModifier' } })),
    ).toBe('+foo');
  });
});

describe('a discarded stray is not reported as trailing input', () => {
  const reasons = (query: string): string[] => {
    const seen: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') {
        return;
      }

      if (Array.isArray(node)) {
        node.forEach(walk);

        return;
      }

      const info = (node as { recovered?: { reason?: string } }).recovered;

      if (info?.reason !== undefined) {
        seen.push(info.reason);
      }

      Object.values(node).forEach(walk);
    };

    walk(parse(query, { tolerant: true }));

    return seen;
  };

  it('calls a stray at index 0 a stray, not trailing input', () => {
    // The tokenizer reused the parser's `trailing-input` for any discarded
    // stray, so `:abc` — where the discarded `:` is the FIRST character and
    // nothing trails anything — told a consumer branching on the reason that
    // text after the end of the query had been ignored.
    expect(reasons(':abc')).toContain('stray-input');
    expect(reasons(':abc')).not.toContain('trailing-input');
  });

  it('still calls genuine trailing text trailing input', () => {
    expect(reasons('a AND b )')).toContain('trailing-input');
  });
});

describe('an option is read once, so validation and the engine agree', () => {
  it('keeps the value it validated, not a later one', () => {
    // `assertOptions` validated from one read and built its snapshot from a
    // second, so an accessor could answer twice: 'throw' to the validator and
    // 'garbage' to the engine. The failure policy the engine ran under was
    // then one no check had ever seen.
    let reads = 0;
    const twoFaced = {
      get onValueError(): string {
        reads += 1;

        return reads === 1 ? 'throw' : 'garbage';
      },
    };

    const engine = createEngine(twoFaced as never);

    expect(engine.options.onValueError).toBe('throw');
  });

  it('still refuses a value that was invalid on that one read', () => {
    expect(() => createEngine({ onValueError: 'garbage' } as never)).toThrow(
      /onValueError/,
    );
  });
});

describe('an options object that cannot be read is refused, not defaulted', () => {
  it('refuses a revoked Proxy instead of building a defaults engine', () => {
    // The single-read rewrite gated the read on a presence test, and that test
    // swallowed its own failure and answered "absent". An options object whose
    // reads throw then never reached the guard at all: a caller who asked for
    // onValueError: 'throw' silently got 'skip', which is the exact quiet
    // wrongness this validator exists to prevent.
    const revocable = Proxy.revocable(
      { onValueError: 'throw' as const, tolerant: true },
      {},
    );

    revocable.revoke();

    expect(() => createEngine(revocable.proxy)).toThrow(SiftQLConfigError);
  });

  it('reports an unreadable types array as a config error, not a raw one', () => {
    // The element reads were guarded; iterating the array to reach them was
    // not, so a raw Error escaped a package whose contract is that every error
    // it throws is a SiftQLError.
    const types = new Proxy([{ name: 'x' }], {
      get: (target: object, key: string | symbol): unknown => {
        if (key === '0') {
          throw new Error('reactive read failed');
        }

        return (target as Record<string | symbol, unknown>)[key];
      },
    });

    try {
      createEngine({ types } as never);
      expect.unreachable('createEngine should have refused');
    } catch (error) {
      expect(isSiftQLError(error)).toBe(true);
    }
  });

  it('keeps the dateFormat it validated, not a later read of it', () => {
    // The snapshot stored arrays by reference, so dateFormat was validated
    // once and read again downstream: a layout assertValidFormat would have
    // refused reached the engine and failed on the first record with a date.
    let reads = 0;
    const formats: string[] = [];

    Object.defineProperty(formats, '0', {
      enumerable: true,
      get(): string {
        reads += 1;

        return reads === 1 ? 'YYYY-MM-DD' : 'QQQQ';
      },
    });
    Object.defineProperty(formats, 'length', { value: 1 });

    const engine = createEngine({ dateFormat: formats });

    expect(() =>
      engine.filter('when:>=2020-01-01', [{ when: '2021-06-01' }]),
    ).not.toThrow();
  });
});

describe('extend() does not blank a parent option with an explicit undefined', () => {
  const parent = createEngine({ matchKeys: true, onValueError: 'throw' });

  it('inherits when a partial config omits the field', () => {
    // Spreading a partial config is ordinary JS and type-checks cleanly, so
    // `extend({ matchKeys: config.matchKeys })` with the field absent silently
    // reset the parent's setting — including dropping the failure policy.
    const config: { matchKeys?: boolean } = {};
    const child = parent.extend({ matchKeys: config.matchKeys });

    expect(child.options.matchKeys).toBe(true);
  });

  it('does not downgrade the failure policy', () => {
    expect(
      parent.extend({ onValueError: undefined }).options.onValueError,
    ).toBe('throw');
  });
});
