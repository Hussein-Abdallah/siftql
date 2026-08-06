import { describe, expect, it } from 'vitest';

import {
  builders,
  createEngine,
  parse,
  serialize,
  test as matches,
  type Field,
  type SiftQLAst,
} from '../src/index.js';

/**
 * THE AST CONTRACT (G5).
 *
 * `types.ts` is the published contract, and its prose is as load-bearing as its
 * types: a consumer writing a SQL backend, a UI, or a query builder reads those
 * statements and acts on them. Every defect fixed here was a documented claim
 * that the code did not honour, which is worse than an undocumented behaviour —
 * a reader following the file got a wrong answer and had no reason to doubt it.
 *
 * Each test therefore states the claim and checks it, rather than checking
 * whatever the code happens to do.
 */

const strip = (node: unknown): string =>
  JSON.stringify(node, (key, value: unknown) =>
    key === 'location' ? undefined : value,
  );

describe('I4: serialize normalises exactly four things', () => {
  // Quote style is one of them: the same
  // file then listed as normalised, 280 lines further down.
  it('normalises whitespace runs', () => {
    expect(serialize(parse('a    b'))).toBe('a b');
  });

  it('normalises quote style', () => {
    expect(serialize(parse("'foo bar'"))).toBe('"foo bar"');
    expect(serialize(parse("name:'*Active*'"))).toBe('name:"*Active*"');
  });

  it('normalises the bracket on an unbounded range end', () => {
    expect(serialize(parse('a:{* TO 9]'))).toBe('a:[* TO 9]');
  });

  it('leaves everything else exactly as the AST records it', () => {
    // If serialize normalised anything further, one of these would come back
    // spelled differently.
    for (const query of [
      'a AND b',
      'a b',
      'a OR b',
      'NOT a',
      '-a',
      '(a)',
      'name::Ada',
      'name:>=5',
      'a:[1 TO 9}',
      '/ab/i',
      'name:(a OR b)',
    ]) {
      expect(serialize(parse(query)), query).toBe(query);
    }
  });
});

describe('a wildcard pattern has exactly one representation', () => {
  it('collapses a run of stars', () => {
    // `a*b`, `a**b` and `a***b` produced three structurally different ASTs that
    // behaved identically, so two spellings of one pattern did not compare
    // equal — and compileWildcard had to collapse the runs again, later, to get
    // the right answer.
    const single = strip(parse('name:a*b'));

    expect(strip(parse('name:a**b'))).toBe(single);
    expect(strip(parse('name:a***b'))).toBe(single);
    expect(strip(parse('name:**a'))).toBe(strip(parse('name:*a')));
  });

  it('does not collapse `?`, which is not the same metacharacter', () => {
    // Each `?` consumes exactly one character, so `??` is not `?`.
    expect(strip(parse('name:a??b'))).not.toBe(strip(parse('name:a?b')));
    expect(matches('name:a??b', { name: 'axyb' })).toBe(true);
    expect(matches('name:a?b', { name: 'axyb' })).toBe(false);
  });

  it('still matches what it always did', () => {
    for (const value of ['ab', 'axb', 'axxb']) {
      expect(matches('name:a*b', { name: value }), value).toBe(
        matches('name:a**b', { name: value }),
      );
    }
  });
});

describe('the case/scope grid in types.ts §5', () => {
  /*
   * The published table put the QUOTED spellings in the case-sensitive column.
   * They are case-INsensitive: only the doubled colon affects case, as the same
   * file states 260 lines later. Anyone following the table got silently wrong
   * results.
   */
  const cases: readonly [string, string, string][] = [
    ['exactly', 'status:active', 'status::active'],
    ['contains', 'status:*active*', 'status::*active*'],
    ['starts', 'status:active*', 'status::active*'],
    ['ends', 'status:*active', 'status::*active'],
  ];

  for (const [label, insensitive, sensitive] of cases) {
    it(`${label}: only the doubled colon is case-sensitive`, () => {
      expect(matches(insensitive, { status: 'ACTIVE' })).toBe(true);
      expect(matches(insensitive, { status: 'active' })).toBe(true);
      expect(matches(sensitive, { status: 'ACTIVE' })).toBe(false);
      expect(matches(sensitive, { status: 'active' })).toBe(true);
    });
  }

  it('quoting does not affect case', () => {
    expect(matches("status:'active'", { status: 'ACTIVE' })).toBe(true);
    expect(matches('status:"active"', { status: 'ACTIVE' })).toBe(true);
  });

  it('a quoted pattern is still a pattern, which is why quoting cannot suppress metacharacters', () => {
    // The real justification for the rule: a pattern containing a SPACE has no
    // unquoted spelling at all.
    expect(
      matches('status:"in * progress"', { status: 'in slow progress' }),
    ).toBe(true);
    expect(matches('status:"in * progress"', { status: 'in progress' })).toBe(
      false,
    );
  });
});

describe('every Field the contract permits can be serialized and read back', () => {
  const segment = (name: string) => ({
    location: { end: 0, start: 0 },
    name,
    quoted: false,
    type: 'FieldSegment' as const,
  });

  const fieldOf = (...names: string[]): Field =>
    ({
      location: { end: 0, start: 0 },
      segments: names.map((name) => segment(name)),
      type: 'Field',
    }) as unknown as Field;

  it('quotes an empty segment name', () => {
    // Unquoted it printed nothing, so a Field whose only segment was empty
    // serialized to `:x` — not a query, and not re-parseable.
    const node = builders.tag(fieldOf(''), builders.term('x'));
    const text = serialize(node);

    expect(text).toBe('"":x');
    expect(() => parse(text)).not.toThrow();
  });

  it('keeps an empty middle segment addressable', () => {
    /*
     * The PATH is what must survive; the `quoted` flag legitimately does not.
     *
     * An empty segment has no unquoted spelling, so serialize must emit `""` —
     * and the text `a."".b:x` genuinely does contain a quoted segment, which the
     * tokenizer now reports faithfully. Asserting byte-identity here would be
     * asserting that the parser lies about what it read.
     *
     * The round-trip law is stated over queries the STRICT PARSER accepts, and
     * `a."".b:x` round-trips exactly; a hand-built tree claiming an unquoted
     * empty name is outside it.
     */
    const node = builders.tag(fieldOf('a', '', 'b'), builders.term('x'));
    const text = serialize(node);
    const names = (tree: SiftQLAst): string[] =>
      (
        tree as unknown as { field: { segments: { name: string }[] } }
      ).field.segments.map((segment) => segment.name);

    expect(names(parse(text))).toEqual(['a', '', 'b']);
    expect(serialize(parse(text))).toBe(text);
  });

  it('round-trips a path the parser itself produces with an empty step', () => {
    const once = serialize(parse('a..b:x'));

    expect(serialize(parse(once))).toBe(once);
  });
});

describe('a value type is not shown the failure policy', () => {
  /*
   * `errors.ts` and `registry.ts` both state that a ValueType never sees
   * `onValueError`. The whole split-policy design rests on it: a type that
   * branched on the policy would be deciding for itself whether a dirty value is
   * fatal, and matching would depend on a setting core cannot reason about.
   *
   * `options` was the entire ResolvedEngineOptions, so any type could read it.
   */
  const seen = (): Record<string, unknown> => {
    let captured: Record<string, unknown> = {};

    createEngine({
      onValueError: 'throw',
      types: [
        {
          coerceValue: (_value: unknown, ctx: { options: object }) => {
            captured = { ...ctx.options };

            return { kind: 'miss', ok: false };
          },
          equals: () => true,
          name: 'spy',
          parseOperand: (token: { value: unknown }) => ({
            ok: true,
            value: token.value,
          }),
        } as never,
      ],
    }).filter('f:1', [{ f: 1 }]);

    return captured;
  };

  it('withholds onValueError and onRecovered', () => {
    const options = seen();

    expect('onValueError' in options).toBe(false);
    expect('onRecovered' in options).toBe(false);
  });

  it('still provides everything a type legitimately needs', () => {
    const options = seen();

    for (const key of [
      'id',
      'matchKeys',
      'maxPatternLength',
      'regexGuard',
      'temporal',
      'tolerant',
    ]) {
      expect(key in options, key).toBe(true);
    }
  });
});

describe('the builders documented in types.ts exist and work', () => {
  it('produces nodes structurally identical to parse()', () => {
    const pairs: readonly [SiftQLAst, string][] = [
      [builders.term('ada'), 'ada'],
      [builders.quoted('in progress'), '"in progress"'],
      [builders.boolean(true), 'true'],
      [builders.null(), 'null'],
      [builders.wildcard('*ada*'), '*ada*'],
      [builders.regex('^a', ['i']), '/^a/i'],
      [builders.tag(builders.field('n'), builders.term('ada')), 'n:ada'],
      [builders.and(builders.term('a'), builders.term('b')), 'a AND b'],
      [builders.or(builders.term('a'), builders.term('b')), 'a OR b'],
      [builders.not(builders.term('a')), 'NOT a'],
      [builders.empty(), ''],
    ];

    for (const [built, query] of pairs) {
      expect(strip(built), query).toBe(strip(parse(query)));
    }
  });

  it('cannot be made to inject structure through a value', () => {
    // The reason builders exist rather than string concatenation: escaping
    // happens after the structure is fixed.
    const node = builders.tag(
      builders.field('name'),
      builders.term('a) OR (b'),
    );
    const text = serialize(node);

    expect(matches(text, { name: 'a) OR (b' })).toBe(true);
    expect(matches(text, { name: 'b' })).toBe(false);
    expect(matches(text, { name: 'a' })).toBe(false);
  });
});
